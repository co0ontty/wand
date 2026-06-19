#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
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
  isPidAlive,
  PidInfo,
  readLiveInstance,
  removePidfile,
  removeSocketFile,
  socketPath,
  writePidfile,
} from "./pidfile.js";
import { WandConfig } from "./types.js";
import { getErrorMessage } from "./error-utils.js";
import type { IpcResponse, IpcSnapshotData } from "./tui/ipc-protocol.js";

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
      const live = await discoverAttachableInstance(configPath);
      if (live) {
        await runAttach(live, configPath, useTui);
        break;
      }

      const { ensureNodePtyHelperExecutable } = await import("./ensure-node-pty-helper.js");
      ensureNodePtyHelperExecutable();
      const { isPortInUseError, startServer } = await import("./server.js");
      let handle: Awaited<ReturnType<typeof startServer>>;
      try {
        handle = await startServer(config, configPath);
      } catch (err) {
        if (isPortInUseError(err)) {
          if (await handlePortInUse(config, configPath, useTui)) {
            break;
          }
        }
        throw err;
      }

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
      // 展示合并后的视图（JSON 部署字段 + DB 偏好字段）。password 脱敏：
      // 显示是否已自定义（"<set>" / "change-me"），避免误把真密码截图分享出去；
      // 想看真值就直接读 DB（sqlite3 wand.db "SELECT * FROM app_config WHERE key='password'"）。
      const { ensureDatabaseFile, resolveDatabasePath, WandStorage } = await import("./storage.js");
      const dbPath = resolveDatabasePath(configPath);
      ensureDatabaseFile(dbPath);
      const storage = new WandStorage(dbPath);
      try {
        const config = await loadConfigWithStorage(configPath, storage);
        const display: WandConfig = {
          ...config,
          password: config.password === "change-me" ? "change-me" : "<set>",
        };
        process.stdout.write(`${JSON.stringify(display, null, 2)}\n`);
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
        } else if (key === "password") {
          // password 走 SQLite，和 Web UI 设置面板保持同一个源。
          // 历史上 setConfigValue("password") 只写 config.json，但登录用 dbPassword ?? config.password，
          // 一旦 DB 里有值，写 JSON 完全不生效，命令静默返回成功 → 用户以为改了密码其实没改。
          if (typeof value !== "string" || value.length < 6) {
            throw new Error("password 长度至少为 6 个字符");
          }
          storage.setPassword(value);
          process.stdout.write(`[wand] Updated password in ${dbPath}\n`);
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
    case "service:install":
    case "service:uninstall":
    case "service:start":
    case "service:stop":
    case "service:restart":
    case "service:status":
    case "service:logs": {
      const exitCode = await runServiceCommand(command, args, configPath);
      process.exitCode = exitCode;
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

System service (default = system-wide; pass --user for user-level):
  wand service:install      Register and start the background service (needs sudo for system)
  wand service:uninstall    Stop and remove the service
  wand service:start        Start the service
  wand service:stop         Stop the service
  wand service:restart      Restart the service
  wand service:status       Show service status
  wand service:logs         Tail recent service logs

Options:
  -c, --config <path>       Use a custom config file (default: ~/.wand/config.json)
  --user                    (service:*) Operate on the user-level service (no root needed)
  --system                  (service:*) Operate on the system-wide service (default; needs root)
  --verbose                 (service:*) Print full detail output
  --lines <N>               (service:logs) Number of log lines (default 80)
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

async function handlePortInUse(
  config: WandConfig,
  configPath: string,
  useTui: boolean,
): Promise<boolean> {
  const live = await discoverAttachableInstance(configPath);
  if (live) {
    await runAttach(live, configPath, useTui);
    return true;
  }

  const probe = await probeWandHttp(config);
  const pid = findListeningPid(config.port);
  if (probe?.isWand) {
    printDetectedWandWithoutAttach(config, configPath, probe.url, pid);
    process.exitCode = 0;
    return true;
  }

  printPortInUse(config, configPath, pid);
  process.exitCode = 1;
  return true;
}

async function discoverAttachableInstance(configPath: string): Promise<PidInfo | null> {
  const live = readLiveInstance(configPath);
  if (live) return live;

  const sockPath = socketPath(configPath);
  if (!sockPath || !existsSync(sockPath)) return null;

  const snapshot = await readIpcSnapshot(sockPath);
  if (!snapshot) return null;
  const pid = snapshot.header.pid;
  if (!isPidAlive(pid)) return null;

  return {
    pid,
    version: snapshot.header.version,
    startedAt: snapshot.header.startedAtMs,
    url: snapshot.header.url,
    scheme: snapshot.header.scheme,
    bindAddr: snapshot.header.bindAddr,
    configPath: snapshot.header.configPath,
    dbPath: snapshot.header.dbPath,
    socket: sockPath,
  };
}

function readIpcSnapshot(sockPath: string): Promise<IpcSnapshotData | null> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ path: sockPath });
    let buf = "";
    let finished = false;
    const finish = (value: IpcSnapshotData | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* noop */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 800);
    timer.unref?.();
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id: "probe", cmd: "snapshot" }) + "\n");
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: IpcResponse | null = null;
        try { msg = JSON.parse(line) as IpcResponse; } catch { continue; }
        if (msg?.id !== "probe" || !msg.ok) continue;
        const data = msg.data;
        if (isIpcSnapshotData(data)) {
          finish(data);
          return;
        }
      }
    });
    sock.on("error", () => finish(null));
    sock.on("close", () => finish(null));
  });
}

function isIpcSnapshotData(value: unknown): value is IpcSnapshotData {
  if (!value || typeof value !== "object") return false;
  const snap = value as Partial<IpcSnapshotData>;
  const header = snap.header as Partial<IpcSnapshotData["header"]> | undefined;
  return !!header
    && typeof header.pid === "number"
    && typeof header.version === "string"
    && typeof header.startedAtMs === "number"
    && typeof header.url === "string"
    && (header.scheme === "HTTP" || header.scheme === "HTTPS")
    && typeof header.bindAddr === "string"
    && typeof header.configPath === "string"
    && typeof header.dbPath === "string"
    && Array.isArray(snap.sessions);
}

interface WandHttpProbe {
  isWand: boolean;
  url: string;
}

async function probeWandHttp(config: WandConfig): Promise<WandHttpProbe | null> {
  const schemes = config.https ? ["https", "http"] : ["http", "https"];
  for (const scheme of schemes) {
    for (const host of probeHosts(config.host)) {
      const baseUrl = `${scheme}://${host}:${config.port}`;
      const sessionCheck = await requestText(`${baseUrl}/api/session-check`);
      if (sessionCheck && looksLikeWandSessionCheck(sessionCheck.body)) {
        return { isWand: true, url: baseUrl };
      }
      const home = await requestText(baseUrl);
      if (home && home.body.includes("<title>Wand Console</title>")) {
        return { isWand: true, url: baseUrl };
      }
    }
  }
  return null;
}

function probeHosts(configHost: string): string[] {
  const hosts = ["127.0.0.1", "localhost"];
  if (configHost && configHost !== "0.0.0.0" && configHost !== "::" && !hosts.includes(configHost)) {
    hosts.push(configHost);
  }
  return hosts;
}

function looksLikeWandSessionCheck(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { authed?: unknown };
    return typeof parsed.authed === "boolean";
  } catch {
    return false;
  }
}

function requestText(urlText: string): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      resolve(null);
      return;
    }
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: "GET",
        timeout: 800,
        rejectUnauthorized: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < 64 * 1024) body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

function findListeningPid(port: number): number | null {
  if (!Number.isInteger(port) || port <= 0) return null;
  try {
    const result = spawnSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", timeout: 1000 },
    );
    if (result.status !== 0 && !result.stdout) return null;
    const pid = (result.stdout || "")
      .split(/\s+/)
      .map((part) => Number(part.trim()))
      .find((value) => Number.isInteger(value) && value > 0 && value !== process.pid);
    return pid ?? null;
  } catch {
    return null;
  }
}

function printDetectedWandWithoutAttach(
  config: WandConfig,
  configPath: string,
  url: string,
  pid: number | null,
): void {
  const pidLine = pid ? `       PID      ${pid}\n` : "";
  process.stdout.write(
    `[wand] 检测到已有 Wand 服务正在运行：${url}\n` +
    pidLine +
    `       Config   ${configPath}\n` +
    `       Port     ${config.port}\n` +
    `       当前无法 attach：${socketPath(configPath) || "IPC socket"} 不可达。\n` +
    `       请重启一次正在运行的服务；之后再执行 wand web 会恢复正常 attach。\n`,
  );
}

function printPortInUse(config: WandConfig, configPath: string, pid: number | null): void {
  const pidHint = pid ? `\n       占用进程 PID: ${pid}` : "";
  const killHint = pid
    ? `kill ${pid}`
    : `kill $(lsof -ti :${config.port})`;
  process.stderr.write(
    `\n✗ [wand] 端口 ${config.port} 已被占用，但没有发现可 attach 的 Wand 实例。${pidHint}\n` +
    `       Config: ${configPath}\n` +
    `       Socket: ${socketPath(configPath) || "当前平台不支持 Unix socket"}\n\n` +
    `解决方法（二选一）：\n` +
    `1. 如果这是旧 Wand 服务，重启它后再运行 wand web\n` +
    `2. 如果不是 Wand，占用进程可用以下命令终止：\n   ${killHint}\n\n`,
  );
}

function setConfigValue(
  config: WandConfig,
  key: string,
  value: string
): WandConfig {
  // 偏好字段（defaultMode/defaultCwd/...）由调用方分流到 storage，password 也走 DB
  // （由 case "config:set" 直接处理），这里只剩纯 JSON 字段。
  switch (key) {
    case "host":
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

/**
 * 把 `wand service:*` 子命令路由到 src/tui/commands.ts 里已有的服务管理实现。
 *
 * 这里只做：把 CLI args → ServiceContext，调对应函数，把 CommandResult 打印出来，
 * 按 ok 决定 exit code。所有平台分支（Linux user-systemd / macOS launchd / 其他不支持）
 * 都在 tui/commands.ts 内部处理。
 */
async function runServiceCommand(
  command: string,
  args: string[],
  configPath: string,
): Promise<number> {
  const {
    installService,
    uninstallService,
    serviceStart,
    serviceStop,
    serviceRestart,
    serviceStatus,
    serviceLogs,
  } = await import("./tui/commands.js");

  const verbose = args.includes("--verbose");
  // --user / --system 决定 scope；不传走库里 default（= system）。
  // 同时传 --user 和 --system 时 --user 胜（更"友好"那一个不需要 root）。
  const wantUser = args.includes("--user");
  const wantSystem = args.includes("--system");
  const scope = wantUser ? "user" : (wantSystem ? "system" : undefined);

  switch (command) {
    case "service:install": {
      const result = installService({ configPath, scope });
      printServiceResult(result, verbose);
      if (result.ok && process.platform === "linux") {
        // 仅 user scope 才需要 linger 提示
        const installedScope = scope ?? "system";
        if (installedScope === "user") {
          process.stdout.write(
            "[wand] 想保持登出后也运行：loginctl enable-linger $USER\n",
          );
        }
      }
      return result.ok ? 0 : 1;
    }
    case "service:uninstall": {
      const result = uninstallService(scope ? { scope } : undefined);
      printServiceResult(result, verbose);
      return result.ok ? 0 : 1;
    }
    case "service:start": {
      const result = serviceStart(scope ? { scope } : undefined);
      printServiceResult(result, verbose);
      return result.ok ? 0 : 1;
    }
    case "service:stop": {
      const result = serviceStop(scope ? { scope } : undefined);
      printServiceResult(result, verbose);
      return result.ok ? 0 : 1;
    }
    case "service:restart": {
      const result = serviceRestart(scope ? { scope } : undefined);
      printServiceResult(result, verbose);
      return result.ok ? 0 : 1;
    }
    case "service:status": {
      const status = serviceStatus(scope ? { scope } : undefined);
      process.stdout.write(
        `[wand] ${status.installed ? "installed" : "not installed"} · ${status.state} · ${status.description}\n`,
      );
      if (verbose && status.raw) {
        process.stdout.write(status.raw + "\n");
      }
      return status.installed && status.state === "active" ? 0 : 1;
    }
    case "service:logs": {
      const linesArg = readFlagValue(args, "--lines");
      const lines = linesArg ? Math.max(1, Math.min(2000, Number(linesArg) || 80)) : 80;
      const result = serviceLogs(lines, scope ? { scope } : undefined);
      if (result.detail) {
        process.stdout.write(result.detail + "\n");
      } else {
        process.stdout.write(`[wand] ${result.message}\n`);
      }
      return result.ok ? 0 : 1;
    }
    default:
      process.stderr.write(`[wand] unknown service command: ${command}\n`);
      return 1;
  }
}

function printServiceResult(
  result: { ok: boolean; message: string; detail?: string },
  verbose: boolean,
): void {
  const prefix = result.ok ? "[wand]" : "[wand] ✗";
  process.stdout.write(`${prefix} ${result.message}\n`);
  if (verbose && result.detail) {
    process.stdout.write(result.detail + "\n");
  }
}

main().catch((error) => {
  process.stderr.write(`[wand] ${getErrorMessage(error)}\n`);
  process.exitCode = 1;
});
