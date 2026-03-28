import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import type { ParsedEvent } from "./types.js";

const DISPLAY_DATE = "yyyy-LL-dd";
const DISPLAY_DATE_TIME = "yyyy-LL-dd HH:mm";

export type ParsedDateTimeResult = {
  start: DateTime;
  end?: DateTime;
  isDateOnly: boolean;
};

function ensureValidZone(timezone: string): string {
  return DateTime.now().setZone(timezone).isValid ? timezone : "Asia/Shanghai";
}

export function zonedNow(timezone: string): DateTime {
  return DateTime.now().setZone(ensureValidZone(timezone));
}

export function buildChronoReferenceDate(timezone: string, now: DateTime = zonedNow(timezone)): Date {
  return new Date(
    now.year,
    now.month - 1,
    now.day,
    now.hour,
    now.minute,
    now.second,
    now.millisecond
  );
}

function parsedComponentToDateTime(component: chrono.ParsedComponents, timezone: string): DateTime {
  return parsedComponentToDateTimeWithFallback(component, timezone);
}

function parsedComponentToDateTimeWithFallback(
  component: chrono.ParsedComponents,
  timezone: string,
  fallback?: DateTime
): DateTime {
  const zone = ensureValidZone(timezone);
  const year = component.isCertain("year") ? component.get("year") : fallback?.year ?? component.get("year");
  const month = component.isCertain("month") ? component.get("month") : fallback?.month ?? component.get("month");
  const day = component.isCertain("day") ? component.get("day") : fallback?.day ?? component.get("day");
  const hour = component.isCertain("hour") ? component.get("hour") : 0;
  const minute = component.isCertain("minute") ? component.get("minute") : 0;
  const second = component.isCertain("second") ? component.get("second") : 0;

  if (year == null || month == null || day == null) {
    throw new Error("未能从文本中识别到完整日期。");
  }

  let value = DateTime.fromObject(
    {
      year,
      month,
      day,
      hour: hour ?? 0,
      minute: minute ?? 0,
      second: second ?? 0,
      millisecond: 0
    },
    { zone }
  );

  if (
    fallback &&
    component.isCertain("hour") &&
    !component.isCertain("meridiem") &&
    fallback.hour >= 12 &&
    value.hour < 12
  ) {
    value = value.plus({ hours: 12 });
  }

  if (fallback && value < fallback) {
    value = value.plus({ days: 1 });
  }

  return value;
}

function parseChronoResult(text: string, referenceDate: Date) {
  const parsers = /[\u3400-\u9fff]/u.test(text)
    ? [chrono.zh.casual, chrono.casual]
    : [chrono.casual, chrono.zh.casual];

  for (const parser of parsers) {
    const match = parser.parse(text, referenceDate, { forwardDate: true })[0];
    if (match) {
      return match;
    }
  }

  return undefined;
}

export function parseDateTimeInZone(
  text: string,
  timezone: string,
  now: DateTime = zonedNow(timezone)
): ParsedDateTimeResult | undefined {
  const referenceDate = buildChronoReferenceDate(timezone, now);
  const result = parseChronoResult(text, referenceDate);
  if (!result) return undefined;

  const start = parsedComponentToDateTime(result.start, timezone);
  const end = result.end ? parsedComponentToDateTimeWithFallback(result.end, timezone, start) : undefined;
  const isDateOnly = !result.start.isCertain("hour") && !result.start.isCertain("minute");

  return { start, end, isDateOnly };
}

export function toRfc3339(dateTime: DateTime): string {
  return dateTime.set({ millisecond: 0 }).toISO({
    suppressMilliseconds: true,
    includeOffset: true
  })!;
}

export function toDateOnly(dateTime: DateTime): string {
  return dateTime.toFormat(DISPLAY_DATE);
}

export function localDateFromIso(iso: string, timezone: string): string {
  return DateTime.fromISO(iso, { setZone: true }).setZone(ensureValidZone(timezone)).toFormat(DISPLAY_DATE);
}

export function formatAbsoluteDateTime(iso: string, timezone: string): string {
  return DateTime.fromISO(iso, { setZone: true })
    .setZone(ensureValidZone(timezone))
    .toFormat(DISPLAY_DATE_TIME);
}

export function formatParsedEventTime(event: ParsedEvent, timezone: string): string {
  const zone = ensureValidZone(timezone);
  if (event.allDay) {
    const end = DateTime.fromFormat(event.end, DISPLAY_DATE, { zone }).minus({ days: 1 }).toFormat(DISPLAY_DATE);
    return event.start === end
      ? `${event.start} 全天 (${zone})`
      : `${event.start} 至 ${end} 全天 (${zone})`;
  }

  const start = formatAbsoluteDateTime(event.start, zone);
  const end = formatAbsoluteDateTime(event.end, zone);
  return `${start} - ${end} (${zone})`;
}

export function formatEventStart(
  event: {
    start?: { dateTime?: string; date?: string; timeZone?: string };
  },
  fallbackTimezone: string
): string {
  if (event.start?.date) {
    return `${event.start.date} (全天)`;
  }

  if (!event.start?.dateTime) {
    return "(无开始时间)";
  }

  const zone = event.start.timeZone ?? ensureValidZone(fallbackTimezone);
  return DateTime.fromISO(event.start.dateTime, { setZone: true })
    .setZone(zone)
    .toFormat(DISPLAY_DATE_TIME);
}

export function isoRangeAroundNow(
  timezone: string,
  lookbackDays: number,
  lookaheadDays: number,
  now: DateTime = zonedNow(timezone)
): { timeMin: string; timeMax: string } {
  return {
    timeMin: toRfc3339(now.minus({ days: lookbackDays })),
    timeMax: toRfc3339(now.plus({ days: lookaheadDays }))
  };
}
