import { Type } from "@sinclair/typebox";
import { DateTime } from "luxon";
import { assertPluginReady, getConfig } from "../config.js";
import { describeEvent, listEvents } from "../google/calendar.js";
import { parseDateTimeInZone, toRfc3339, zonedNow } from "../datetime.js";

/**
 * 把范围关键字转换成具体时间窗口。
 * `today` 和 `tomorrow` 对应单日窗口，`week` 对应本周一到周日。
 */
export function rangeToWindow(
  range: string,
  timezone: string,
  now: DateTime = zonedNow(timezone)
): { start: string; end: string } {
  const zoned = now.setZone(timezone);

  if (range === "today") {
    return {
      start: toRfc3339(zoned.startOf("day")),
      end: toRfc3339(zoned.endOf("day"))
    };
  }

  if (range === "tomorrow") {
    const tomorrow = zoned.plus({ days: 1 });
    return {
      start: toRfc3339(tomorrow.startOf("day")),
      end: toRfc3339(tomorrow.endOf("day"))
    };
  }

  if (range === "next_week") {
    const monday = zoned.startOf("day").minus({ days: zoned.weekday - 1 }).plus({ days: 7 });
    const sunday = monday.plus({ days: 6 }).endOf("day");
    return { start: toRfc3339(monday), end: toRfc3339(sunday) };
  }

  if (range === "month") {
    return {
      start: toRfc3339(zoned.startOf("month")),
      end: toRfc3339(zoned.endOf("month"))
    };
  }

  const monday = zoned.startOf("day").minus({ days: zoned.weekday - 1 });
  const sunday = monday.plus({ days: 6 }).endOf("day");
  return { start: toRfc3339(monday), end: toRfc3339(sunday) };
}

function queryToWindow(queryText: string, timezone: string, now: DateTime = zonedNow(timezone)) {
  const text = queryText.trim();
  if (!text) return undefined;
  if (/今天|今日/.test(text)) return rangeToWindow("today", timezone, now);
  if (/明天|明日/.test(text)) return rangeToWindow("tomorrow", timezone, now);
  if (/下周/.test(text)) return rangeToWindow("next_week", timezone, now);
  if (/本周|这周/.test(text)) return rangeToWindow("week", timezone, now);
  if (/本月|这个月/.test(text)) return rangeToWindow("month", timezone, now);

  const parts = text.split(/\s*(?:到|至|-)\s*/).filter(Boolean);
  if (parts.length === 2) {
    const start = parseDateTimeInZone(parts[0], timezone, now);
    const end = parseDateTimeInZone(parts[1], timezone, now);
    if (start && end) {
      return {
        start: toRfc3339(start.isDateOnly ? start.start.startOf("day") : start.start),
        end: toRfc3339(end.isDateOnly ? end.start.endOf("day") : (end.end ?? end.start.endOf("hour")))
      };
    }
  }

  const parsed = parseDateTimeInZone(text, timezone, now);
  if (!parsed) return undefined;
  if (parsed.isDateOnly) {
    return {
      start: toRfc3339(parsed.start.startOf("day")),
      end: toRfc3339(parsed.start.endOf("day"))
    };
  }
  if (parsed.end) {
    return {
      start: toRfc3339(parsed.start),
      end: toRfc3339(parsed.end)
    };
  }
  return {
    start: toRfc3339(parsed.start.startOf("day")),
    end: toRfc3339(parsed.start.endOf("day"))
  };
}

/**
 * 工具：calendar_intake_list_events
 *
 * 根据预设范围或显式时间窗口列出 Google Calendar 日程，
 * 并返回适合聊天展示的文本。
 */
export const listEventsTool = {
  name: "calendar_intake_list_events",
  description: "查看今天、明天、本周或指定时间窗口内的 Google Calendar 日程。",
  parameters: Type.Object({
    range: Type.Optional(Type.Union([
      Type.Literal("today"),
      Type.Literal("tomorrow"),
      Type.Literal("week"),
      Type.Literal("next_week"),
      Type.Literal("month")
    ])),
    queryText: Type.Optional(Type.String()),
    timeMin: Type.Optional(Type.String()),
    timeMax: Type.Optional(Type.String())
  }),
  async execute(_id: string, params: { range?: "today" | "tomorrow" | "week" | "next_week" | "month"; queryText?: string; timeMin?: string; timeMax?: string }) {
    const api = (this as any).api;
    const cfg = getConfig(api);
    assertPluginReady(cfg);

    const window = params.timeMin && params.timeMax
      ? { start: params.timeMin, end: params.timeMax }
      : params.queryText
        ? (queryToWindow(params.queryText, cfg.timezone) ?? rangeToWindow("today", cfg.timezone))
        : rangeToWindow(params.range ?? "today", cfg.timezone);

    const items = await listEvents(
      cfg.credentialsPath,
      cfg.tokenPath,
      cfg.calendarId,
      window.start,
      window.end,
      cfg.timezone
    );

    const text = items.length
      ? items.map((e, i) => `${i + 1}. ${describeEvent(e, cfg.timezone)}`).join("\n")
      : "该时间范围内没有日程。";

    return {
      structuredContent: { items, window },
      content: [{ type: "text", text }]
    };
  }
};
