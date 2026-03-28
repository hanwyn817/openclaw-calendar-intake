import { Type } from "@sinclair/typebox";
import { DateTime } from "luxon";
import { assertPluginReady, getConfig } from "../config.js";
import { isoRangeAroundNow, localDateFromIso, parseDateTimeInZone, toRfc3339 } from "../datetime.js";
import { describeEvent, listEvents } from "../google/calendar.js";
import { scoreEventMatch } from "../scoring.js";
import type { CalendarEventLite, FindQuery, PluginConfig } from "../types.js";

function normalizeTitle(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 根据用户的删除请求文本构造查找条件。
 * 会提取标题关键词，并尝试解析目标日期或时间。
 */
export function buildFindQuery(raw: string, timezone: string, now?: DateTime): FindQuery {
  const best = parseDateTimeInZone(raw, timezone, now);
  const queryTitle = raw
    .replace(/删除日程/g, "")
    .replace(/[0-9:\-\/年月日点分上午下午今晚明天后天下周周一二三四五六日天\s]+/g, " ")
    .trim();
  const titleKeywords = queryTitle
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    raw,
    queryTitle,
    titleKeywords,
    targetStart: best?.isDateOnly ? undefined : best?.start.toISO() ?? undefined,
    targetDate: best ? localDateFromIso(best.start.toISO()!, timezone) : undefined
  };
}

function isExactDeleteMatch(query: FindQuery, event: { summary?: string; start?: { dateTime?: string; date?: string } }) {
  const eventTitle = normalizeTitle(event.summary ?? "");
  const queryTitle = normalizeTitle(query.queryTitle);
  if (!eventTitle || !queryTitle) return false;
  if (eventTitle !== queryTitle) return false;

  const startRaw = event.start?.dateTime ?? event.start?.date;
  if (!startRaw) return false;
  if (query.targetStart && event.start?.dateTime) {
    const diffMinutes = Math.abs(new Date(query.targetStart).getTime() - new Date(event.start.dateTime).getTime()) / 60000;
    return diffMinutes <= 30;
  }
  if (query.targetDate) {
    return startRaw.slice(0, 10) === query.targetDate;
  }
  return true;
}

function searchWindowForQuery(query: FindQuery, timezone: string, lookbackDays: number, lookaheadDays: number) {
  if (!query.targetDate) {
    return isoRangeAroundNow(timezone, lookbackDays, lookaheadDays);
  }

  const targetDay = DateTime.fromISO(query.targetDate, { zone: timezone });
  const base = isoRangeAroundNow(timezone, lookbackDays, lookaheadDays);
  const inDefaultRange = targetDay >= DateTime.fromISO(base.timeMin, { setZone: true })
    && targetDay <= DateTime.fromISO(base.timeMax, { setZone: true });
  if (inDefaultRange) {
    return base;
  }

  return {
    timeMin: toRfc3339(targetDay.startOf("day").minus({ days: 1 })),
    timeMax: toRfc3339(targetDay.endOf("day").plus({ days: 1 }))
  };
}

export type RankedEventCandidate = {
  event: CalendarEventLite;
  score: number;
  choiceId: string;
};

function rankEventCandidates(query: FindQuery, items: CalendarEventLite[]): RankedEventCandidate[] {
  return items
    .map((event) => ({ event, score: scoreEventMatch(query, event) }))
    .filter((x) => x.score > 10)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x, index) => ({
      ...x,
      choiceId: `C${index + 1}`
    }));
}

export function findCandidateByChoiceId(
  ranked: RankedEventCandidate[],
  choiceId: string | undefined
): RankedEventCandidate | undefined {
  if (!choiceId) return undefined;
  const normalized = choiceId.trim().toUpperCase();
  return ranked.find((candidate) => candidate.choiceId.toUpperCase() === normalized);
}

export function autoDeleteCandidateId(
  queryOrScores: FindQuery | Array<{ score: number; event: { id: string; summary?: string; start?: { dateTime?: string; date?: string } } }>,
  scoresOrMode?: Array<{ score: number; event: { id: string; summary?: string; start?: { dateTime?: string; date?: string } } }> | "never" | "exact_only" | "heuristic",
  maybeMode: "never" | "exact_only" | "heuristic" = "exact_only"
): string | undefined {
  const legacyCall = Array.isArray(queryOrScores);
  const query = legacyCall
    ? {
        raw: "",
        queryTitle: "",
        titleKeywords: []
      }
    : queryOrScores;
  const scores = legacyCall
    ? queryOrScores
    : Array.isArray(scoresOrMode) ? scoresOrMode : [];
  const mode = legacyCall
    ? (scoresOrMode as "never" | "exact_only" | "heuristic" | undefined) ?? "heuristic"
    : maybeMode;

  if (!scores.length) return undefined;
  if (mode === "never") return undefined;
  const [top, second] = scores;
  const exactMatch = isExactDeleteMatch(query, top.event);

  if (mode === "exact_only") {
    if (!exactMatch) return undefined;
    if (second && isExactDeleteMatch(query, second.event)) return undefined;
    return top.event.id;
  }

  if (top.score < 60) return undefined;
  if (!exactMatch && (!query.targetDate || top.score < 75)) return undefined;
  if (second && top.score - second.score < 15) return undefined;
  return top.event.id;
}

function buildFindCandidatesText(
  ranked: RankedEventCandidate[],
  autoDeleteEventId: string | undefined,
  timezone: string,
  window: { timeMin: string; timeMax: string }
): string {
  return ranked.length
    ? [
        autoDeleteEventId
          ? `已命中唯一精确候选，可安全删除。eventId=${autoDeleteEventId}`
          : "候选事项：",
        ...ranked.map((x) => `候选 ${x.choiceId} [score=${x.score.toFixed(1)}] ${describeEvent(x.event, timezone)} [eventId=${x.event.id}]`),
        `搜索范围：${window.timeMin} -> ${window.timeMax}`
      ].join("\n")
    : `没有找到高置信度候选项。\n搜索范围：${window.timeMin} -> ${window.timeMax}`;
}

export async function resolveFindEvents(cfg: PluginConfig, queryText: string) {
  const query = buildFindQuery(queryText, cfg.timezone);
  const window = searchWindowForQuery(query, cfg.timezone, cfg.lookbackDays, cfg.lookaheadDays);

  const items = await listEvents(
    cfg.credentialsPath,
    cfg.tokenPath,
    cfg.calendarId,
    window.timeMin,
    window.timeMax,
    cfg.timezone
  );

  const ranked = rankEventCandidates(query, items);
  const autoDeleteEventId = autoDeleteCandidateId(query, ranked, cfg.autoDeleteMode);

  return {
    query,
    window,
    ranked,
    autoDeleteEventId
  };
}

/**
 * 工具：calendar_intake_find_events
 *
 * 根据自然语言查询寻找候选日历事项，
 * 并返回按分数排序的候选列表及其 ID。
 */
export const findEventsTool = {
  name: "calendar_intake_find_events",
  description: "根据自然语言查询查找可能匹配的 Google Calendar 日程。",
  parameters: Type.Object({
    queryText: Type.String()
  }),
  async execute(_id: string, params: { queryText: string }) {
    const api = (this as any).api;
    const cfg = getConfig(api);
    assertPluginReady(cfg);
    const { query, window, ranked, autoDeleteEventId } = await resolveFindEvents(cfg, params.queryText);
    const text = buildFindCandidatesText(ranked, autoDeleteEventId, cfg.timezone, window);

    return {
      structuredContent: {
        query,
        searchWindowUsed: window,
        requiresConfirmation: autoDeleteEventId == null,
        autoDeleteEventId: autoDeleteEventId ?? null,
        candidates: ranked.map((x) => ({
          ...x.event,
          score: x.score,
          choiceId: x.choiceId
        }))
      },
      content: [{ type: "text", text }]
    };
  }
};
