import { Type } from "@sinclair/typebox";
import { fuzzy } from "fast-fuzzy";
import { DateTime } from "luxon";
import { DEFAULT_DURATION_MINUTES } from "../constants.js";
import { assertPluginReady, getConfig } from "../config.js";
import { formatParsedEventTime, parseDateTimeInZone, toDateOnly, toRfc3339 } from "../datetime.js";
import { createEvent, describeEvent, listEvents } from "../google/calendar.js";
import type {
  CalendarEventLite,
  CreateBlockReason,
  CreateEventPreview,
  CreatePreviewTokenPayload,
  ExtractedEventInput,
  ParsedEvent
} from "../types.js";

export type CreateFromTextParams = {
  sourceText?: string;
  title?: string;
  location?: string;
  timeText?: string;
  description?: string;
  confidence?: number;
  issues?: string[];
  previewToken?: string;
  titleOverride?: string;
  locationOverride?: string;
  timeTextOverride?: string;
  dryRun?: boolean;
};

function eventStartIso(event: CalendarEventLite): string | undefined {
  return event.start?.dateTime ?? event.start?.date;
}

function eventEndIso(event: CalendarEventLite): string | undefined {
  return event.end?.dateTime ?? event.end?.date;
}

function buildEventDayWindow(parsedEvent: ParsedEvent, timezone: string) {
  if (parsedEvent.allDay) {
    const start = DateTime.fromISO(parsedEvent.start, { zone: timezone }).startOf("day");
    return {
      start: start.toISO({ suppressMilliseconds: true, includeOffset: true })!,
      end: start.endOf("day").toISO({ suppressMilliseconds: true, includeOffset: true })!
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

function trimOptional(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeIssues(issues?: string[]): string[] {
  return (issues ?? []).map((item) => item.trim()).filter(Boolean);
}

function buildDescription(extracted: ExtractedEventInput): string {
  const sourceText = extracted.sourceText.trim();
  const explicit = trimOptional(extracted.description);
  if (explicit) {
    return `${explicit}\n\n---- 原始通知 ----\n${sourceText}`;
  }
  return `原始通知：\n${sourceText}`;
}

export function applyExtractedOverrides(
  extracted: ExtractedEventInput,
  params: CreateFromTextParams
): ExtractedEventInput {
  return {
    ...extracted,
    title: trimOptional(params.titleOverride) ?? trimOptional(extracted.title),
    location: trimOptional(params.locationOverride) ?? trimOptional(extracted.location),
    timeText: trimOptional(params.timeTextOverride) ?? trimOptional(extracted.timeText),
    description: trimOptional(extracted.description),
    issues: normalizeIssues(extracted.issues)
  };
}

function extractedFromParams(params: CreateFromTextParams): ExtractedEventInput {
  const sourceText = trimOptional(params.sourceText);
  if (!sourceText) {
    throw new Error("缺少 sourceText，无法创建日程预览。");
  }

  return {
    sourceText,
    title: trimOptional(params.title),
    location: trimOptional(params.location),
    timeText: trimOptional(params.timeText),
    description: trimOptional(params.description),
    confidence: typeof params.confidence === "number" ? params.confidence : undefined,
    issues: normalizeIssues(params.issues)
  };
}

function encodePreviewToken(extracted: ExtractedEventInput): string {
  const payload: CreatePreviewTokenPayload = {
    version: 2,
    extracted
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePreviewToken(token: string): ExtractedEventInput {
  const raw = Buffer.from(token, "base64url").toString("utf8");
  const payload = JSON.parse(raw) as Partial<CreatePreviewTokenPayload>;
  if (payload.version !== 2 || !payload.extracted || typeof payload.extracted.sourceText !== "string") {
    throw new Error("previewToken 无效或已过期，请重新执行一次创建预览。");
  }

  return {
    sourceText: payload.extracted.sourceText.trim(),
    title: trimOptional(payload.extracted.title),
    location: trimOptional(payload.extracted.location),
    timeText: trimOptional(payload.extracted.timeText),
    description: trimOptional(payload.extracted.description),
    confidence: typeof payload.extracted.confidence === "number" ? payload.extracted.confidence : undefined,
    issues: normalizeIssues(payload.extracted.issues)
  };
}

function buildClarificationPrompt(blockReasons: CreateBlockReason[], issues: string[]): string | undefined {
  if (blockReasons.includes("missing_title")) {
    return "请直接给出最终标题。";
  }
  if (blockReasons.includes("missing_time") || blockReasons.includes("unparseable_time")) {
    return "请直接给出最终时间，例如 2026-03-31 15:30-16:00。";
  }
  if (blockReasons.includes("reported_issues") && issues.length) {
    return `请先确认这些问题：${issues.join("；")}`;
  }
  if (blockReasons.includes("missing_confidence") || blockReasons.includes("low_confidence")) {
    return "请先确认最终标题、时间和地点后再创建。";
  }
  return undefined;
}

function buildParsedEvent(extracted: ExtractedEventInput, timezone: string): ParsedEvent | undefined {
  const title = trimOptional(extracted.title);
  const timeText = trimOptional(extracted.timeText);
  if (!title || !timeText) return undefined;

  const parsed = parseDateTimeInZone(timeText, timezone);
  if (!parsed) return undefined;

  if (parsed.isDateOnly) {
    const start = parsed.start.startOf("day");
    return {
      title,
      start: toDateOnly(start),
      end: toDateOnly(start.plus({ days: 1 })),
      allDay: true,
      location: trimOptional(extracted.location),
      description: buildDescription(extracted),
      sourceText: extracted.sourceText,
      confidence: extracted.confidence ?? 0
    };
  }

  const end = parsed.end ?? parsed.start.plus({ minutes: DEFAULT_DURATION_MINUTES });
  return {
    title,
    start: toRfc3339(parsed.start),
    end: toRfc3339(end),
    allDay: false,
    location: trimOptional(extracted.location),
    description: buildDescription(extracted),
    sourceText: extracted.sourceText,
    confidence: extracted.confidence ?? 0
  };
}

export function buildCreatePreview(
  extracted: ExtractedEventInput,
  timezone: string,
  mode: "fresh" | "confirmed" = "fresh"
): CreateEventPreview {
  const normalized: ExtractedEventInput = {
    sourceText: extracted.sourceText.trim(),
    title: trimOptional(extracted.title),
    location: trimOptional(extracted.location),
    timeText: trimOptional(extracted.timeText),
    description: trimOptional(extracted.description),
    confidence: typeof extracted.confidence === "number" ? extracted.confidence : undefined,
    issues: normalizeIssues(extracted.issues)
  };

  const missingFields: string[] = [];
  const blockReasons: CreateBlockReason[] = [];
  const confidenceReasons: string[] = [];

  if (!normalized.title) {
    missingFields.push("title");
    blockReasons.push("missing_title");
    confidenceReasons.push("标题待确认");
  } else {
    confidenceReasons.push("标题已提供");
  }

  if (!normalized.timeText) {
    missingFields.push("time");
    blockReasons.push("missing_time");
    confidenceReasons.push("时间待确认");
  }

  const parsedEvent = buildParsedEvent(normalized, timezone);
  if (normalized.timeText && !parsedEvent) {
    blockReasons.push("unparseable_time");
    if (!missingFields.includes("time")) {
      missingFields.push("time");
    }
    confidenceReasons.push("时间描述无法规范化");
  } else if (parsedEvent) {
    confidenceReasons.push("开始和结束时间都已规范化");
  }

  const issues = normalizeIssues(normalized.issues);
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
    extracted: normalized,
    parsedEvent,
    missingFields,
    blockReasons: dedupedBlockReasons,
    shouldAutoCreate: Boolean(parsedEvent) && dedupedBlockReasons.length === 0,
    normalizedTimeText: parsedEvent ? formatParsedEventTime(parsedEvent, timezone) : undefined,
    clarificationPrompt: buildClarificationPrompt(dedupedBlockReasons, issues),
    confidenceReasons
  };
}

function resolveCreatePreview(params: CreateFromTextParams, timezone: string): CreateEventPreview {
  if (params.previewToken) {
    return buildCreatePreview(
      applyExtractedOverrides(decodePreviewToken(params.previewToken), params),
      timezone,
      "confirmed"
    );
  }

  return buildCreatePreview(applyExtractedOverrides(extractedFromParams(params), params), timezone, "fresh");
}

function buildPreviewText(
  preview: CreateEventPreview,
  timezone: string,
  dedupeMatches: CalendarEventLite[],
  conflicts: CalendarEventLite[]
) {
  const lines = [
    `标题：${preview.extracted.title ?? "(待确认)"}`,
    `时间：${preview.normalizedTimeText ?? "(待确认)"}`,
    `地点：${preview.extracted.location ?? "(未识别)"}`,
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
 * 工具：calendar_intake_create_from_text
 *
 * 接收对话层抽取好的结构化字段，规范化后创建 Google Calendar 事项。
 * 当 dryRun 为 true 时，只返回预览，不实际写入日历。
 */
export const createFromTextTool = {
  name: "calendar_intake_create_from_text",
  description: "接收结构化抽取结果，规范化时间并创建 Google Calendar 日程。",
  parameters: Type.Object({
    sourceText: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    location: Type.Optional(Type.String()),
    timeText: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    confidence: Type.Optional(Type.Number()),
    issues: Type.Optional(Type.Array(Type.String())),
    previewToken: Type.Optional(Type.String()),
    titleOverride: Type.Optional(Type.String()),
    locationOverride: Type.Optional(Type.String()),
    timeTextOverride: Type.Optional(Type.String()),
    dryRun: Type.Optional(Type.Boolean())
  }),
  async execute(_id: string, params: CreateFromTextParams) {
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
    const previewToken = encodePreviewToken(basePreview.extracted);
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
