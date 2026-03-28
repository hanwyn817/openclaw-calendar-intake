import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerCalendarIntakeCli } from "./cli.js";
import { authInitTool } from "./tools/auth-init.js";
import { authExchangeTool } from "./tools/auth-exchange.js";
import { authStatusTool } from "./tools/auth-status.js";
import { createFromTextTool } from "./tools/create-from-text.js";
import { listEventsTool } from "./tools/list-events.js";
import { findEventsTool } from "./tools/find-events.js";
import { deleteEventTool } from "./tools/delete-event.js";

function bindTool(tool: any, api: any) {
  return {
    ...tool,
    async execute(id: string, params: unknown) {
      // 把 api 绑定到工具上下文里，便于工具内部读取插件配置。
      return tool.execute.call({ api }, id, params);
    }
  };
}

export default definePluginEntry({
  id: "calendar-intake",
  name: "日历收件箱",
  description: "解析粘贴的会议通知，并管理 Google Calendar 日程",
  register(api) {
    api.registerCli(({ program }) => {
      registerCalendarIntakeCli(program);
    }, { commands: ["calendar-intake"] });

    // 逐个注册已绑定 API 的工具。
    api.registerTool(bindTool(authInitTool, api));
    api.registerTool(bindTool(authExchangeTool, api));
    api.registerTool(bindTool(authStatusTool, api));
    api.registerTool(bindTool(createFromTextTool, api));
    api.registerTool(bindTool(listEventsTool, api));
    api.registerTool(bindTool(findEventsTool, api));
    api.registerTool(bindTool(deleteEventTool, api));
  }
});
