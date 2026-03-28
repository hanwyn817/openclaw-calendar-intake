import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import {
  CONTENT_LABELS,
  DEFAULT_DURATION_MINUTES,
  DESC_LABELS,
  LOCATION_KEYWORDS,
  LOCATION_LABELS,
  TIME_LABELS,
  TITLE_LABELS
} from "./constants.js";
import { formatParsedEventTime, parseDateTimeInZone, toDateOnly, toRfc3339, zonedNow } from "./datetime.js";
import type { ParsedEvent, ParsedEventPreview } from "./types.js";
import {
  extractLabeledValue,
  extractUrls,
  normalizeText,
  stripLeadingCommand
} from "./text-utils.js";

const ALL_DAY_KEYWORDS = ["全天", "整天", "all day", "放假", "调休", "休假", "deadline", "ddl", "due", "截止"];
const MEETING_URL_KEYWORDS = ["meet.google.com", "zoom.us", "tencent meeting", "voovmeeting", "teams.microsoft.com"];

function isDateOnlyText(value: string): boolean {
  return /\b\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\b/.test(value)
    || /\b\d{1,2}[\/\-]\d{1,2}\b/.test(value)
    || /(?:今天|明天|后天|本周[一二三四五六日天]|下周[一二三四五六日天]|周[一二三四五六日天])/.test(value);
}

function hasAllDayIntent(text: string): boolean {
  const lower = text.toLowerCase();
  return ALL_DAY_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()));
}

function hasExplicitDateOnlyIntent(text: string): boolean {
  const explicitTime = extractLabeledValue(text, TIME_LABELS);
  return Boolean(explicitTime && isDateOnlyText(explicitTime) && !/[0-9]\s*(?::|点|时)|上午|下午|晚上|pm|am/i.test(explicitTime));
}

function isQuotedOrHeaderLine(line: string): boolean {
  return /^(>|>>|On .+ wrote:|发件人:|收件人:|抄送:|主题:|subject:|from:|to:|cc:)/i.test(line);
}

function inferTitleFromSentence(text: string): string | undefined {
  const match = text.match(/(?:召开|举行|安排|组织)\s*([^，。:\n]{1,40}?)(?=[：:，。,]|$)/u);
  const value = match?.[1]?.trim();
  if (!value || /^(如下|如下安排|如下内容)$/u.test(value)) return undefined;
  return value || undefined;
}

function inferTitleFromNoticeHeadline(text: string): string | undefined {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;

  const cleaned = firstLine.replace(/^@[^ ]+\s*/u, "");
  const match = cleaned.match(/(?:关于)?(.+?)(?:名单征集|报名通知)?的通知[:：]?$/u);
  return match?.[1]?.trim() || undefined;
}

function inferBracketedTitle(text: string): string | undefined {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const value = firstLine?.match(/^[【\[](.*?)[】\]]$/u)?.[1]?.trim();
  return value || undefined;
}

function formatContentAsTitle(content: string, text: string): string {
  if (/(培训|课程|讲座|会议|例会|分享会|宣讲|workshop)$/iu.test(content)) {
    return content;
  }

  if (/培训/u.test(text)) {
    return `${content}培训`;
  }

  return content;
}

/**
 * 从显式标签字段或第一条高信息量文本行中推导标题。
 */
function deriveTitle(text: string): string {
  const explicit = extractLabeledValue(text, TITLE_LABELS);
  if (explicit) return explicit;

  const bracketed = inferBracketedTitle(text);
  if (bracketed) return bracketed;

  const contentTitle = extractLabeledValue(text, CONTENT_LABELS);
  if (contentTitle) return formatContentAsTitle(contentTitle, text);

  const headline = inferTitleFromNoticeHeadline(text);
  if (headline) return headline;

  const inferred = inferTitleFromSentence(text);
  if (inferred) return inferred;

  const candidate = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => {
      if (isQuotedOrHeaderLine(line)) return false;
      if (/^(dear|hi|hello|大家好|各位好|FYI|re:|fw:)/i.test(line)) return false;
      if (/^@/.test(line)) return false;
      if (/^(?:[-*•]|\d+[.)、]|[一二三四五六七八九十百千]+[、.)．])/u.test(line)) return false;
      if (/^(时间|time|when|地点|location|where|备注|议程|agenda|description)\s*:/i.test(line)) return false;
      if (/^https?:\/\//i.test(line)) return false;
      if (chrono.parse(line, new Date(), { forwardDate: true }).length > 0 && line.length <= 30) return false;
      return true;
    });

  if (candidate) {
    return candidate.slice(0, 80);
  }
  return "未命名事项";
}

/**
 * 从显式地点字段或关键词命中中推导会议地点。
 */
function deriveLocation(text: string): string | undefined {
  const explicit = extractLabeledValue(text, LOCATION_LABELS);
  if (explicit) return explicit;

  const lower = text.toLowerCase();
  const meetingUrl = extractUrls(text).find((url) =>
    MEETING_URL_KEYWORDS.some((keyword) => url.toLowerCase().includes(keyword))
  );
  if (meetingUrl) return meetingUrl;

  const meetingCode = text.match(/(?:会议号|meeting id)\s*[:：]?\s*([A-Za-z0-9\- ]{6,})/i)?.[1]?.trim();
  if (meetingCode) return `会议号 ${meetingCode}`;

  const numberedRoomMatch = text.match(/([A-Za-z0-9\-]+\s*(?:会议室|conference room))(?=\s|召开|开会|举行|安排|$|[，。,:：])/iu)?.[1]?.trim();
  if (numberedRoomMatch) return numberedRoomMatch;

  const roomMatch = text.match(
    /((?:会议室|conference room)(?:\s*[A-Za-z0-9\-]+(?:室)?)?)(?=\s|召开|开会|举行|安排|$|[，。,:：])/iu
  )?.[1]?.trim();
  if (roomMatch) return roomMatch;

  const keyword = LOCATION_KEYWORDS.find((k) => lower.includes(k.toLowerCase()));
  return keyword;
}

/**
 * 用备注字段和原始通知内容组合 description。
 */
function deriveDescription(text: string): string {
  const explicit = extractLabeledValue(text, DESC_LABELS);
  if (explicit) return `${explicit}\n\n---- 原始通知 ----\n${text}`;
  return `原始通知：\n${text}`;
}

/**
 * 解析会议通知，输出结构化事项。
 * 时间识别基于 chrono-node，并应用默认时长和全天事项规则。
 *
 * @param input 去掉命令词之前的原始聊天消息
 * @param timezone 解释文本时间时使用的默认时区
 */
export function parseEventFromText(
  input: string,
  timezone: string,
  options?: { now?: string }
): ParsedEvent {
  const raw = normalizeText(input);
  const text = stripLeadingCommand(raw);

  const title = deriveTitle(text);
  const location = deriveLocation(text);
  const description = deriveDescription(text);

  const explicitTime = extractLabeledValue(text, TIME_LABELS);
  const timeBase = explicitTime ?? text;
  const now = options?.now
    ? DateTime.fromISO(options.now, { zone: timezone })
    : zonedNow(timezone);
  const parsed = parseDateTimeInZone(timeBase, timezone, now);

  if (!parsed) {
    throw new Error("未能从文本中识别到明确时间，请补充日期或时段。");
  }

  if (parsed.isDateOnly) {
    const start = parsed.start.startOf("day");
    const end = start.plus({ days: 1 });

    return {
      title,
      start: toDateOnly(start),
      end: toDateOnly(end),
      allDay: true,
      location,
      description,
      sourceText: text,
      confidence: 0.75
    };
  }

  const end = parsed.end ?? parsed.start.plus({ minutes: DEFAULT_DURATION_MINUTES });

  return {
    title,
    start: toRfc3339(parsed.start),
    end: toRfc3339(end),
    allDay: false,
    location,
    description,
    sourceText: text,
    confidence: 0.9
  };
}

export function buildParsedEventPreview(
  input: string,
  timezone: string,
  options?: { now?: string }
): ParsedEventPreview {
  const parsedEvent = parseEventFromText(input, timezone, options);
  const text = stripLeadingCommand(normalizeText(input));
  const missingFields: string[] = [];
  const confidenceReasons: string[] = [];

  if (parsedEvent.title === "未命名事项") {
    missingFields.push("title");
    confidenceReasons.push("标题未能稳定识别");
  } else {
    confidenceReasons.push("标题已识别");
  }

  const explicitAllDay = parsedEvent.allDay && (hasAllDayIntent(text) || hasExplicitDateOnlyIntent(text));
  if (parsedEvent.allDay && !explicitAllDay) {
    missingFields.push("time");
    confidenceReasons.push("时间仅识别到日期，仍需确认是否为全天事项");
  } else if (parsedEvent.allDay) {
    confidenceReasons.push("识别为明确的全天事项");
  } else {
    confidenceReasons.push("开始和结束时间都已识别");
  }

  const normalizedTimeText = formatParsedEventTime(parsedEvent, timezone);
  let clarificationPrompt: string | undefined;
  if (missingFields[0] === "title") {
    clarificationPrompt = "这条日程的标题是什么？";
  } else if (missingFields[0] === "time") {
    clarificationPrompt = `我先按“${normalizedTimeText}”理解；如果不是全天事项，请补充具体开始时间。`;
  }

  const confidence = missingFields.length > 0 ? 0.78 : 0.92;
  parsedEvent.confidence = confidence;

  return {
    parsedEvent,
    missingFields,
    shouldAutoCreate: confidence >= 0.85,
    normalizedTimeText,
    clarificationPrompt,
    confidenceReasons
  };
}
