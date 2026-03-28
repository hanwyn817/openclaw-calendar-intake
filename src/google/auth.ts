import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";

type CredentialsJson = {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
};

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

type LocalAuthInspection = {
  credentialsExists: boolean;
  credentialsValid: boolean;
  tokenExists: boolean;
  tokenValid: boolean;
  tokenHasRefreshToken: boolean;
  redirectUri?: string;
  issues: string[];
};

export type AuthStatus = LocalAuthInspection & {
  setupComplete: boolean;
  authReady: boolean;
  calendarId: string;
  calendarAccessible: boolean;
  calendarSummary?: string;
  nextActions: string[];
};

function assertConfiguredPath(value: string, label: string) {
  if (!value.trim()) {
    throw new Error(`插件配置缺少 ${label}。`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`找不到文件：${filePath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`JSON 文件格式无效：${filePath}`);
    }
    throw error;
  }
}

function mapGoogleError(error: unknown, fallback: string): Error {
  const raw = error as Record<string, any> | undefined;
  const status = raw?.code ?? raw?.response?.status;
  const message = String(raw?.message ?? "");

  if (status === 401) {
    return new Error("Google 授权已失效或缺少 refresh token，请重新执行 `calendar_intake_auth_init` 和 `calendar_intake_auth_exchange`。");
  }
  if (status === 403) {
    return new Error("当前 Google 账号无权访问目标日历，请检查 calendarId 或共享权限。");
  }
  if (status === 404) {
    return new Error("目标 calendarId 不存在，或当前账号不可见。");
  }
  if (message.includes("invalid_grant")) {
    return new Error("授权 code 已过期或已被使用，请重新生成授权链接后再试。");
  }
  if (message.includes("No refresh token")) {
    return new Error("当前 token 缺少 refresh token，请重新执行授权流程。");
  }
  if (message.includes("ENOENT")) {
    return new Error(fallback);
  }
  return new Error(message || fallback);
}

function loadInstalledCredentials(credentialsPath: string): NonNullable<CredentialsJson["installed"]> {
  assertConfiguredPath(credentialsPath, "credentialsPath");
  const credentials = readJsonFile(credentialsPath) as CredentialsJson;
  const installed = credentials.installed;
  if (!installed) {
    throw new Error("credentials.json 缺少 installed 字段，建议使用 Desktop app OAuth client。");
  }
  if (!installed.redirect_uris?.length) {
    throw new Error("credentials.json 缺少 redirect_uris，请重新下载 Google OAuth Desktop app 凭据。");
  }
  return installed;
}

function inspectTokenFile(tokenPath: string) {
  const token = readJsonFile(tokenPath);
  if (!isRecord(token)) {
    throw new Error(`token 文件格式无效：${tokenPath}`);
  }

  return {
    valid: true,
    hasRefreshToken: typeof token.refresh_token === "string" && token.refresh_token.trim().length > 0
  };
}

export function inspectLocalAuthState(credentialsPath: string, tokenPath: string): LocalAuthInspection {
  const result: LocalAuthInspection = {
    credentialsExists: false,
    credentialsValid: false,
    tokenExists: false,
    tokenValid: false,
    tokenHasRefreshToken: false,
    issues: []
  };

  try {
    const installed = loadInstalledCredentials(credentialsPath);
    result.credentialsExists = true;
    result.credentialsValid = true;
    result.redirectUri = installed.redirect_uris[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.issues.push(`credentials: ${message}`);
    if (!message.startsWith("找不到文件")) {
      result.credentialsExists = fs.existsSync(credentialsPath);
    }
  }

  result.tokenExists = fs.existsSync(tokenPath);
  if (!result.tokenExists) {
    result.issues.push(`token: 找不到文件：${tokenPath}`);
    return result;
  }

  try {
    const token = inspectTokenFile(tokenPath);
    result.tokenValid = token.valid;
    result.tokenHasRefreshToken = token.hasRefreshToken;
    if (!token.hasRefreshToken) {
      result.issues.push("token: 缺少 refresh_token，后续 token 过期后无法自动续期。");
    }
  } catch (error) {
    result.issues.push(`token: ${error instanceof Error ? error.message : String(error)}`);
  }

  return result;
}

/**
 * 加载 OAuth2 客户端。
 * 如果 tokenPath 已存在已保存的 token，则一并读入。
 */
export async function loadOAuthClient(credentialsPath: string, tokenPath: string, requireToken = true) {
  try {
    assertConfiguredPath(tokenPath, "tokenPath");
    const installed = loadInstalledCredentials(credentialsPath);

    const client = new google.auth.OAuth2(
      installed.client_id,
      installed.client_secret,
      installed.redirect_uris[0]
    );

    if (fs.existsSync(tokenPath)) {
      client.setCredentials(readJsonFile(tokenPath) as Record<string, unknown>);
    } else if (requireToken) {
      throw new Error("尚未完成 Google OAuth 授权，请先运行 `calendar_intake_auth_init`，再执行 `calendar_intake_auth_exchange`。");
    }

    return client;
  } catch (error) {
    throw mapGoogleError(error, "无法加载 Google Calendar 授权配置，请检查 credentialsPath 和 tokenPath。");
  }
}

/**
 * 启动适合聊天场景的 OAuth 流程，返回授权链接和必要信息。
 */
export async function authInit(credentialsPath: string) {
  try {
    const installed = loadInstalledCredentials(credentialsPath);
    const client = new google.auth.OAuth2(
      installed.client_id,
      installed.client_secret,
      installed.redirect_uris[0]
    );
    const url = client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent"
    });

    return {
      ok: true,
      authUrl: url,
      redirectUri: installed.redirect_uris[0]
    };
  } catch (error) {
    throw mapGoogleError(error, "无法生成授权链接，请先确认 credentials.json 路径和内容。");
  }
}

export function normalizeAuthorizationCode(input: string): string {
  const value = input.trim();
  if (!value) {
    throw new Error("缺少授权 code。");
  }

  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    const code = url.searchParams.get("code");
    if (!code) {
      throw new Error("授权回调地址中没有 code 参数。");
    }
    return code;
  }

  return value;
}

export async function authExchange(credentialsPath: string, tokenPath: string, code: string) {
  try {
    assertConfiguredPath(tokenPath, "tokenPath");
    const installed = loadInstalledCredentials(credentialsPath);
    const client = new google.auth.OAuth2(
      installed.client_id,
      installed.client_secret,
      installed.redirect_uris[0]
    );

    const normalizedCode = normalizeAuthorizationCode(code);
    const { tokens } = await client.getToken(normalizedCode);
    client.setCredentials(tokens);

    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });

    return {
      ok: true,
      tokenReady: true,
      message: `授权成功，token 已保存到 ${tokenPath}`
    };
  } catch (error) {
    throw mapGoogleError(error, "授权失败，请重新生成授权链接后再试。");
  }
}

export async function getAuthStatus(
  credentialsPath: string,
  tokenPath: string,
  calendarId: string,
  options?: { setupComplete?: boolean }
): Promise<AuthStatus> {
  const local = inspectLocalAuthState(credentialsPath, tokenPath);
  const status: AuthStatus = {
    ...local,
    setupComplete: options?.setupComplete ?? true,
    authReady: false,
    calendarId,
    calendarAccessible: false,
    nextActions: []
  };

  if (!local.credentialsValid) {
    status.nextActions.push("确认 credentialsPath 指向 Google OAuth Desktop app 的 credentials.json。");
  }
  if (!local.tokenExists) {
    status.nextActions.push("运行 calendar_intake_auth_init，完成浏览器授权后再执行 calendar_intake_auth_exchange。");
  } else if (!local.tokenValid || !local.tokenHasRefreshToken) {
    status.nextActions.push("重新执行授权流程，确保保存下来的 token 包含 refresh_token。");
  }

  if (!local.credentialsValid || !local.tokenValid) {
    status.authReady = false;
    return status;
  }

  try {
    const auth = await loadOAuthClient(credentialsPath, tokenPath, true);
    const calendar = google.calendar({ version: "v3", auth });
    const res = await calendar.calendars.get({ calendarId });
    status.calendarAccessible = true;
    status.calendarSummary = res.data.summary ?? undefined;
    status.authReady = true;
  } catch (error) {
    const mapped = mapGoogleError(error, "无法访问目标 Google Calendar。");
    status.issues.push(`calendar: ${mapped.message}`);
    status.nextActions.push("检查 calendarId 是否正确，或把目标日历共享给当前授权账号。");
  }

  return status;
}

export function formatAuthStatus(status: AuthStatus): string {
  const lines = [
    `setup: ${status.setupComplete ? "ok" : "missing"}`,
    `credentials: ${status.credentialsValid ? "ok" : "invalid"}`,
    `token: ${status.tokenValid ? "ok" : "invalid"}`,
    `refreshToken: ${status.tokenHasRefreshToken ? "ok" : "missing"}`,
    `calendar: ${status.calendarAccessible ? `ok (${status.calendarSummary ?? status.calendarId})` : "unreachable"}`,
    `authReady: ${status.authReady ? "true" : "false"}`
  ];

  if (status.issues.length) {
    lines.push("", "问题：", ...status.issues.map((issue) => `- ${issue}`));
  }
  if (status.nextActions.length) {
    lines.push("", "下一步：", ...status.nextActions.map((step, index) => `${index + 1}. ${step}`));
  }

  return lines.join("\n");
}
