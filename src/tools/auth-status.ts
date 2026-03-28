import { Type } from "@sinclair/typebox";
import { updateConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  applyPluginConfigToOpenClawConfig,
  assertPluginConfigured,
  getConfig
} from "../config.js";
import { formatAuthStatus, getAuthStatus } from "../google/auth.js";

export const authStatusTool = {
  name: "calendar_intake_auth_status",
  description: "检查 Google Calendar 凭据、token 和目标日历是否可用。",
  parameters: Type.Object({}),
  async execute(_id: string, _params: {}) {
    const api = (this as any).api;
    const cfg = getConfig(api);
    assertPluginConfigured(cfg);

    const status = await getAuthStatus(
      cfg.credentialsPath,
      cfg.tokenPath,
      cfg.calendarId,
      { setupComplete: cfg.configured }
    );

    await updateConfig((root) => applyPluginConfigToOpenClawConfig(
      root as Record<string, any>,
      {
        ...cfg,
        tokenReady: status.tokenReady,
        authReady: status.authReady
      }
    ));

    return {
      structuredContent: status,
      content: [
        {
          type: "text",
          text: formatAuthStatus(status)
        }
      ]
    };
  }
};
