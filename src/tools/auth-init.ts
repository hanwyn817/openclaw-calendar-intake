import { Type } from "@sinclair/typebox";
import { assertPluginConfigured, getConfig } from "../config.js";
import { authInit } from "../google/auth.js";

/**
 * 工具：calendar_intake_auth_init
 *
 * 初始化适合聊天场景的 Google OAuth 授权流程。
 * 工具会返回一个浏览器授权链接；用户完成授权后，
 * 再把回调 URL 或 code 交给后续工具保存 token。
 */
export const authInitTool = {
  name: "calendar_intake_auth_init",
  description: "初始化 Google OAuth 授权，并返回浏览器授权链接。",
  parameters: Type.Object({}),
  async execute(_id: string, _params: {}) {
    const api = (this as any).api;
    const cfg = getConfig(api);
    assertPluginConfigured(cfg);

    const result = await authInit(cfg.credentialsPath);
    return {
      content: [
        {
          type: "text",
          text: [
            "请在本地浏览器打开以下 Google 授权链接：",
            result.authUrl,
            "",
            "完成授权后，把浏览器回调地址里的 code 参数，或整段回调 URL，发送给工具 calendar_intake_auth_exchange。",
            "授权完成后，建议再执行一次 calendar_intake_auth_status，确认 tokenReady=true 且 authReady=true。"
          ].join("\n")
        }
      ],
      structuredContent: result
    };
  }
};
