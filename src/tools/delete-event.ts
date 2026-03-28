import { Type } from "@sinclair/typebox";
import { assertPluginReady, getConfig } from "../config.js";
import { describeEvent, deleteEvent } from "../google/calendar.js";

/**
 * 工具：calendar_intake_delete_event
 *
 * 根据事项 ID 删除 Google Calendar 日程。
 */
export const deleteEventTool = {
  name: "calendar_intake_delete_event",
  description: "根据 event ID 删除 Google Calendar 日程。",
  parameters: Type.Object({
    eventId: Type.String()
  }),
  async execute(_id: string, params: { eventId: string }) {
    const api = (this as any).api;
    const cfg = getConfig(api);
    assertPluginReady(cfg);

    const result = await deleteEvent(
      cfg.credentialsPath,
      cfg.tokenPath,
      cfg.calendarId,
      params.eventId
    );

    return {
      structuredContent: {
        deletedEventId: params.eventId,
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
