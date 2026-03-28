import { Type } from "@sinclair/typebox";
import { updateConfig } from "openclaw/plugin-sdk/config-runtime";
import { applyPluginConfigToOpenClawConfig } from "../config.js";
import { assertPluginConfigured, getConfig } from "../config.js";
import { authExchange } from "../google/auth.js";

export const authExchangeTool = {
  name: "calendar_intake_auth_exchange",
  description: "用授权 code 或回调 URL 换取并保存 Google Calendar token。",
  parameters: Type.Object({
    code: Type.String()
  }),
  async execute(_id: string, params: { code: string }) {
    const api = (this as any).api;
    const cfg = getConfig(api);
    assertPluginConfigured(cfg);
    const result = await authExchange(cfg.credentialsPath, cfg.tokenPath, params.code);
    await updateConfig((root) => applyPluginConfigToOpenClawConfig(
      root as Record<string, any>,
      {
        ...cfg,
        tokenReady: result.tokenReady === true,
        authReady: false
      }
    ));

    return {
      content: [
        {
          type: "text",
          text: `${result.message}\n\n当前仅表示 token 已保存；请继续执行 calendar_intake_auth_status 或 openclaw calendar-intake doctor，确认 authReady=true 后再正常使用插件技能。`
        }
      ]
    };
  }
};
