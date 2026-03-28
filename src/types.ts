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

export type ParsedEventPreview = {
  parsedEvent: ParsedEvent;
  missingFields: string[];
  shouldAutoCreate: boolean;
  normalizedTimeText: string;
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
