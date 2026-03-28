import { Type } from "@sinclair/typebox";
import { assertPluginReady, getConfig } from "../config.js";
import { describeEvent, deleteEvent } from "../google/calendar.js";
import { findCandidateByChoiceId, resolveFindEvents } from "./find-events.js";
import type { CalendarEventLite, DeletePreviewTokenPayload } from "../types.js";

type DeletePreviewCandidate = {
  event: CalendarEventLite;
  score: number;
  choiceId: string;
};

export function encodeDeletePreviewToken(
  calendarId: string,
  candidate: DeletePreviewCandidate
): string {
  const payload: DeletePreviewTokenPayload = {
    version: 1,
    calendarId,
    event: candidate.event,
    choiceId: candidate.choiceId,
    score: candidate.score
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeDeletePreviewToken(token: string): DeletePreviewTokenPayload {
  const raw = Buffer.from(token, "base64url").toString("utf8");
  const payload = JSON.parse(raw) as Partial<DeletePreviewTokenPayload>;
  if (
    payload.version !== 1
    || !payload.event
    || typeof payload.event.id !== "string"
    || typeof payload.calendarId !== "string"
  ) {
    throw new Error("deletePreviewToken 无效或已过期，请重新执行一次删除查询。");
  }

  return {
    version: 1,
    calendarId: payload.calendarId,
    event: payload.event,
    choiceId: payload.choiceId,
    score: payload.score
  };
}

/**
 * 工具：calendar_intake_delete_event
 *
 * 根据事项 ID 删除 Google Calendar 日程。
 */
export const deleteEventTool = {
  name: "calendar_intake_delete_event",
  description: "根据 event ID、deletePreviewToken 或自然语言查询删除 Google Calendar 日程；若存在多个候选则返回冻结确认 token 供二次确认。",
  parameters: Type.Object({
    eventId: Type.Optional(Type.String()),
    deletePreviewToken: Type.Optional(Type.String()),
    queryText: Type.Optional(Type.String()),
    choiceId: Type.Optional(Type.String())
  }),
  async execute(_id: string, params: { eventId?: string; deletePreviewToken?: string; queryText?: string; choiceId?: string }) {
    const api = (this as any).api;
    const cfg = getConfig(api);
    assertPluginReady(cfg);

    let eventId = params.eventId;
    let deletePreview: DeletePreviewTokenPayload | undefined;

    if (!eventId && params.deletePreviewToken) {
      deletePreview = decodeDeletePreviewToken(params.deletePreviewToken);
      if (deletePreview.calendarId !== cfg.calendarId) {
        throw new Error("deletePreviewToken 对应的 calendarId 与当前插件配置不一致，请重新执行一次删除查询。");
      }
      eventId = deletePreview.event.id;
    }

    if (!eventId) {
      if (!params.queryText) {
        throw new Error("缺少 eventId、deletePreviewToken 或 queryText，无法删除日程。");
      }

      const { query, window, ranked, autoDeleteEventId } = await resolveFindEvents(cfg, params.queryText);
      if (autoDeleteEventId) {
        eventId = autoDeleteEventId;
      } else {
        const chosen = findCandidateByChoiceId(ranked, params.choiceId);
        const candidates = ranked.map((x) => ({
          ...x.event,
          score: x.score,
          choiceId: x.choiceId,
          deletePreviewToken: encodeDeletePreviewToken(cfg.calendarId, x)
        }));
        const selectedCandidate = chosen
          ? {
              ...chosen.event,
              score: chosen.score,
              choiceId: chosen.choiceId,
              deletePreviewToken: encodeDeletePreviewToken(cfg.calendarId, chosen)
            }
          : null;
        const text = ranked.length
          ? [
              "找到多个候选事项，暂不自动删除。",
              ...ranked.map((x) => `候选 ${x.choiceId} [score=${x.score.toFixed(1)}] ${describeEvent(x.event, cfg.timezone)}`),
              params.choiceId
                ? selectedCandidate
                  ? `已定位到你选择的候选 ${selectedCandidate.choiceId}，但为避免候选漂移，本次仍不会直接删除。请再次调用本工具，并传入该候选的 deletePreviewToken。`
                  : "未找到对应的 choiceId。请从当前候选里选择一个，并使用该候选附带的 deletePreviewToken 再次确认。"
                : "如需继续删除，请再次调用本工具，并传入对应候选的 deletePreviewToken。",
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
            selectedCandidate,
            candidates
          },
          content: [{ type: "text", text }]
        };
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
        deletedEvent: result.event,
        deletedViaPreviewToken: deletePreview != null
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
