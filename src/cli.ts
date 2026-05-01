#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

import process from "node:process";
import { ensureConfig, hasConfigFile, isExecutionMode, resolveConfigPath, saveConfig } from "./config.js";
import { WandConfig } from "./types.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  const configPath = resolveConfigPath(readFlagValue(args, "-c") || readFlagValue(args, "--config"));

  switch (command) {
    case "init": {
      await ensureRequiredFiles(configPath);
      break;
    }
    case "web": {
      const useTui = shouldUseTui();
      // web 命令下"已存在"的 ready 信息由统一的启动 banner / TUI 展示，避免重复。
      // "Created..." 这种首次创建事件仍会输出（ensureRequiredFiles 内部判断）。
      const config = await ensureRequiredFiles(configPath, { silentReady: true });
      const { ensureNodePtyHelperExecutable } = await import("./ensure-node-pty-helper.js");
      ensureNodePtyHelperExecutable();
      const { startServer } = await import("./server.js");
      const handle = await startServer(config, configPath);
      if (useTui) {
        const { startTui } = await import("./tui/index.js");
        const tui = startTui({
          processManager: handle.processManager,
          structuredSessions: handle.structuredSessions,
          version: handle.version,
          configPath: handle.configPath,
          dbPath: handle.dbPath,
          bindAddr: handle.bindAddr,
          httpsEnabled: handle.httpsEnabled,
          urls: handle.urls,
          orphanRecoveredCount: handle.orphanRecoveredCount,
          onExit: async () => {
            await handle.close();
            process.exit(0);
          },
        });
        const onSignal = () => { void tui.stop("signal"); };
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
      } else {
        printStartupBanner(handle);
      }
      break;
    }
    case "config:path": {
      process.stdout.write(`${configPath}\n`);
      break;
    }
    case "config:show": {
      const config = await ensureConfig(configPath);
      process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
      break;
    }
    case "config:set": {
      const key = args[1];
      const value = args[2];
      if (!key || typeof value === "undefined") {
        throw new Error("Usage: wand config:set <key> <value>");
      }

      const config = await ensureConfig(configPath);
      const nextConfig = setConfigValue(config, key, value);
      await saveConfig(configPath, nextConfig);
      process.stdout.write(`[wand] Updated ${key} in ${configPath}\n`);
      break;
    }
    case "help":
    default: {
      printHelp();
      break;
    }
  }
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function printHelp(): void {
  process.stdout.write(`wand <command>

Commands:
  wand init                 Create default files in ~/.wand/
  wand web                  Start web console server
  wand config:path          Print resolved config path
  wand config:show          Print current config
  wand config:set           Update a simple config value

Options:
  -c, --config <path>       Use a custom config file (default: ~/.wand/config.json)
`);
}

async function ensureRequiredFiles(
  configPath: string,
  opts: { silentReady?: boolean } = {}
): Promise<WandConfig> {
  const { ensureDatabaseFile, resolveDatabasePath } = await import("./storage.js");
  const dbPath = resolveDatabasePath(configPath);
  const hadConfig = hasConfigFile(configPath);
  const config = await ensureConfig(configPath);
  const createdDb = ensureDatabaseFile(dbPath);

  // 已存在的 ready 信息在 TUI 模式下由启动 banner 统一展示，此处静默；
  // 但 created 是首次创建事件，无论 TUI 与否都值得提示。
  if (!hadConfig) {
    process.stdout.write(`[wand] Created default config at ${configPath}\n`);
  } else if (!opts.silentReady) {
    process.stdout.write(`[wand] Config ready at ${configPath}\n`);
  }

  if (createdDb) {
    process.stdout.write(`[wand] Created SQLite database at ${dbPath}\n`);
  } else if (!opts.silentReady) {
    process.stdout.write(`[wand] SQLite database ready at ${dbPath}\n`);
  }

  return config;
}

function shouldUseTui(): boolean {
  if (process.env.WAND_NO_TUI) return false;
  if (!process.stdout.isTTY || !process.stderr.isTTY) return false;
  // Windows conhost 旧版渲染 box-drawing 不可靠；仅 Windows Terminal (WT_SESSION) 启用
  if (process.platform === "win32" && !process.env.WT_SESSION) return false;
  return true;
}

interface StartupBannerData {
  version: string;
  configPath: string;
  dbPath: string;
  bindAddr: string;
  urls: Array<{ url: string; scheme: "HTTP" | "HTTPS" }>;
  httpsEnabled: boolean;
  orphanRecoveredCount: number;
  processManager: { listSlim(): Array<{ status: string; archived: boolean }> };
  structuredSessions: { listSlim(): Array<{ status: string; archived: boolean }> };
}

function printStartupBanner(handle: StartupBannerData): void {
  const all = [...handle.processManager.listSlim(), ...handle.structuredSessions.listSlim()];
  let active = 0, archived = 0;
  for (const s of all) {
    if (s.archived) archived += 1;
    else if (s.status === "running") active += 1;
  }
  const scheme = handle.httpsEnabled ? "HTTPS" : "HTTP";
  const primary = handle.urls[0]?.url ?? `${handle.httpsEnabled ? "https" : "http"}://${handle.bindAddr}`;
  const orphan = handle.orphanRecoveredCount > 0
    ? ` (${handle.orphanRecoveredCount} orphan PTYs cleaned)`
    : "";
  const lines = [
    `[wand] wand v${handle.version} ready · ${primary} (${scheme})`,
    `       Bind     ${handle.bindAddr}`,
    `       Config   ${handle.configPath}`,
    `       Database ${handle.dbPath}`,
    `       Sessions ${active} active · ${archived} archived · ${all.length} total${orphan}`,
  ];
  for (const extra of handle.urls.slice(1)) {
    lines.splice(1, 0, `       URL      ${extra.url} (${extra.scheme})`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

function setConfigValue(
  config: WandConfig,
  key: string,
  value: string
): WandConfig {
  switch (key) {
    case "host":
    case "password":
    case "shell":
    case "defaultCwd":
      return {
        ...config,
        [key]: value
      };
    case "port":
      if (!/^\d+$/.test(value)) {
        throw new Error("port must be a positive integer");
      }
      return {
        ...config,
        port: Number(value)
      };
    case "defaultMode":
      if (!isExecutionMode(value)) {
        throw new Error(`defaultMode must be one of: assist, agent, agent-max, auto-edit, default, full-access, managed, native`);
      }
      return {
        ...config,
        defaultMode: value
      };
    case "https":
      if (value !== "true" && value !== "false") {
        throw new Error("https must be 'true' or 'false'");
      }
      return {
        ...config,
        https: value === "true"
      };
    default:
      throw new Error(`Unsupported config key: ${key}`);
  }
}

main().catch((error) => {
  process.stderr.write(`[wand] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
