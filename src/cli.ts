#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

import process from "node:process";
import {
  hasConfigFile,
  isPreferenceKey,
  loadConfigWithStorage,
  resolveConfigPath,
  saveConfig,
  writePreferenceToStorage,
} from "./config.js";
import {
  PidInfo,
  readLiveInstance,
  removePidfile,
  removeSocketFile,
  socketPath,
  writePidfile,
} from "./pidfile.js";
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
      const config = await ensureRequiredFiles(configPath, { silentReady: true });

      // —— 单实例检测：如果已有 wand 主进程在跑，直接 attach 而不重启服务 ——
      const live = readLiveInstance(configPath);
      if (live) {
        await runAttach(live, configPath, useTui);
        break;
      }

      const { ensureNodePtyHelperExecutable } = await import("./ensure-node-pty-helper.js");
      ensureNodePtyHelperExecutable();
      const { startServer } = await import("./server.js");
      const handle = await startServer(config, configPath);

      // —— 注册实例：写 pidfile + 启动 IPC 服务端（TUI / banner 模式都需要） ——
      const startedAtMs = Date.now();
      const ipcCtx = await registerInstance(handle, configPath, startedAtMs);

      const cleanup = async (): Promise<void> => {
        try { await ipcCtx.close(); } catch { /* noop */ }
        removePidfile(configPath);
        removeSocketFile(configPath);
      };

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
            await cleanup();
            await handle.close();
            process.exit(0);
          },
        });
        const onSignal = () => { void tui.stop("signal"); };
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
      } else {
        printStartupBanner(handle);
        const onSignal = async () => {
          await cleanup();
          try { await handle.close(); } catch { /* noop */ }
          process.exit(0);
        };
        process.on("SIGINT", () => { void onSignal(); });
        process.on("SIGTERM", () => { void onSignal(); });
      }
      break;
    }
    case "config:path": {
      process.stdout.write(`${configPath}\n`);
      break;
    }
    case "config:show": {
      // 展示合并后的视图（JSON 部署字段 + DB 偏好字段）。
      const { ensureDatabaseFile, resolveDatabasePath, WandStorage } = await import("./storage.js");
      const dbPath = resolveDatabasePath(configPath);
      ensureDatabaseFile(dbPath);
      const storage = new WandStorage(dbPath);
      try {
        const config = await loadConfigWithStorage(configPath, storage);
        process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
      } finally {
        storage.close();
      }
      break;
    }
    case "config:set": {
      const key = args[1];
      const value = args[2];
      if (!key || typeof value === "undefined") {
        throw new Error("Usage: wand config:set <key> <value>");
      }

      const { ensureDatabaseFile, resolveDatabasePath, WandStorage } = await import("./storage.js");
      const dbPath = resolveDatabasePath(configPath);
      ensureDatabaseFile(dbPath);
      const storage = new WandStorage(dbPath);
      try {
        const config = await loadConfigWithStorage(configPath, storage);
        if (isPreferenceKey(key)) {
          // 偏好字段写 DB，无需重启
          writePreferenceToStorage(config, storage, key, value);
          process.stdout.write(`[wand] Updated preference ${key} in ${dbPath}\n`);
        } else {
          const nextConfig = setConfigValue(config, key, value);
          await saveConfig(configPath, nextConfig);
          process.stdout.write(`[wand] Updated ${key} in ${configPath}\n`);
        }
      } finally {
        storage.close();
      }
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
  wand web                  Start web console server (or attach to running one)
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
  const { ensureDatabaseFile, resolveDatabasePath, WandStorage } = await import("./storage.js");
  const dbPath = resolveDatabasePath(configPath);
  const hadConfig = hasConfigFile(configPath);
  // 先建 DB 文件，再加载 config（loadConfigWithStorage 需要 storage 来迁移老 JSON 偏好字段并应用 DB 覆盖）。
  const createdDb = ensureDatabaseFile(dbPath);
  const storage = new WandStorage(dbPath);
  let config: WandConfig;
  try {
    config = await loadConfigWithStorage(configPath, storage);
  } finally {
    storage.close();
  }

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

interface ServerHandleForBanner {
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

function printStartupBanner(handle: ServerHandleForBanner): void {
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

interface RegisteredInstance {
  close: () => Promise<void>;
}

interface FullServerHandle extends ServerHandleForBanner {
  processManager: any;
  structuredSessions: any;
  close: () => Promise<void>;
}

/** 写 pidfile + 启动 IPC 服务端。返回 cleanup 用的 close()。 */
async function registerInstance(
  handle: FullServerHandle,
  configPath: string,
  startedAtMs: number,
): Promise<RegisteredInstance> {
  const sockPath = socketPath(configPath);
  const primary = handle.urls[0];
  const pidInfo: PidInfo = {
    pid: process.pid,
    version: handle.version,
    startedAt: startedAtMs,
    url: primary ? primary.url : `${handle.httpsEnabled ? "https" : "http"}://${handle.bindAddr}`,
    scheme: primary ? primary.scheme : (handle.httpsEnabled ? "HTTPS" : "HTTP"),
    bindAddr: handle.bindAddr,
    configPath: handle.configPath,
    dbPath: handle.dbPath,
    socket: sockPath,
  };

  // Windows 不开 IPC，仍然写 pidfile（attach 模式会跳过，但能给运维查 PID）
  if (!sockPath) {
    writePidfile(configPath, pidInfo);
    return { close: async () => { /* noop */ } };
  }

  const { startIpcServer } = await import("./tui/ipc-server.js");
  const { buildSnapshotData } = await import("./tui/snapshot.js");

  const ipc = startIpcServer({
    socketPath: sockPath,
    snapshotProvider: () => buildSnapshotData({
      version: handle.version,
      url: pidInfo.url,
      scheme: pidInfo.scheme,
      bindAddr: handle.bindAddr,
      configPath: handle.configPath,
      dbPath: handle.dbPath,
      orphanRecoveredCount: handle.orphanRecoveredCount,
      startedAtMs,
      pid: process.pid,
      processManager: handle.processManager,
      structuredSessions: handle.structuredSessions,
    }),
    onShutdown: async () => {
      try { await handle.close(); } catch { /* noop */ }
      removePidfile(configPath);
      removeSocketFile(configPath);
      process.exit(0);
    },
  });

  writePidfile(configPath, pidInfo);

  return {
    close: async () => {
      try { await ipc?.close(); } catch { /* noop */ }
    },
  };
}

/** 进入 attach 模式。 */
async function runAttach(live: PidInfo, configPath: string, useTui: boolean): Promise<void> {
  if (!live.socket) {
    // Windows 没 socket：直接打印信息后退出
    process.stdout.write(
      `[wand] detected running instance pid=${live.pid} at ${live.url}\n` +
      `       attach mode requires unix socket which is unavailable on this platform\n`,
    );
    process.exit(0);
  }
  if (!useTui) {
    process.stdout.write(
      `[wand] running instance detected (pid=${live.pid}) at ${live.url}\n` +
      `       socket=${live.socket}\n` +
      `       use 'wand web' from a TTY to open the attach TUI\n`,
    );
    process.exit(0);
  }
  const { startAttachTui } = await import("./tui/attach.js");
  const tui = startAttachTui({
    pidInfo: live,
    configPath,
    onExit: async () => { process.exit(0); },
  });
  const onSignal = () => { void tui.stop(); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

function setConfigValue(
  config: WandConfig,
  key: string,
  value: string
): WandConfig {
  // 偏好字段（defaultMode/defaultCwd/...）由调用方分流到 storage，这里只处理 JSON 字段。
  switch (key) {
    case "host":
    case "password":
    case "shell":
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
