import { fuzzy } from "fast-fuzzy";
import type { CalendarEventLite, FindQuery } from "./types.js";

/**
 * 提取事项开始时间的 ISO 表示。
 * 如果是全天事项，则使用 date 字段。
 */
function eventStartIso(event: CalendarEventLite): string | undefined {
  return event.start?.dateTime ?? event.start?.date;
}

/**
 * 返回两个时间之间的绝对分钟差。
 */
function minutesDiff(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 60000;
}

/**
 * 计算删除查询和日历事项之间的启发式匹配分数。
 * 分数越高，说明越可能是用户真正想操作的事项。
 * 评分因素包括标题模糊匹配、关键词包含关系和时间接近程度。
 */
export function scoreEventMatch(query: FindQuery, event: CalendarEventLite): number {
  let score = 0;

  const title = (event.summary ?? "").trim();
  const queryTitle = query.titleKeywords.join(" ").trim();

  if (queryTitle && title) {
    const sim = fuzzy(queryTitle, title);
    score += sim * 60;

    const lowerTitle = title.toLowerCase();
    for (const kw of query.titleKeywords) {
      if (lowerTitle.includes(kw.toLowerCase())) score += 8;
    }
  }

  const startRaw = eventStartIso(event);
  if (query.targetStart && startRaw) {
    const diff = minutesDiff(new Date(query.targetStart), new Date(startRaw));
    if (diff <= 10) score += 40;
    else if (diff <= 30) score += 25;
    else if (diff <= 120) score += 10;
  } else if (query.targetDate && startRaw?.slice(0, 10) === query.targetDate) {
    score += 20;
  }

  return score;
}
