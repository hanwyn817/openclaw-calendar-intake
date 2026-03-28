#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "@hanwyn817/openclaw-calendar-intake";
export const MIN_OPENCLAW_VERSION = "2026.3.0";

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function validateOpenClawVersion(output: string): { ok: boolean; version?: string; reason?: string } {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  const version = match?.[1];
  if (!version) {
    return { ok: true };
  }
  if (compareVersions(version, MIN_OPENCLAW_VERSION) < 0) {
    return {
      ok: false,
      version,
      reason: `检测到 OpenClaw 版本 ${version}，低于所需的 ${MIN_OPENCLAW_VERSION}。`
    };
  }
  return { ok: true, version };
}

function runCommand(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32"
  });

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`命令执行失败：${command} ${args.join(" ")}`);
  }
}

function ensureOpenClawReady() {
  const result = spawnSync("openclaw", ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32"
  });

  if (result.error) {
    throw new Error("未检测到 OpenClaw CLI，请先安装并确保 `openclaw` 在 PATH 中可用。");
  }
  const validation = validateOpenClawVersion(result.stdout || result.stderr || "");
  if (!validation.ok) {
    throw new Error(validation.reason);
  }
}

function printUsage() {
  console.log([
    "用法：",
    "  npx @hanwyn817/openclaw-calendar-intake install",
    "  npx @hanwyn817/openclaw-calendar-intake install --yes",
    "  npx @hanwyn817/openclaw-calendar-intake install --restart"
  ].join("\n"));
}

export async function main(argv: string[]) {
  const [command = "install", ...rest] = argv;
  if (command !== "install") {
    printUsage();
    throw new Error(`不支持的命令：${command}`);
  }

  const yes = rest.includes("--yes");
  const restart = rest.includes("--restart");

  ensureOpenClawReady();
  runCommand("openclaw", ["plugins", "install", PACKAGE_NAME, "--pin"]);

  const setupArgs = ["calendar-intake", "setup"];
  if (yes) {
    setupArgs.push("--yes");
  }
  runCommand("openclaw", setupArgs);

  if (restart) {
    runCommand("openclaw", ["gateway", "restart"]);
  } else {
    console.log("安装和初始化已完成。请执行 `openclaw gateway restart` 让插件生效。");
  }
}

const entryPath = process.argv[1] ? fileURLToPath(import.meta.url) : "";
if (process.argv[1] === entryPath) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
