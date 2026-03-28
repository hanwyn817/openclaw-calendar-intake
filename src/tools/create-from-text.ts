import { Type } from "@sinclair/typebox";
import { fuzzy } from "fast-fuzzy";
import { DateTime } from "luxon";
import { DEFAULT_DURATION_MINUTES } from "../constants.js";
import { assertPluginReady, getConfig } from "../config.js";
import { formatParsedEventTime, parseDateTimeInZone, toDateOnly, toRfc3339 } from "../datetime.js";
import { createEvent, describeEvent, listEvents } from "../google/calendar.js";
import { buildParsedEventPreview } from "../parser.js";
import type { CalendarEventLite, ParsedEvent, ParsedEventPreview } from "../types.js";

type PreviewTokenPayload = {
  version: 1;
  parsedEvent: ParsedEvent;
};

type CreateFromTextParams = {
  text?: string;
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

function buildPreviewText(
  preview: ParsedEventPreview,
  timezone: string,
  dedupeMatches: CalendarEventLite[],
  conflicts: CalendarEventLite[]
) {
  const lines = [
    `标题：${preview.parsedEvent.title}`,
    `时间：${preview.normalizedTimeText}`,
    `地点：${preview.parsedEvent.location ?? "(未识别)"}`,
    `自动创建：${preview.shouldAutoCreate ? "是" : "否"}`
  ];

  if (preview.confidenceReasons.length) {
    lines.push(`原因：${preview.confidenceReasons.join("；")}`);
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

function encodePreviewToken(preview: ParsedEventPreview): string {
  const payload: PreviewTokenPayload = {
    version: 1,
    parsedEvent: preview.parsedEvent
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePreviewToken(token: string): ParsedEvent {
  const raw = Buffer.from(token, "base64url").toString("utf8");
  const payload = JSON.parse(raw) as Partial<PreviewTokenPayload>;
  const parsedEvent = payload.parsedEvent;

  if (
    payload.version !== 1
    || !parsedEvent
    || typeof parsedEvent.title !== "string"
    || typeof parsedEvent.start !== "string"
    || typeof parsedEvent.end !== "string"
    || typeof parsedEvent.allDay !== "boolean"
    || typeof parsedEvent.sourceText !== "string"
  ) {
    throw new Error("previewToken 无效或已过期，请重新执行一次创建预览。");
  }

  return parsedEvent;
}

export function applyEventOverrides(parsedEvent: ParsedEvent, params: CreateFromTextParams, timezone: string): ParsedEvent {
  const next: ParsedEvent = {
    ...parsedEvent,
    title: params.titleOverride?.trim() || parsedEvent.title,
    location: params.locationOverride?.trim() || parsedEvent.location
  };

  if (!params.timeTextOverride?.trim()) {
    return next;
  }

  const baseNow = parsedEvent.allDay
    ? DateTime.fromFormat(parsedEvent.start, "yyyy-LL-dd", { zone: timezone }).set({ hour: 9 })
    : DateTime.fromISO(parsedEvent.start, { setZone: true }).setZone(timezone);
  const parsedTime = parseDateTimeInZone(params.timeTextOverride, timezone, baseNow);

  if (!parsedTime) {
    throw new Error("timeTextOverride 未能解析，请提供更明确的日期或时间段。");
  }

  if (parsedTime.isDateOnly) {
    const start = parsedTime.start.startOf("day");
    return {
      ...next,
      start: toDateOnly(start),
      end: toDateOnly(start.plus({ days: 1 })),
      allDay: true
    };
  }

  const end = parsedTime.end ?? parsedTime.start.plus({ minutes: DEFAULT_DURATION_MINUTES });
  return {
    ...next,
    start: toRfc3339(parsedTime.start),
    end: toRfc3339(end),
    allDay: false
  };
}

function buildPreviewFromParams(
  params: CreateFromTextParams,
  timezone: string
): ParsedEventPreview {
  const hasOverrides = Boolean(
    params.titleOverride?.trim()
    || params.locationOverride?.trim()
    || params.timeTextOverride?.trim()
  );

  if (params.previewToken) {
    const parsedEvent = applyEventOverrides(decodePreviewToken(params.previewToken), params, timezone);
    return {
      parsedEvent,
      missingFields: [],
      shouldAutoCreate: true,
      normalizedTimeText: formatParsedEventTime(parsedEvent, timezone),
      clarificationPrompt: undefined,
      confidenceReasons: hasOverrides
        ? ["已使用已确认的预览结果", "已应用用户确认的字段修正"]
        : ["已使用已确认的预览结果"]
    };
  }

  if (!params.text?.trim()) {
    throw new Error("缺少原始通知文本，请传入 text，或使用 dryRun 返回的 previewToken。");
  }

  const basePreview = buildParsedEventPreview(params.text, timezone);
  if (!hasOverrides) {
    return basePreview;
  }

  const parsedEvent = applyEventOverrides(basePreview.parsedEvent, params, timezone);
  return {
    ...basePreview,
    parsedEvent,
    missingFields: basePreview.missingFields.filter((field) =>
      !(field === "title" && params.titleOverride?.trim())
      && !(field === "time" && params.timeTextOverride?.trim())
      && !(field === "location" && params.locationOverride?.trim())
    ),
    shouldAutoCreate: true,
    normalizedTimeText: formatParsedEventTime(parsedEvent, timezone),
    clarificationPrompt: undefined,
    confidenceReasons: [...basePreview.confidenceReasons, "已应用用户确认的字段修正"]
  };
}

/**
 * 工具：calendar_intake_create_from_text
 *
 * 解析原始会议通知并创建 Google Calendar 事项。
 * 当 dryRun 为 true 时，只返回解析结果，不实际写入日历。
 */
export const createFromTextTool = {
  name: "calendar_intake_create_from_text",
  description: "解析原始会议通知文本，并创建 Google Calendar 日程。",
  parameters: Type.Object({
    text: Type.Optional(Type.String()),
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
    const basePreview = buildPreviewFromParams(params, cfg.timezone);
    const window = buildEventDayWindow(basePreview.parsedEvent, cfg.timezone);
    const nearby = await listEvents(
      cfg.credentialsPath,
      cfg.tokenPath,
      cfg.calendarId,
      window.start,
      window.end,
      cfg.timezone
    );
    const dedupeMatches = detectDedupeMatches(
      basePreview.parsedEvent,
      nearby,
      cfg.timezone,
      cfg.dedupeWindowMinutes
    );
    const conflicts = detectConflicts(basePreview.parsedEvent, nearby, cfg.timezone);
    const shouldAutoCreate = basePreview.shouldAutoCreate && dedupeMatches.length === 0 && conflicts.length === 0;
    const previewToken = encodePreviewToken(basePreview);
    const preview = {
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
        content: [
          {
            type: "text",
            text
          }
        ]
      };
    }

    if (!preview.shouldAutoCreate) {
      return {
        structuredContent: {
          ...preview,
          dedupeMatches,
          conflicts,
          blocked: true
        },
        content: [
          {
            type: "text",
            text: `${text}\n\n当前不会直接创建，请先完成确认。`
          }
        ]
      };
    }

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
        normalizedTimeText: formatParsedEventTime(preview.parsedEvent, cfg.timezone)
      },
      content: [
        {
          type: "text",
          text: `已添加日程：${created.summary ?? preview.parsedEvent.title}\n时间：${formatParsedEventTime(preview.parsedEvent, cfg.timezone)}\n地点：${preview.parsedEvent.location ?? "(未识别)"}`
        }
      ]
    };
  }
};
