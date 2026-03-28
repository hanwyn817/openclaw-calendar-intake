import { Type } from "@sinclair/typebox";
import { assertPluginReady, getConfig } from "../config.js";
import { describeEvent, deleteEvent } from "../google/calendar.js";
import { findCandidateByChoiceId, resolveFindEvents } from "./find-events.js";

/**
 * 工具：calendar_intake_delete_event
 *
 * 根据事项 ID 删除 Google Calendar 日程。
 */
export const deleteEventTool = {
  name: "calendar_intake_delete_event",
  description: "根据 event ID 或自然语言查询删除 Google Calendar 日程；若存在多个候选则返回 choiceId 供二次确认。",
  parameters: Type.Object({
    eventId: Type.Optional(Type.String()),
    queryText: Type.Optional(Type.String()),
    choiceId: Type.Optional(Type.String())
  }),
  async execute(_id: string, params: { eventId?: string; queryText?: string; choiceId?: string }) {
    const api = (this as any).api;
    const cfg = getConfig(api);
    assertPluginReady(cfg);

    let eventId = params.eventId;

    if (!eventId) {
      if (!params.queryText) {
        throw new Error("缺少 eventId 或 queryText，无法删除日程。");
      }

      const { query, window, ranked, autoDeleteEventId } = await resolveFindEvents(cfg, params.queryText);
      if (autoDeleteEventId) {
        eventId = autoDeleteEventId;
      } else {
        const chosen = findCandidateByChoiceId(ranked, params.choiceId);
        if (chosen) {
          eventId = chosen.event.id;
        } else {
          const text = ranked.length
            ? [
                "找到多个候选事项，暂不自动删除。",
                ...ranked.map((x) => `候选 ${x.choiceId} [score=${x.score.toFixed(1)}] ${describeEvent(x.event, cfg.timezone)}`),
                "如需继续删除，请再次调用本工具，并传入相同 queryText 加上对应的 choiceId。",
                `搜索范围：${window.timeMin} -> ${window.timeMax}`
              ].join("\n")
            : `没有找到可删除的候选事项。\n搜索范围：${window.timeMin} -> ${window.timeMax}`;

          return {
            structuredContent: {
              deleted: false,
              query,
              searchWindowUsed: window,
              requiresConfirmation: ranked.length > 0,
              autoDeleteEventId: null,
              candidates: ranked.map((x) => ({
                ...x.event,
                score: x.score,
                choiceId: x.choiceId
              }))
            },
            content: [{ type: "text", text }]
          };
        }
      }
    }

    const result = await deleteEvent(
      cfg.credentialsPath,
      cfg.tokenPath,
      cfg.calendarId,
      eventId
    );

    return {
      structuredContent: {
        deleted: true,
        deletedEventId: eventId,
        deletedEvent: result.event
      },
      content: [
        {
          type: "text",
          text: `已删除日程：${describeEvent(result.event, cfg.timezone)}`
        }
      ]
    };
  }
};
