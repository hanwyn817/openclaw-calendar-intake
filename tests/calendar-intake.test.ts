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
import { scoreEventMatch } from "../src/scoring.js";
import { formatSetupCompletionMessage } from "../src/cli.js";
import { autoDeleteCandidateId, buildFindQuery, findCandidateByChoiceId } from "../src/tools/find-events.js";
import { applyExtractedOverrides, buildCreatePreview } from "../src/tools/create-from-text.js";
import { rangeToWindow } from "../src/tools/list-events.js";
import type { CalendarEventLite } from "../src/types.js";

const TIMEZONE = "Asia/Shanghai";

describe("buildCreatePreview", () => {
  it("builds a normalized event from structured extraction", () => {
    const preview = buildCreatePreview(
      {
        sourceText: "原始通知",
        title: "FDA产量上报相关培训",
        location: "313会议室",
        timeText: "2026年3月31日15:30-16:00",
        confidence: 0.92
      },
      TIMEZONE
    );

    expect(preview.shouldAutoCreate).toBe(true);
    expect(preview.parsedEvent?.title).toBe("FDA产量上报相关培训");
    expect(preview.parsedEvent?.start).toBe("2026-03-31T15:30:00+08:00");
    expect(preview.parsedEvent?.end).toBe("2026-03-31T16:00:00+08:00");
  });

  it("normalizes relative meeting times from extracted time text", () => {
    const preview = buildCreatePreview(
      {
        sourceText: "原始通知",
        title: "供应商会议",
        location: "腾讯会议",
        timeText: "明天下午13:10到14:10",
        confidence: 0.92
      },
      TIMEZONE
    );

    expect(preview.shouldAutoCreate).toBe(true);
    expect(preview.parsedEvent?.location).toBe("腾讯会议");
    expect(preview.parsedEvent?.allDay).toBe(false);
  });

  it("keeps explicit date-only inputs as all-day events", () => {
    const preview = buildCreatePreview(
      {
        sourceText: "原始通知",
        title: "清明调休",
        timeText: "2026/04/04",
        confidence: 0.92
      },
      TIMEZONE
    );

    expect(preview.shouldAutoCreate).toBe(true);
    expect(preview.parsedEvent?.allDay).toBe(true);
    expect(preview.parsedEvent?.start).toBe("2026-04-04");
    expect(preview.parsedEvent?.end).toBe("2026-04-05");
  });

  it("blocks auto-create when confidence is missing", () => {
    const preview = buildCreatePreview(
      {
        sourceText: "原始通知",
        title: "FDA产量上报相关培训",
        timeText: "2026年3月31日15:30-16:00"
      },
      TIMEZONE
    );

    expect(preview.shouldAutoCreate).toBe(false);
    expect(preview.blockReasons).toContain("missing_confidence");
  });

  it("blocks auto-create when issues are reported", () => {
    const preview = buildCreatePreview(
      {
        sourceText: "原始通知",
        title: "FDA产量上报相关培训",
        timeText: "2026年3月31日15:30-16:00",
        confidence: 0.92,
        issues: ["标题可能不完整"]
      },
      TIMEZONE
    );

    expect(preview.shouldAutoCreate).toBe(false);
    expect(preview.blockReasons).toContain("reported_issues");
  });

  it("blocks auto-create when time text is missing", () => {
    const preview = buildCreatePreview(
      {
        sourceText: "原始通知",
        title: "FDA产量上报相关培训",
        confidence: 0.92
      },
      TIMEZONE
    );

    expect(preview.shouldAutoCreate).toBe(false);
    expect(preview.blockReasons).toContain("missing_time");
  });

  it("blocks auto-create when time text cannot be normalized", () => {
    const preview = buildCreatePreview(
      {
        sourceText: "原始通知",
        title: "FDA产量上报相关培训",
        timeText: "下周找个时间",
        confidence: 0.92
      },
      TIMEZONE
    );

    expect(preview.shouldAutoCreate).toBe(false);
    expect(preview.blockReasons).toContain("unparseable_time");
  });

  it("supports structured training notices when extraction is correct", () => {
    const preview = buildCreatePreview(
      {
        sourceText: "@所有人 关于虫鼠控制及末端管控培训名单征集的通知：...",
        title: "虫鼠控制及末端管控培训",
        location: "702会议室",
        timeText: "2026年3月27（周五）14:00-15:00",
        confidence: 0.92
      },
      TIMEZONE
    );

    expect(preview.shouldAutoCreate).toBe(true);
    expect(preview.parsedEvent?.location).toBe("702会议室");
    expect(preview.parsedEvent?.start).toBe("2026-03-27T14:00:00+08:00");
    expect(preview.parsedEvent?.end).toBe("2026-03-27T15:00:00+08:00");
  });
});

describe("applyExtractedOverrides", () => {
  it("applies confirmed title and time corrections onto extracted input", () => {
    const extracted = applyExtractedOverrides(
      {
        sourceText: "原始通知",
        title: "如下",
        location: "313会议室",
        timeText: "2026年3月31日15:30-16:30",
        confidence: 0.4,
        issues: ["标题疑似错误", "时长疑似错误"]
      },
      {
        previewToken: "preview",
        titleOverride: "FDA产量上报相关培训",
        timeTextOverride: "2026年3月31日15:30-16:00"
      }
    );

    expect(extracted.title).toBe("FDA产量上报相关培训");
    expect(extracted.timeText).toBe("2026年3月31日15:30-16:00");
  });

  it("allows confirmed previews to bypass low-confidence auto-blocking", () => {
    const preview = buildCreatePreview(
      {
        sourceText: "原始通知",
        title: "FDA产量上报相关培训",
        timeText: "2026年3月31日15:30-16:00",
        confidence: 0.4,
        issues: ["标题疑似错误"]
      },
      TIMEZONE,
      "confirmed"
    );

    expect(preview.shouldAutoCreate).toBe(true);
    expect(preview.parsedEvent?.end).toBe("2026-03-31T16:00:00+08:00");
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
