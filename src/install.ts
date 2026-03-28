#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function hasPluginManifest(dir: string): boolean {
  return existsSync(path.join(dir, "openclaw.plugin.json"));
}

export function resolvePluginRoot(options: { cwd?: string; entryFile?: string } = {}): string {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (hasPluginManifest(cwd)) {
    return cwd;
  }

  const entryDir = path.dirname(options.entryFile ?? fileURLToPath(import.meta.url));
  const scriptRoot = path.resolve(entryDir, "..");
  if (hasPluginManifest(scriptRoot)) {
    return scriptRoot;
  }

  throw new Error(
    "未找到插件根目录：当前目录及脚本上级目录都不存在 `openclaw.plugin.json`。请在仓库根目录执行，或从构建后的 `dist/install.js` 运行。"
  );
}

function printUsage() {
  console.log([
    "用法：",
    "  npm install",
    "  npm run build",
    "  node dist/install.js install",
    "  node dist/install.js install --yes",
    "  node dist/install.js install --yes --restart"
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
  const pluginRoot = resolvePluginRoot();

  ensureOpenClawReady();
  console.log(`从本地仓库安装插件：${pluginRoot}`);
  runCommand("openclaw", ["plugins", "install", "-l", pluginRoot]);

  const setupArgs = ["calendar-intake", "setup"];
  if (yes) {
    setupArgs.push("--yes");
  }
  runCommand("openclaw", setupArgs);

  if (restart) {
    runCommand("openclaw", ["gateway", "restart"]);
  } else {
    console.log([
      "安装和初始化已完成。",
      "请执行 `openclaw gateway restart` 让插件生效。",
      "后续更新请在仓库目录执行：`git pull && npm install && npm run build && openclaw gateway restart`。"
    ].join("\n"));
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
