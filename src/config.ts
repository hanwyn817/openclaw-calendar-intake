import os from "node:os";
import path from "node:path";
import type { PluginConfig } from "./types.js";

export const DEFAULT_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_CALENDAR_ID = "primary";
export const DEFAULT_LOOKAHEAD_DAYS = 30;
export const DEFAULT_LOOKBACK_DAYS = 7;
export const DEFAULT_AUTO_DELETE_MODE = "exact_only" as const;
export const DEFAULT_DEDUPE_WINDOW_MINUTES = 30;

export function defaultCredentialsPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".openclaw", "secrets", "google-calendar-credentials.json");
}

export function defaultTokenPath(homeDir = os.homedir()): string {
  return path.join(homeDir, ".openclaw", "secrets", "google-calendar-token.json");
}

export function buildDefaultPluginConfig(homeDir = os.homedir()): PluginConfig {
  return {
    configured: false,
    authReady: false,
    calendarId: DEFAULT_CALENDAR_ID,
    timezone: DEFAULT_TIMEZONE,
    tokenPath: defaultTokenPath(homeDir),
    credentialsPath: defaultCredentialsPath(homeDir),
    lookaheadDays: DEFAULT_LOOKAHEAD_DAYS,
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
    autoDeleteMode: DEFAULT_AUTO_DELETE_MODE,
    dedupeWindowMinutes: DEFAULT_DEDUPE_WINDOW_MINUTES
  };
}

export function isPluginConfigured(cfg: Partial<PluginConfig> | undefined): boolean {
  return cfg?.configured === true;
}

export function assertPluginConfigured(cfg: PluginConfig) {
  if (!cfg.configured) {
    throw new Error("插件尚未完成初始化，请先运行 `openclaw calendar-intake setup`。");
  }
}

export function assertPluginReady(cfg: PluginConfig) {
  assertPluginConfigured(cfg);
  if (!cfg.authReady) {
    throw new Error("Google Calendar 尚未完成授权或授权不可用，请先运行 `calendar_intake_auth_init` / `calendar_intake_auth_exchange`，或执行 `openclaw calendar-intake doctor` 检查配置。");
  }
}

export function expandUserPath(input: string): string {
  if (!input.trim()) {
    return input;
  }
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function applyPluginConfigToOpenClawConfig<T>(
  rootConfig: T,
  pluginConfig: PluginConfig
): T {
  const next = rootConfig as any;
  next.plugins ??= {};
  next.plugins.entries ??= {};
  next.plugins.entries["calendar-intake"] ??= {};
  next.plugins.entries["calendar-intake"].enabled = true;
  next.plugins.entries["calendar-intake"].config = {
    configured: pluginConfig.configured,
    authReady: pluginConfig.authReady,
    calendarId: pluginConfig.calendarId,
    timezone: pluginConfig.timezone,
    tokenPath: pluginConfig.tokenPath,
    credentialsPath: pluginConfig.credentialsPath,
    lookaheadDays: pluginConfig.lookaheadDays,
    lookbackDays: pluginConfig.lookbackDays,
    autoDeleteMode: pluginConfig.autoDeleteMode,
    dedupeWindowMinutes: pluginConfig.dedupeWindowMinutes
  };
  return next;
}

/**
 * 从 OpenClaw API 实例中读取插件配置。
 * 如果某些值缺失，则回退到插件清单中定义的默认值。
 *
 * @param api OpenClaw 插件 API 实例
 */
export function getConfig(api: any): PluginConfig {
  const defaults = buildDefaultPluginConfig();
  const cfg = ((api.pluginConfig ?? api.config) ?? {}) as Partial<PluginConfig>;
  return {
    configured: cfg.configured ?? defaults.configured,
    authReady: cfg.authReady ?? defaults.authReady,
    calendarId: cfg.calendarId ?? defaults.calendarId,
    timezone: cfg.timezone ?? defaults.timezone,
    tokenPath: expandUserPath(cfg.tokenPath ?? defaults.tokenPath),
    credentialsPath: expandUserPath(cfg.credentialsPath ?? defaults.credentialsPath),
    lookaheadDays: cfg.lookaheadDays ?? defaults.lookaheadDays,
    lookbackDays: cfg.lookbackDays ?? defaults.lookbackDays,
    autoDeleteMode: cfg.autoDeleteMode ?? defaults.autoDeleteMode,
    dedupeWindowMinutes: cfg.dedupeWindowMinutes ?? defaults.dedupeWindowMinutes
  };
}
