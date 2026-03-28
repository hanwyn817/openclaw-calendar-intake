import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import {
  applyPluginConfigToOpenClawConfig,
  buildDefaultPluginConfig,
  defaultCredentialsPath,
  defaultTokenPath,
  PLUGIN_ID,
  readPluginConfigFromOpenClawConfig
} from "../src/config.js";
import { normalizeAuthorizationCode } from "../src/google/auth.js";
import {
  MIN_OPENCLAW_VERSION,
  resolvePluginRoot,
  validateOpenClawVersion
} from "../src/install.js";
import { buildParsedEventPreview, parseEventFromText } from "../src/parser.js";
import { scoreEventMatch } from "../src/scoring.js";
import { formatSetupCompletionMessage } from "../src/cli.js";
import { autoDeleteCandidateId, buildFindQuery, findCandidateByChoiceId } from "../src/tools/find-events.js";
import { rangeToWindow } from "../src/tools/list-events.js";
import type { CalendarEventLite } from "../src/types.js";

const TIMEZONE = "Asia/Shanghai";

describe("parseEventFromText", () => {
  it("parses relative meeting time in Asia/Shanghai", () => {
    const event = parseEventFromText(
      "添加日程\n主题：供应商会议\n时间：明天下午3点到4点\n地点：腾讯会议",
      TIMEZONE,
      { now: "2026-03-27T09:00:00+08:00" }
    );

    expect(event.title).toBe("供应商会议");
    expect(event.start).toBe("2026-03-28T15:00:00+08:00");
    expect(event.end).toBe("2026-03-28T16:00:00+08:00");
    expect(event.allDay).toBe(false);
  });

  it("keeps date-only notices as all-day events", () => {
    const event = parseEventFromText(
      "添加日程\n主题：清明调休\n时间：2026/04/04",
      TIMEZONE,
      { now: "2026-03-27T09:00:00+08:00" }
    );

    expect(event.allDay).toBe(true);
    expect(event.start).toBe("2026-04-04");
    expect(event.end).toBe("2026-04-05");
  });
});

describe("buildParsedEventPreview", () => {
  it("auto-creates explicit date-only all-day events", () => {
    const preview = buildParsedEventPreview(
      "添加日程\n主题：放假\n时间：2026/04/04",
      TIMEZONE,
      { now: "2026-03-27T09:00:00+08:00" }
    );

    expect(preview.shouldAutoCreate).toBe(true);
    expect(preview.missingFields).toEqual([]);
    expect(preview.normalizedTimeText).toContain("全天");
  });

  it("asks for clarification when only a relative date is inferred from free text", () => {
    const preview = buildParsedEventPreview(
      "添加日程\n明天和供应商开会",
      TIMEZONE,
      { now: "2026-03-27T09:00:00+08:00" }
    );

    expect(preview.shouldAutoCreate).toBe(false);
    expect(preview.missingFields).toContain("time");
    expect(preview.clarificationPrompt).toContain("全天事项");
  });
});

describe("rangeToWindow", () => {
  it("uses Asia/Shanghai day boundaries", () => {
    const now = DateTime.fromISO("2026-03-27T00:30:00+08:00", { setZone: true });
    const today = rangeToWindow("today", TIMEZONE, now);

    expect(today.start).toBe("2026-03-27T00:00:00+08:00");
    expect(today.end).toBe("2026-03-27T23:59:59+08:00");
  });
});

describe("delete candidate heuristics", () => {
  it("selects a unique high-confidence candidate", () => {
    const query = buildFindQuery(
      "删除日程 供应商会议 明天下午3点",
      TIMEZONE,
      DateTime.fromISO("2026-03-27T09:00:00+08:00", { setZone: true })
    );

    const exact: CalendarEventLite = {
      id: "evt-1",
      summary: "供应商会议",
      start: { dateTime: "2026-03-28T15:00:00+08:00" }
    };
    const similar: CalendarEventLite = {
      id: "evt-2",
      summary: "供应商周会",
      start: { dateTime: "2026-03-29T15:00:00+08:00" }
    };

    const ranked = [exact, similar]
      .map((event) => ({ event, score: scoreEventMatch(query, event) }))
      .sort((a, b) => b.score - a.score);

    expect(autoDeleteCandidateId(query, ranked, "exact_only")).toBe("evt-1");
  });

  it("maps choiceId back to the selected candidate", () => {
    const ranked = [
      {
        choiceId: "C1",
        score: 88,
        event: {
          id: "evt-1",
          summary: "供应商会议",
          start: { dateTime: "2026-03-28T15:00:00+08:00" }
        }
      },
      {
        choiceId: "C2",
        score: 72,
        event: {
          id: "evt-2",
          summary: "供应商周会",
          start: { dateTime: "2026-03-29T15:00:00+08:00" }
        }
      }
    ];

    expect(findCandidateByChoiceId(ranked, "c2")?.event.id).toBe("evt-2");
    expect(findCandidateByChoiceId(ranked, "C9")).toBeUndefined();
  });
});

describe("normalizeAuthorizationCode", () => {
  it("extracts code from callback url", () => {
    expect(
      normalizeAuthorizationCode("https://localhost/?code=4/0Abc123&scope=calendar")
    ).toBe("4/0Abc123");
  });

  it("accepts a raw code", () => {
    expect(normalizeAuthorizationCode("4/0RawCode")).toBe("4/0RawCode");
  });
});

describe("setup defaults", () => {
  it("builds expected default plugin config", () => {
    const defaults = buildDefaultPluginConfig("/home/tester");

    expect(defaults.configured).toBe(false);
    expect(defaults.authReady).toBe(false);
    expect(defaults.credentialsPath).toBe(defaultCredentialsPath("/home/tester"));
    expect(defaults.tokenPath).toBe(defaultTokenPath("/home/tester"));
    expect(defaults.timezone).toBe("Asia/Shanghai");
    expect(defaults.autoDeleteMode).toBe("exact_only");
    expect(defaults.dedupeWindowMinutes).toBe(30);
  });

  it("writes plugin config to the canonical OpenClaw config entry", () => {
    const next = applyPluginConfigToOpenClawConfig(
      { plugins: { entries: { "calendar-intake": { enabled: true, config: { timezone: "UTC" } } } } },
      {
        configured: true,
        authReady: true,
        credentialsPath: "/root/.openclaw/secrets/google-calendar-credentials.json",
        tokenPath: "/root/.openclaw/secrets/google-calendar-token.json",
        calendarId: "primary",
        timezone: "Asia/Shanghai",
        lookaheadDays: 30,
        lookbackDays: 7,
        autoDeleteMode: "exact_only",
        dedupeWindowMinutes: 30
      }
    );

    expect(next.plugins.entries[PLUGIN_ID].enabled).toBe(true);
    expect(next.plugins.entries[PLUGIN_ID].config.configured).toBe(true);
    expect(next.plugins.entries[PLUGIN_ID].config.authReady).toBe(true);
    expect(next.plugins.entries[PLUGIN_ID].config.timezone).toBe("Asia/Shanghai");
    expect(next.plugins.entries["calendar-intake"]).toBeUndefined();
  });

  it("reads legacy config entries during migration", () => {
    const current = readPluginConfigFromOpenClawConfig({
      plugins: {
        entries: {
          "calendar-intake": {
            config: {
              configured: true,
              authReady: false,
              timezone: "Asia/Shanghai"
            }
          }
        }
      }
    });

    expect(current.configured).toBe(true);
    expect(current.authReady).toBe(false);
    expect(current.timezone).toBe("Asia/Shanghai");
  });

  it("prints OAuth next steps after setup", () => {
    const message = formatSetupCompletionMessage({
      configured: true,
      authReady: false,
      credentialsPath: "/tmp/credentials.json",
      tokenPath: "/tmp/token.json",
      calendarId: "primary",
      timezone: "Asia/Shanghai",
      lookaheadDays: 30,
      lookbackDays: 7,
      autoDeleteMode: "exact_only",
      dedupeWindowMinutes: 30
    });

    expect(message).toContain("calendar_intake_auth_init");
    expect(message).toContain("authReady");
    expect(message).toContain("/tmp/credentials.json");
  });
});

describe("installer checks", () => {
  it("accepts compatible OpenClaw versions", () => {
    expect(validateOpenClawVersion(`OpenClaw ${MIN_OPENCLAW_VERSION}`)).toEqual({
      ok: true,
      version: MIN_OPENCLAW_VERSION
    });
  });

  it("rejects too-old OpenClaw versions", () => {
    const result = validateOpenClawVersion("OpenClaw 2026.2.9");

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("低于所需");
  });

  it("prefers the current working directory when it contains the plugin manifest", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "calendar-intake-cwd-"));
    writeFileSync(path.join(cwd, "openclaw.plugin.json"), "{}");

    expect(resolvePluginRoot({ cwd, entryFile: "/tmp/dist/install.js" })).toBe(cwd);
  });

  it("falls back to the script parent directory when cwd is not the repo root", () => {
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), "calendar-intake-repo-"));
    const nestedCwd = path.join(repoRoot, "nested");
    const entryFile = path.join(repoRoot, "dist", "install.js");

    writeFileSync(path.join(repoRoot, "openclaw.plugin.json"), "{}");
    mkdirSync(nestedCwd);
    mkdirSync(path.dirname(entryFile));

    expect(resolvePluginRoot({ cwd: nestedCwd, entryFile })).toBe(repoRoot);
  });

  it("throws when no plugin manifest can be found", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "calendar-intake-missing-cwd-"));
    const entryDir = mkdtempSync(path.join(os.tmpdir(), "calendar-intake-missing-entry-"));
    const entryFile = path.join(entryDir, "dist", "install.js");

    mkdirSync(path.dirname(entryFile));

    expect(() => resolvePluginRoot({ cwd, entryFile })).toThrow("openclaw.plugin.json");
  });
});
