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
      { ...cfg, authReady: result.tokenReady === true }
    ));

    return {
      content: [
        {
          type: "text",
          text: `${result.message}\n\n现在可以执行 calendar_intake_auth_status 或 openclaw calendar-intake doctor 复查授权状态。`
        }
      ]
    };
  }
};
