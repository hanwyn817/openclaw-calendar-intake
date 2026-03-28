import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { Command } from "commander";
import { loadConfig, updateConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  applyPluginConfigToOpenClawConfig,
  buildDefaultPluginConfig,
  expandUserPath
} from "./config.js";
import { formatAuthStatus, getAuthStatus, inspectLocalAuthState } from "./google/auth.js";
import type { PluginConfig } from "./types.js";

type SetupAnswers = {
  credentialsPath: string;
  tokenPath: string;
  calendarId: string;
  timezone: string;
  lookaheadDays: number;
  lookbackDays: number;
  autoDeleteMode: PluginConfig["autoDeleteMode"];
  dedupeWindowMinutes: number;
};

function toPositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeAutoDeleteMode(
  value: string | undefined,
  fallback: PluginConfig["autoDeleteMode"]
): PluginConfig["autoDeleteMode"] {
  return value === "never" || value === "exact_only" || value === "heuristic"
    ? value
    : fallback;
}

async function promptWithDefault(
  rl: readline.Interface,
  label: string,
  defaultValue: string
): Promise<string> {
  const answer = (await rl.question(`${label} [${defaultValue}]: `)).trim();
  return answer || defaultValue;
}

export async function collectSetupAnswers(
  defaults: PluginConfig,
  options: Partial<SetupAnswers> & { yes?: boolean }
): Promise<PluginConfig> {
  const base = {
    credentialsPath: expandUserPath(options.credentialsPath ?? defaults.credentialsPath),
    tokenPath: expandUserPath(options.tokenPath ?? defaults.tokenPath),
    calendarId: options.calendarId ?? defaults.calendarId,
    timezone: options.timezone ?? defaults.timezone,
    lookaheadDays: options.lookaheadDays ?? defaults.lookaheadDays,
    lookbackDays: options.lookbackDays ?? defaults.lookbackDays,
    autoDeleteMode: options.autoDeleteMode ?? defaults.autoDeleteMode,
    dedupeWindowMinutes: options.dedupeWindowMinutes ?? defaults.dedupeWindowMinutes
  };

  if (options.yes) {
    const local = inspectLocalAuthState(base.credentialsPath, base.tokenPath);
    return {
      configured: true,
      authReady: local.credentialsValid && local.tokenValid,
      ...base
    };
  }

  const rl = readline.createInterface({ input, output });
  try {
    const credentialsPath = expandUserPath(
      await promptWithDefault(rl, "Google OAuth 凭据文件路径", base.credentialsPath)
    );
    const tokenPath = expandUserPath(
      await promptWithDefault(rl, "Google OAuth Token 保存路径", base.tokenPath)
    );
    const calendarId = await promptWithDefault(rl, "目标 Google Calendar ID", base.calendarId);
    const timezone = await promptWithDefault(rl, "默认时区", base.timezone);
    const lookaheadDays = toPositiveInt(
      await promptWithDefault(rl, "向未来搜索天数", String(base.lookaheadDays)),
      base.lookaheadDays
    );
    const lookbackDays = toPositiveInt(
      await promptWithDefault(rl, "向过去搜索天数", String(base.lookbackDays)),
      base.lookbackDays
    );
    const autoDeleteMode = normalizeAutoDeleteMode(
      await promptWithDefault(rl, "自动删除策略 (never/exact_only/heuristic)", base.autoDeleteMode),
      base.autoDeleteMode
    );
    const dedupeWindowMinutes = toPositiveInt(
      await promptWithDefault(rl, "去重时间窗口（分钟）", String(base.dedupeWindowMinutes)),
      base.dedupeWindowMinutes
    );
    const local = inspectLocalAuthState(credentialsPath, tokenPath);

    return {
      configured: true,
      authReady: local.credentialsValid && local.tokenValid,
      credentialsPath,
      tokenPath,
      calendarId,
      timezone,
      lookaheadDays,
      lookbackDays,
      autoDeleteMode,
      dedupeWindowMinutes
    };
  } finally {
    rl.close();
  }
}

export function formatSetupCompletionMessage(config: PluginConfig): string {
  return [
    "日历收件箱插件初始化完成。",
    `- credentialsPath: ${config.credentialsPath}`,
    `- tokenPath: ${config.tokenPath}`,
    `- calendarId: ${config.calendarId}`,
    `- timezone: ${config.timezone}`,
    `- lookaheadDays: ${config.lookaheadDays}`,
    `- lookbackDays: ${config.lookbackDays}`,
    `- autoDeleteMode: ${config.autoDeleteMode}`,
    `- dedupeWindowMinutes: ${config.dedupeWindowMinutes}`,
    `- authReady: ${config.authReady}`,
    "",
    "下一步：",
    "1. 把 Google OAuth Desktop app 的 credentials.json 放到上述 credentialsPath。",
    "2. 在 OpenClaw 对话中调用 calendar_intake_auth_init。",
    "3. 完成浏览器授权后，再调用 calendar_intake_auth_exchange。",
    "4. 执行 openclaw calendar-intake doctor，确认 authReady=true 后再正常使用插件技能。"
  ].join("\n");
}

export function registerCalendarIntakeCli(program: Command) {
  const root = program
    .command("calendar-intake")
    .description("日历收件箱插件的安装后配置与维护命令");

  root.command("setup")
    .description("初始化插件配置，支持一路回车接受默认值")
    .option("-y, --yes", "直接接受全部默认值完成初始化")
    .option("--credentials-path <path>", "Google OAuth 凭据文件路径")
    .option("--token-path <path>", "Google OAuth Token 保存路径")
    .option("--calendar-id <id>", "目标 Google Calendar ID")
    .option("--timezone <iana>", "默认时区")
    .option("--lookahead-days <days>", "向未来搜索天数")
    .option("--lookback-days <days>", "向过去搜索天数")
    .option("--auto-delete-mode <mode>", "自动删除策略：never / exact_only / heuristic")
    .option("--dedupe-window-minutes <minutes>", "去重时间窗口（分钟）")
    .action(async (options: {
      yes?: boolean;
      credentialsPath?: string;
      tokenPath?: string;
      calendarId?: string;
      timezone?: string;
      lookaheadDays?: string;
      lookbackDays?: string;
      autoDeleteMode?: PluginConfig["autoDeleteMode"];
      dedupeWindowMinutes?: string;
    }) => {
      const defaults = buildDefaultPluginConfig();
      const configured = await collectSetupAnswers(defaults, {
        yes: options.yes === true,
        credentialsPath: options.credentialsPath,
        tokenPath: options.tokenPath,
        calendarId: options.calendarId,
        timezone: options.timezone,
        lookaheadDays: options.lookaheadDays ? toPositiveInt(options.lookaheadDays, defaults.lookaheadDays) : undefined,
        lookbackDays: options.lookbackDays ? toPositiveInt(options.lookbackDays, defaults.lookbackDays) : undefined,
        autoDeleteMode: options.autoDeleteMode ? normalizeAutoDeleteMode(options.autoDeleteMode, defaults.autoDeleteMode) : undefined,
        dedupeWindowMinutes: options.dedupeWindowMinutes ? toPositiveInt(options.dedupeWindowMinutes, defaults.dedupeWindowMinutes) : undefined
      });

      await updateConfig((cfg) => applyPluginConfigToOpenClawConfig(cfg as Record<string, any>, configured));
      console.log(formatSetupCompletionMessage(configured));
    });

  root.command("doctor")
    .description("检查 credentials、token、calendarId 和 authReady 状态")
    .action(async () => {
      const rootConfig = await loadConfig();
      const current = ((rootConfig.plugins?.entries?.["calendar-intake"]?.config ?? {}) as Partial<PluginConfig>);
      const cfg = {
        ...buildDefaultPluginConfig(),
        ...current,
        credentialsPath: expandUserPath(current.credentialsPath ?? buildDefaultPluginConfig().credentialsPath),
        tokenPath: expandUserPath(current.tokenPath ?? buildDefaultPluginConfig().tokenPath)
      } satisfies PluginConfig;
      const status = await getAuthStatus(cfg.credentialsPath, cfg.tokenPath, cfg.calendarId, { setupComplete: cfg.configured });
      await updateConfig((rootConfig) => applyPluginConfigToOpenClawConfig(
        rootConfig as Record<string, any>,
        {
          ...cfg,
          authReady: status.authReady
        }
      ));
      console.log(formatAuthStatus(status));
    });
}
