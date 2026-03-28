import { google } from "googleapis";
import type { CalendarEventLite, ParsedEvent } from "../types.js";
import { formatEventStart } from "../datetime.js";
import { loadOAuthClient } from "./auth.js";

function toLiteEvent(item: any): CalendarEventLite {
  return {
    id: item.id!,
    summary: item.summary ?? undefined,
    location: item.location ?? undefined,
    description: item.description ?? undefined,
    start: {
      dateTime: item.start?.dateTime ?? undefined,
      date: item.start?.date ?? undefined,
      timeZone: item.start?.timeZone ?? undefined
    },
    end: {
      dateTime: item.end?.dateTime ?? undefined,
      date: item.end?.date ?? undefined,
      timeZone: item.end?.timeZone ?? undefined
    }
  };
}

/**
 * 在 Google Calendar 中创建事项。
 * 同时兼容带具体时间的事项和全天事项。
 */
export async function createEvent(
  credentialsPath: string,
  tokenPath: string,
  calendarId: string,
  parsed: ParsedEvent,
  timezone: string
) {
  const auth = await loadOAuthClient(credentialsPath, tokenPath, true);
  const calendar = google.calendar({ version: "v3", auth });

  const resource = parsed.allDay
    ? {
        summary: parsed.title,
        location: parsed.location,
        description: parsed.description,
        start: { date: parsed.start.slice(0, 10) },
        end: { date: parsed.end.slice(0, 10) }
      }
    : {
        summary: parsed.title,
        location: parsed.location,
        description: parsed.description,
        start: { dateTime: parsed.start, timeZone: timezone },
        end: { dateTime: parsed.end, timeZone: timezone }
      };

  const res = await calendar.events.insert({
    calendarId,
    requestBody: resource
  });

  return res.data;
}

/**
 * 列出指定时间窗口内的 Google Calendar 事项。
 * 返回轻量结构，供后续评分和展示使用。
 */
export async function listEvents(
  credentialsPath: string,
  tokenPath: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
  timezone: string
): Promise<CalendarEventLite[]> {
  const auth = await loadOAuthClient(credentialsPath, tokenPath, true);
  const calendar = google.calendar({ version: "v3", auth });

  const res = await calendar.events.list({
    calendarId,
    timeMin,
    timeMax,
    timeZone: timezone,
    singleEvents: true,
    orderBy: "startTime"
  });

  return (res.data.items ?? []).map(toLiteEvent);
}

export function describeEvent(
  event: CalendarEventLite,
  timezone: string,
  includeId = false
): string {
  const parts = [
    formatEventStart(event, timezone),
    event.summary ?? "(无标题)"
  ];

  if (event.location) {
    parts.push(event.location);
  }

  if (includeId) {
    parts.push(`id=${event.id}`);
  }

  return parts.join(" | ");
}

/**
 * 根据事项 ID 删除 Google Calendar 日程。
 */
export async function deleteEvent(
  credentialsPath: string,
  tokenPath: string,
  calendarId: string,
  eventId: string
) {
  const auth = await loadOAuthClient(credentialsPath, tokenPath, true);
  const calendar = google.calendar({ version: "v3", auth });
  const existing = await calendar.events.get({ calendarId, eventId });

  await calendar.events.delete({ calendarId, eventId });
  return {
    ok: true,
    event: toLiteEvent(existing.data)
  };
}
