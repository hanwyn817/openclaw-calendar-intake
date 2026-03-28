export type ParsedEvent = {
  title: string;
  start: string;           // 带时区的 ISO 时间字符串
  end: string;             // 带时区的 ISO 时间字符串
  allDay: boolean;
  location?: string;
  description?: string;
  sourceText: string;
  confidence: number;      // 0 到 1 的置信度
};

export type CreateEventInput = {
  sourceText: string;
  title?: string;
  location?: string;
  description?: string;
  allDay?: boolean;
  start?: string;
  end?: string;
  confidence?: number;
  issues?: string[];
};

export type CreatePreviewTokenPayload = {
  version: 3;
  event: CreateEventInput;
};

export type DeletePreviewTokenPayload = {
  version: 1;
  calendarId: string;
  event: CalendarEventLite;
  choiceId?: string;
  score?: number;
};

export type CreateBlockReason =
  | "missing_title"
  | "missing_all_day"
  | "missing_start"
  | "missing_end"
  | "invalid_time_format"
  | "invalid_time_range"
  | "missing_confidence"
  | "low_confidence"
  | "reported_issues";

export type CreateEventPreview = {
  event: CreateEventInput;
  parsedEvent?: ParsedEvent;
  missingFields: string[];
  blockReasons: CreateBlockReason[];
  shouldAutoCreate: boolean;
  normalizedTimeText?: string; // 仅用于展示，不参与解析
  clarificationPrompt?: string;
  confidenceReasons: string[];
};

export type FindQuery = {
  raw: string;
  queryTitle: string;
  titleKeywords: string[];
  targetStart?: string;    // ISO 时间字符串
  targetDate?: string;     // YYYY-MM-DD 本地日期
};

export type CalendarEventLite = {
  id: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
};

export type PluginConfig = {
  configured: boolean;
  tokenReady: boolean;
  authReady: boolean;
  calendarId: string;
  timezone: string;
  tokenPath: string;
  credentialsPath: string;
  lookaheadDays: number;
  lookbackDays: number;
  autoDeleteMode: "never" | "exact_only" | "heuristic";
  dedupeWindowMinutes: number;
};
