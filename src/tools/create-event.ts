import { Type } from "@sinclair/typebox";
import { fuzzy } from "fast-fuzzy";
import { DateTime } from "luxon";
import { assertPluginReady, getConfig } from "../config.js";
import { formatParsedEventTime } from "../datetime.js";
import { createEvent, describeEvent, listEvents } from "../google/calendar.js";
import type {
  CalendarEventLite,
  CreateBlockReason,
  CreateEventInput,
  CreateEventPreview,
  CreatePreviewTokenPayload,
  ParsedEvent
} from "../types.js";

export type CreateEventParams = {
  sourceText?: string;
  title?: string;
  location?: string;
  description?: string;
  allDay?: boolean;
  start?: string;
  end?: string;
  confidence?: number;
  issues?: string[];
  previewToken?: string;
  titleOverride?: string;
  locationOverride?: string;
  descriptionOverride?: string;
  allDayOverride?: boolean;
  startOverride?: string;
  endOverride?: string;
  dryRun?: boolean;
};

type ValidationResult = {
  parsedEvent?: ParsedEvent;
  missingFields: string[];
  blockReasons: CreateBlockReason[];
  confidenceReasons: string[];
};

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const RFC3339_WITH_OFFSET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function eventStartIso(event: CalendarEventLite): string | undefined {
  return event.start?.dateTime ?? event.start?.date;
}

function eventEndIso(event: CalendarEventLite): string | undefined {
  return event.end?.dateTime ?? event.end?.date;
}

function trimOptional(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeIssues(issues?: string[]): string[] {
  return (issues ?? []).map((item) => item.trim()).filter(Boolean);
}

function buildDescription(event: CreateEventInput): string {
  const sourceText = event.sourceText.trim();
  const explicit = trimOptional(event.description);
  if (explicit) {
    return `${explicit}\n\n---- 原始通知 ----\n${sourceText}`;
  }
  return `原始通知：\n${sourceText}`;
}

export function applyEventOverrides(
  event: CreateEventInput,
  params: CreateEventParams
): CreateEventInput {
  return {
    ...event,
    title: trimOptional(params.titleOverride) ?? trimOptional(event.title),
    location: trimOptional(params.locationOverride) ?? trimOptional(event.location),
    description: trimOptional(params.descriptionOverride) ?? trimOptional(event.description),
    allDay: typeof params.allDayOverride === "boolean" ? params.allDayOverride : event.allDay,
    start: trimOptional(params.startOverride) ?? trimOptional(event.start),
    end: trimOptional(params.endOverride) ?? trimOptional(event.end),
    issues: normalizeIssues(event.issues)
  };
}

function eventFromParams(params: CreateEventParams): CreateEventInput {
  const sourceText = trimOptional(params.sourceText);
  if (!sourceText) {
    throw new Error("缺少 sourceText，无法创建日程预览。");
  }

  return {
    sourceText,
    title: trimOptional(params.title),
    location: trimOptional(params.location),
    description: trimOptional(params.description),
    allDay: typeof params.allDay === "boolean" ? params.allDay : undefined,
    start: trimOptional(params.start),
    end: trimOptional(params.end),
    confidence: typeof params.confidence === "number" ? params.confidence : undefined,
    issues: normalizeIssues(params.issues)
  };
}

function encodePreviewToken(event: CreateEventInput): string {
  const payload: CreatePreviewTokenPayload = {
    version: 3,
    event
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePreviewToken(token: string): CreateEventInput {
  const raw = Buffer.from(token, "base64url").toString("utf8");
  const payload = JSON.parse(raw) as Partial<CreatePreviewTokenPayload>;
  if (payload.version !== 3 || !payload.event || typeof payload.event.sourceText !== "string") {
    throw new Error("previewToken 无效或已过期，请重新执行一次创建预览。");
  }

  return {
    sourceText: payload.event.sourceText.trim(),
    title: trimOptional(payload.event.title),
    location: trimOptional(payload.event.location),
    description: trimOptional(payload.event.description),
    allDay: typeof payload.event.allDay === "boolean" ? payload.event.allDay : undefined,
    start: trimOptional(payload.event.start),
    end: trimOptional(payload.event.end),
    confidence: typeof payload.event.confidence === "number" ? payload.event.confidence : undefined,
    issues: normalizeIssues(payload.event.issues)
  };
}

function parseAllDayDate(value: string): DateTime | undefined {
  if (!DATE_ONLY_PATTERN.test(value)) return undefined;
  const parsed = DateTime.fromISO(value, { zone: "UTC" });
  return parsed.isValid ? parsed : undefined;
}

function parseTimedDateTime(value: string): DateTime | undefined {
  if (!RFC3339_WITH_OFFSET_PATTERN.test(value)) return undefined;
  const parsed = DateTime.fromISO(value, { setZone: true });
  return parsed.isValid ? parsed : undefined;
}

function validateStructuredEvent(event: CreateEventInput): ValidationResult {
  const missingFields: string[] = [];
  const blockReasons: CreateBlockReason[] = [];
  const confidenceReasons: string[] = [];

  const title = trimOptional(event.title);
  const location = trimOptional(event.location);
  const description = trimOptional(event.description);
  const start = trimOptional(event.start);
  const end = trimOptional(event.end);

  if (!title) {
    missingFields.push("title");
    blockReasons.push("missing_title");
    confidenceReasons.push("标题待确认");
  } else {
    confidenceReasons.push("标题已提供");
  }

  if (typeof event.allDay !== "boolean") {
    missingFields.push("allDay");
    blockReasons.push("missing_all_day");
    confidenceReasons.push("缺少全天标记");
  }

  if (!start) {
    missingFields.push("start");
    blockReasons.push("missing_start");
    confidenceReasons.push("开始时间待确认");
  }

  if (!end) {
    missingFields.push("end");
    blockReasons.push("missing_end");
    confidenceReasons.push("结束时间待确认");
  }

  let parsedEvent: ParsedEvent | undefined;
  if (title && typeof event.allDay === "boolean" && start && end) {
    if (event.allDay) {
      const startDate = parseAllDayDate(start);
      const endDate = parseAllDayDate(end);
      if (!startDate || !endDate) {
        blockReasons.push("invalid_time_format");
        confidenceReasons.push("全天事件需使用 YYYY-MM-DD");
      } else if (endDate <= startDate) {
        blockReasons.push("invalid_time_range");
        confidenceReasons.push("全天事件结束日期必须晚于开始日期");
      } else {
        parsedEvent = {
          title,
          start,
          end,
          allDay: true,
          location,
          description: buildDescription({ ...event, title, location, description, start, end, allDay: true }),
          sourceText: event.sourceText,
          confidence: event.confidence ?? 0
        };
        confidenceReasons.push("开始和结束时间都已通过结构化校验");
      }
    } else {
      const startDateTime = parseTimedDateTime(start);
      const endDateTime = parseTimedDateTime(end);
      if (!startDateTime || !endDateTime) {
        blockReasons.push("invalid_time_format");
        confidenceReasons.push("定时事件需使用带时区偏移的 RFC3339");
      } else if (endDateTime <= startDateTime) {
        blockReasons.push("invalid_time_range");
        confidenceReasons.push("结束时间必须晚于开始时间");
      } else {
        parsedEvent = {
          title,
          start: startDateTime.set({ millisecond: 0 }).toISO({ suppressMilliseconds: true, includeOffset: true })!,
          end: endDateTime.set({ millisecond: 0 }).toISO({ suppressMilliseconds: true, includeOffset: true })!,
          allDay: false,
          location,
          description: buildDescription({ ...event, title, location, description, start, end, allDay: false }),
          sourceText: event.sourceText,
          confidence: event.confidence ?? 0
        };
        confidenceReasons.push("开始和结束时间都已通过结构化校验");
      }
    }
  }

  return {
    parsedEvent,
    missingFields,
    blockReasons: Array.from(new Set(blockReasons)),
    confidenceReasons
  };
}

function buildClarificationPrompt(blockReasons: CreateBlockReason[], issues: string[]): string | undefined {
  if (blockReasons.includes("missing_title")) {
    return "请直接给出最终标题。";
  }
  if (blockReasons.includes("missing_all_day")) {
    return "请明确这是全天日程还是带具体时间的日程。";
  }
  if (blockReasons.includes("missing_start") || blockReasons.includes("missing_end")) {
    return "请直接给出最终 start 和 end。";
  }
  if (blockReasons.includes("invalid_time_format")) {
    return "请提供合法时间：定时事件用带时区偏移的 RFC3339，全天事件用 YYYY-MM-DD。";
  }
  if (blockReasons.includes("invalid_time_range")) {
    return "请确认 start 和 end，结束时间必须晚于开始时间。";
  }
  if (blockReasons.includes("reported_issues") && issues.length) {
    return `请先确认这些问题：${issues.join("；")}`;
  }
  if (blockReasons.includes("missing_confidence") || blockReasons.includes("low_confidence")) {
    return "请先确认最终标题、开始时间、结束时间和地点后再创建。";
  }
  return undefined;
}

export function buildEventDayWindow(parsedEvent: ParsedEvent, timezone: string) {
  if (parsedEvent.allDay) {
    const start = DateTime.fromISO(parsedEvent.start, { zone: timezone }).startOf("day");
    const endExclusive = DateTime.fromISO(parsedEvent.end, { zone: timezone }).startOf("day");
    return {
      start: start.toISO({ suppressMilliseconds: true, includeOffset: true })!,
      end: endExclusive.minus({ days: 1 }).endOf("day").toISO({ suppressMilliseconds: true, includeOffset: true })!
    };
  }

  const start = DateTime.fromISO(parsedEvent.start, { setZone: true }).setZone(timezone).startOf("day");
  return {
    start: start.toISO({ suppressMilliseconds: true, includeOffset: true })!,
    end: start.endOf("day").toISO({ suppressMilliseconds: true, includeOffset: true })!
  };
}

function detectDedupeMatches(
  parsedEvent: ParsedEvent,
  items: CalendarEventLite[],
  timezone: string,
  dedupeWindowMinutes: number
) {
  const targetTitle = parsedEvent.title.trim().toLowerCase();
  const targetStart = parsedEvent.allDay
    ? null
    : DateTime.fromISO(parsedEvent.start, { setZone: true }).setZone(timezone);

  return items.filter((event) => {
    const title = (event.summary ?? "").trim().toLowerCase();
    if (!title) return false;
    const similarity = fuzzy(targetTitle, title);
    if (similarity < 0.88) return false;

    const startRaw = eventStartIso(event);
    if (!startRaw) return false;
    if (parsedEvent.allDay) {
      return startRaw.slice(0, 10) === parsedEvent.start.slice(0, 10);
    }

    const otherStart = DateTime.fromISO(startRaw, { setZone: true }).setZone(timezone);
    return targetStart != null
      && Math.abs(otherStart.diff(targetStart, "minutes").minutes) <= dedupeWindowMinutes;
  });
}

function detectConflicts(parsedEvent: ParsedEvent, items: CalendarEventLite[], timezone: string) {
  if (parsedEvent.allDay) return [];

  const targetStart = DateTime.fromISO(parsedEvent.start, { setZone: true }).setZone(timezone);
  const targetEnd = DateTime.fromISO(parsedEvent.end, { setZone: true }).setZone(timezone);

  return items.filter((event) => {
    const startRaw = eventStartIso(event);
    const endRaw = eventEndIso(event);
    if (!startRaw || !endRaw) return false;
    if (!event.start?.dateTime || !event.end?.dateTime) return false;

    const start = DateTime.fromISO(startRaw, { setZone: true }).setZone(timezone);
    const end = DateTime.fromISO(endRaw, { setZone: true }).setZone(timezone);
    return start < targetEnd && end > targetStart;
  });
}

export function buildCreatePreview(
  input: CreateEventInput,
  timezone: string,
  mode: "fresh" | "confirmed" = "fresh"
): CreateEventPreview {
  const normalized: CreateEventInput = {
    sourceText: input.sourceText.trim(),
    title: trimOptional(input.title),
    location: trimOptional(input.location),
    description: trimOptional(input.description),
    allDay: typeof input.allDay === "boolean" ? input.allDay : undefined,
    start: trimOptional(input.start),
    end: trimOptional(input.end),
    confidence: typeof input.confidence === "number" ? input.confidence : undefined,
    issues: normalizeIssues(input.issues)
  };

  const validation = validateStructuredEvent(normalized);
  const issues = normalizeIssues(normalized.issues);
  const blockReasons = [...validation.blockReasons];
  const confidenceReasons = [...validation.confidenceReasons];

  if (mode === "fresh") {
    if (normalized.confidence == null) {
      blockReasons.push("missing_confidence");
      confidenceReasons.push("缺少 LLM 置信度，默认不自动创建");
    } else if (normalized.confidence < 0.85) {
      blockReasons.push("low_confidence");
      confidenceReasons.push(`LLM 置信度较低 (${normalized.confidence.toFixed(2)})`);
    } else {
      confidenceReasons.push(`LLM 置信度 ${normalized.confidence.toFixed(2)}`);
    }

    if (issues.length) {
      blockReasons.push("reported_issues");
      confidenceReasons.push(`LLM 标记待确认：${issues.join("；")}`);
    }
  } else {
    confidenceReasons.push("已使用已确认的预览结果");
    if (issues.length) {
      confidenceReasons.push(`已带入待确认问题：${issues.join("；")}`);
    }
  }

  const dedupedBlockReasons = Array.from(new Set(blockReasons));
  return {
    event: normalized,
    parsedEvent: validation.parsedEvent,
    missingFields: validation.missingFields,
    blockReasons: dedupedBlockReasons,
    shouldAutoCreate: Boolean(validation.parsedEvent) && dedupedBlockReasons.length === 0,
    normalizedTimeText: validation.parsedEvent ? formatParsedEventTime(validation.parsedEvent, timezone) : undefined,
    clarificationPrompt: buildClarificationPrompt(dedupedBlockReasons, issues),
    confidenceReasons
  };
}

function resolveCreatePreview(params: CreateEventParams, timezone: string): CreateEventPreview {
  if (params.previewToken) {
    return buildCreatePreview(
      applyEventOverrides(decodePreviewToken(params.previewToken), params),
      timezone,
      "confirmed"
    );
  }

  return buildCreatePreview(applyEventOverrides(eventFromParams(params), params), timezone, "fresh");
}

function buildPreviewText(
  preview: CreateEventPreview,
  timezone: string,
  dedupeMatches: CalendarEventLite[],
  conflicts: CalendarEventLite[]
) {
  const lines = [
    `标题：${preview.event.title ?? "(待确认)"}`,
    `时间：${preview.normalizedTimeText ?? "(待确认)"}`,
    `地点：${preview.event.location ?? "(未识别)"}`,
    `自动创建：${preview.shouldAutoCreate ? "是" : "否"}`
  ];

  if (preview.confidenceReasons.length) {
    lines.push(`原因：${preview.confidenceReasons.join("；")}`);
  }
  if (preview.blockReasons.length) {
    lines.push(`阻塞：${preview.blockReasons.join("、")}`);
  }
  if (dedupeMatches.length) {
    lines.push("疑似重复：");
    lines.push(...dedupeMatches.map((event, index) => `${index + 1}. ${describeEvent(event, timezone)}`));
  }
  if (conflicts.length) {
    lines.push("时间冲突：");
    lines.push(...conflicts.map((event, index) => `${index + 1}. ${describeEvent(event, timezone)}`));
  }
  if (preview.clarificationPrompt) {
    lines.push(`追问：${preview.clarificationPrompt}`);
  }

  return lines.join("\n");
}

/**
 * 工具：calendar_intake_create_event
 *
 * 接收对话层抽取好的结构化事件，校验后创建 Google Calendar 事项。
 * 当 dryRun 为 true 时，只返回预览，不实际写入日历。
 */
export const createEventTool = {
  name: "calendar_intake_create_event",
  description: "接收结构化事件字段，校验后创建 Google Calendar 日程。",
  parameters: Type.Object({
    sourceText: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    location: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    allDay: Type.Optional(Type.Boolean()),
    start: Type.Optional(Type.String()),
    end: Type.Optional(Type.String()),
    confidence: Type.Optional(Type.Number()),
    issues: Type.Optional(Type.Array(Type.String())),
    previewToken: Type.Optional(Type.String()),
    titleOverride: Type.Optional(Type.String()),
    locationOverride: Type.Optional(Type.String()),
    descriptionOverride: Type.Optional(Type.String()),
    allDayOverride: Type.Optional(Type.Boolean()),
    startOverride: Type.Optional(Type.String()),
    endOverride: Type.Optional(Type.String()),
    dryRun: Type.Optional(Type.Boolean())
  }),
  async execute(_id: string, params: CreateEventParams) {
    const api = (this as any).api;
    const cfg = getConfig(api);
    assertPluginReady(cfg);

    const basePreview = resolveCreatePreview(params, cfg.timezone);
    const eventWindow = basePreview.parsedEvent
      ? buildEventDayWindow(basePreview.parsedEvent, cfg.timezone)
      : undefined;
    const nearby = basePreview.parsedEvent
      ? await listEvents(
        cfg.credentialsPath,
        cfg.tokenPath,
        cfg.calendarId,
        eventWindow!.start,
        eventWindow!.end,
        cfg.timezone
      )
      : [];
    const dedupeMatches = basePreview.parsedEvent
      ? detectDedupeMatches(
        basePreview.parsedEvent,
        nearby,
        cfg.timezone,
        cfg.dedupeWindowMinutes
      )
      : [];
    const conflicts = basePreview.parsedEvent ? detectConflicts(basePreview.parsedEvent, nearby, cfg.timezone) : [];
    const shouldAutoCreate = basePreview.shouldAutoCreate && dedupeMatches.length === 0 && conflicts.length === 0;
    const previewToken = encodePreviewToken(basePreview.event);
    const preview: CreateEventPreview & { previewToken: string } = {
      ...basePreview,
      shouldAutoCreate,
      previewToken,
      confidenceReasons: [
        ...basePreview.confidenceReasons,
        ...(dedupeMatches.length ? ["检测到疑似重复事项"] : []),
        ...(conflicts.length ? ["检测到时间冲突"] : [])
      ],
      clarificationPrompt: basePreview.clarificationPrompt
        ?? (dedupeMatches.length
          ? "我发现疑似重复事项，是否仍然要创建新的日程？"
          : conflicts.length
            ? "这个时间段已有其它日程，是否仍然要继续创建？"
            : undefined)
    };
    const text = buildPreviewText(preview, cfg.timezone, dedupeMatches, conflicts);

    if (params.dryRun) {
      return {
        structuredContent: {
          ...preview,
          dedupeMatches,
          conflicts
        },
        content: [{ type: "text", text }]
      };
    }

    if (!preview.shouldAutoCreate || !preview.parsedEvent) {
      return {
        structuredContent: {
          ...preview,
          dedupeMatches,
          conflicts,
          blocked: true
        },
        content: [{ type: "text", text: `${text}\n\n当前不会直接创建，请先完成确认。` }]
      };
    }

    const normalizedTimeText = formatParsedEventTime(preview.parsedEvent, cfg.timezone);
    const created = await createEvent(
      cfg.credentialsPath,
      cfg.tokenPath,
      cfg.calendarId,
      preview.parsedEvent,
      cfg.timezone
    );

    return {
      structuredContent: {
        createdEventId: created.id ?? null,
        summary: created.summary ?? preview.parsedEvent.title,
        normalizedTimeText,
        previewToken
      },
      content: [
        {
          type: "text",
          text: `已添加日程：${created.summary ?? preview.parsedEvent.title}\n时间：${normalizedTimeText}\n地点：${preview.parsedEvent.location ?? "(未识别)"}`
        }
      ]
    };
  }
};
