/**
 * TUI 运维操作命令集合。
 *
 * 所有命令统一返回 CommandResult，UI 层负责把结果渲染到 toast / 弹窗 / 日志。
 * 命令本身不直接写 stdout / stderr —— TUI 模式下 stderr 已经被 log-bus 劫持。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  checkPackageUpdateSync,
  getInstallSpecForChannel,
  installPackageGloballySync,
  normalizeUpdateChannel,
  resolveGlobalWandBin,
  resolveGlobalWandCli,
  type UpdateChannel,
} from "../npm-update-utils.js";
import { whichSync } from "../path-repair.js";
import { computeRelaunch } from "../relaunch.js";
import { ensureDatabaseFile, resolveDatabasePath, WandStorage } from "../storage.js";
import { getErrorMessage } from "../error-utils.js";
import { readTerminalDaemonPid } from "../terminal-daemon-server.js";
import { terminalDaemonPaths } from "../terminal-daemon-protocol.js";
import { renderPaths } from "../render-protocol.js";
import { resolveRenderBinaryPath } from "../render-binary.js";
import { compareSemver } from "../version-utils.js";
import { isPidAlive } from "../pidfile.js";

export interface CommandResult {
  ok: boolean;
  /** 给用户看的简短状态行（一行）。 */
  message: string;
  /** 可选的详细输出（多行），供"详情"折叠展示。 */
  detail?: string;
}

// ─── 重启 ────────────────────────────────────────────────────────────────

/**
 * 重启当前进程。
 * 通过 spawn 一个 detached 子进程复用同一份 argv，然后退出父进程，
 * 让 systemd / 用户终端把控制权交给新进程。
 */
export function restartSelf(): CommandResult {
  try {
    const plan = computeRelaunch({
      serviceInstalled: isServiceInstalled(),
      globalCli: resolveGlobalWandCli(),
    });
    if (plan.mode === "exit-only") {
      // systemd 托管：仅退出，交给 Restart=always 用 unit 里的 ExecStart 拉起，
      // 避免再 spawn 一个 detached 子进程与 systemd 抢单实例 pidfile。
      setTimeout(() => process.exit(0), 200);
      return { ok: true, message: "重启中…交由 systemd 拉起" };
    }
    const child = spawn(process.execPath, [plan.bin ?? "", ...(plan.args ?? [])], {
      detached: true,
      stdio: "inherit",
      env: process.env,
    });
    child.unref();
    // 给个短延时让用户能在屏幕上看到"重启中…"
    setTimeout(() => {
      process.exit(0);
    }, 200);
    return { ok: true, message: "重启中…新进程已派生" };
  } catch (err) {
    return { ok: false, message: `重启失败: ${getErrorMessage(err)}` };
  }
}

// ─── 检查 / 安装更新 ────────────────────────────────────────────────────

export interface UpdateInfo {
  channel: UpdateChannel;
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  installSpec: string;
}

export function readUpdateChannel(configPath: string): UpdateChannel {
  const dbPath = resolveDatabasePath(configPath);
  ensureDatabaseFile(dbPath);
  const storage = new WandStorage(dbPath);
  try {
    return normalizeUpdateChannel(storage.getConfigValue("updateChannel"));
  } finally {
    storage.close();
  }
}

/** 通过 npm dist-tag 拿到当前通道最新版本号。失败返回 latest=null。 */
export function checkUpdate(currentVersion: string, channel: UpdateChannel = "stable"): UpdateInfo {
  const info = checkPackageUpdateSync(currentVersion, channel);
  return {
    channel: info.channel,
    current: info.current,
    latest: info.latest,
    hasUpdate: info.updateAvailable,
    installSpec: info.installSpec,
  };
}

/**
 * 执行 `npm install -g @co0ontty/wand@<dist-tag>`。
 *
 * 此调用同步阻塞（TUI 上层应在另一线程的 setImmediate 调度，或直接 await）。
 * 通过 npm-update-utils 自动处理 `.wand-XXXXXX` 残留目录和 ENOTEMPTY 回退，
 * 行为与 server.ts 的 /api/update / performAutoUpdate 保持一致。
 *
 * 返回 npm 输出供调试。
 */
export function installUpdate(channel: UpdateChannel = "stable"): CommandResult {
  const serviceSafety = checkInstalledServiceEntrypointsForUpdate();
  if (!serviceSafety.ok) return serviceSafety;
  const res = installPackageGloballySync(getInstallSpecForChannel(channel), 180_000);
  const out = (res.stdout || "") + (res.stderr ? "\n" + res.stderr : "");
  const trail = res.attempts.length > 1
    ? `\n\n尝试过的命令：\n  ${res.attempts.join("\n  ")}`
    : "";
  if (res.status === 0) {
    return {
      ok: true,
      message: "更新已安装。按 [R] 重启以生效。",
      detail: (out.trim() + trail).trim(),
    };
  }
  return {
    ok: false,
    message: `npm install 失败 (exit ${res.status})`,
    detail: (out.trim() + trail).trim(),
  };
}

// ─── 打开浏览器 ─────────────────────────────────────────────────────────

export function openInBrowser(url: string): CommandResult {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, message: `已在浏览器打开: ${url}` };
  } catch (err) {
    return { ok: false, message: `打开失败: ${getErrorMessage(err)}` };
  }
}

// ─── 复制到剪贴板 ───────────────────────────────────────────────────────

export function copyToClipboard(text: string): CommandResult {
  const candidates = clipboardCandidates();
  for (const c of candidates) {
    const res = spawnSync(c.cmd, c.args, { input: text, timeout: 5_000 });
    if (res.status === 0) {
      return { ok: true, message: `已复制到剪贴板 (${c.cmd})` };
    }
  }
  return {
    ok: false,
    message: "未找到可用的剪贴板工具 (pbcopy / xclip / wl-copy / clip)",
  };
}

function clipboardCandidates(): Array<{ cmd: string; args: string[] }> {
  if (process.platform === "darwin") return [{ cmd: "pbcopy", args: [] }];
  if (process.platform === "win32") return [{ cmd: "clip", args: [] }];
  // Linux：优先 wl-copy（Wayland），其次 xclip / xsel
  return [
    { cmd: "wl-copy", args: [] },
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] },
  ];
}

// ─── 系统服务（systemd system / user / launchd） ─────────────────────────

const LAUNCHD_LABEL = "com.wand.web";
const LAUNCHD_TERMINAL_LABEL = "com.wand.terminald";

/**
 * 服务安装的作用域：
 *   - "system" = Linux 写 /etc/systemd/system/wand.service；macOS 写 /Library/LaunchDaemons/
 *                需要 root，开机自启，所有用户可用，不依赖 login session。
 *   - "user"   = Linux 写 ~/.config/systemd/user/wand.service；macOS 写 ~/Library/LaunchAgents/
 *                不要 root，登出会被回收（除非 loginctl enable-linger）。
 *
 * 默认 system。
 */
export type ServiceScope = "system" | "user";
const DEFAULT_SERVICE_SCOPE: ServiceScope = "system";

export interface ServiceContext {
  configPath: string;
  /** wand 可执行文件路径。优先使用 process.argv[1]，回退到 which wand。 */
  wandBin?: string;
  /** 显式指定作用域。不传走 DEFAULT_SERVICE_SCOPE。 */
  scope?: ServiceScope;
  /**
   * 更新后自修复场景：优先把 ExecStart 钉到 npm 全局 wand shim，而不是
   * process.argv[1]。源码安装的用户更新到 npm/GitHub 版后，
   * argv[1] 仍是旧源码路径，沿用它会让重启跑回旧二进制。
   */
  preferGlobalBin?: boolean;
}

export interface ServiceOpts {
  /** 不传 = 自动检测已装的那个；都没装就用 default。 */
  scope?: ServiceScope;
}

/** 当前 process 是不是 root（POSIX）。Windows 永远返回 false。 */
function isRoot(): boolean {
  const fn = (process as unknown as { getuid?: () => number }).getuid;
  if (typeof fn !== "function") return false;
  try {
    return fn.call(process) === 0;
  } catch {
    return false;
  }
}

/** 自动检测哪个 scope 已经装了 unit；优先 system，找不到就 user。两个都没装返回 null。 */
export function detectInstalledScope(): ServiceScope | null {
  if (existsSync(servicePathFor("system"))) return "system";
  if (existsSync(servicePathFor("user"))) return "user";
  return null;
}

/** 给定一个 opts.scope，如果没传就按 detect → default 顺序回退。 */
function resolveScope(opts?: ServiceOpts): ServiceScope {
  if (opts?.scope) return opts.scope;
  return detectInstalledScope() ?? DEFAULT_SERVICE_SCOPE;
}

export function isServiceInstalled(scope?: ServiceScope): boolean {
  if (scope) return existsSync(servicePathFor(scope));
  return detectInstalledScope() !== null;
}

// ─── 服务状态 / 启停 / 日志 ──────────────────────────────────────────────

export interface ServiceStatus {
  /** 是否已安装服务文件。 */
  installed: boolean;
  /** active(running) / inactive / failed / unknown 等；解析自 systemctl/launchctl。 */
  state: "active" | "inactive" | "failed" | "loaded" | "unknown" | "unsupported";
  /** 给用户看的描述行（例如 "active (running) since Mon 2025-05-11 08:23:45 CST; 12min ago"）。 */
  description: string;
  /** 原始命令输出，供 Detail 面板展示。 */
  raw: string;
  /** 平台。 */
  platform: NodeJS.Platform;
}

export function serviceStatus(opts?: ServiceOpts): ServiceStatus {
  const scope = resolveScope(opts);
  if (process.platform === "linux") return systemdStatus(scope);
  if (process.platform === "darwin") return launchdStatus(scope);
  return {
    installed: false,
    state: "unsupported",
    description: `当前平台 ${process.platform} 不支持服务管理`,
    raw: "",
    platform: process.platform,
  };
}

export function serviceStart(opts?: ServiceOpts): CommandResult {
  const scope = resolveScope(opts);
  if (process.platform === "linux") return runSystemctl(scope, ["start", "wand.service"], "已启动");
  if (process.platform === "darwin") return launchctlLoad(scope);
  return unsupported();
}

export function serviceStop(opts?: ServiceOpts): CommandResult {
  const scope = resolveScope(opts);
  if (process.platform === "linux") return runSystemctl(scope, ["stop", "wand.service"], "已停止");
  if (process.platform === "darwin") return launchctlUnload(scope);
  return unsupported();
}

export function serviceRestart(opts?: ServiceOpts): CommandResult {
  const scope = resolveScope(opts);
  if (process.platform === "linux") return runSystemctl(scope, ["restart", "wand.service"], "已重启");
  if (process.platform === "darwin") return launchdRestart(scope);
  return unsupported();
}

/** 取最近 N 行服务日志。 */
export function serviceLogs(lines: number = 80, opts?: ServiceOpts): CommandResult {
  const scope = resolveScope(opts);
  if (process.platform === "linux") {
    const args = scope === "user"
      ? ["--user", "-u", "wand.service", "-n", String(lines), "--no-pager"]
      : ["-u", "wand.service", "-n", String(lines), "--no-pager"];
    const r = spawnSync("journalctl", args, { encoding: "utf8", timeout: 10_000 });
    if (r.status === 0) return { ok: true, message: `journalctl 输出 ${lines} 行`, detail: r.stdout.trim() };
    return { ok: false, message: "journalctl 调用失败", detail: r.stderr.trim() || `exit ${r.status}` };
  }
  if (process.platform === "darwin") {
    // plist 里配了 StandardOutPath/StandardErrorPath（见 installLaunchdService）。
    // 老安装没有这两项，退回到 Console.app 的提示。
    const configDir = readLaunchdConfigDir(scope);
    if (!configDir) {
      return {
        ok: false,
        message: "launchd 不直接写日志，请用 Console.app 或在 plist 里配置 StandardOutPath",
      };
    }
    const sections = ["web.log", "web-error.log"]
      .map((name) => ({ name, file: path.join(configDir, name) }))
      .filter(({ file }) => existsSync(file))
      .map(({ name, file }) => `--- ${name} ---\n${tailLines(file, lines)}`);
    if (sections.length === 0) {
      return {
        ok: false,
        message: `还没有日志文件（${configDir}/web.log、web-error.log）`,
        detail: "重新跑一次 `wand service:install` 让 plist 带上 StandardOutPath/StandardErrorPath",
      };
    }
    return { ok: true, message: `读取 ${configDir} 下的服务日志`, detail: sections.join("\n") };
  }
  return unsupported();
}

/** 从已安装的 plist 里读 config 路径（ProgramArguments 的第 5 项）；读不到返回 null。 */
function readLaunchdConfigDir(scope: ServiceScope): string | null {
  const plistPath = servicePathFor(scope);
  if (!existsSync(plistPath)) return null;
  const result = spawnSync(
    "plutil",
    ["-extract", "ProgramArguments.4", "raw", "-o", "-", plistPath],
    { encoding: "utf8", timeout: 5_000 },
  );
  const configPath = result.status === 0 ? (result.stdout || "").trim() : "";
  return configPath ? path.dirname(path.resolve(configPath)) : null;
}

/** 文件末尾 N 行（整个文件读进内存：服务日志本来就是小文件）。 */
function tailLines(filePath: string, lines: number): string {
  try {
    const all = readFileSync(filePath, "utf8").split("\n");
    return all.slice(Math.max(0, all.length - lines)).join("\n").trim();
  } catch (error) {
    return `读取失败：${getErrorMessage(error)}`;
  }
}

/** systemctl 调用根据 scope 决定要不要 --user。system scope 也意味着调用方需要 root。 */
function systemctlBaseArgs(scope: ServiceScope): string[] {
  return scope === "user" ? ["--user"] : [];
}

function systemdStatus(scope: ServiceScope): ServiceStatus {
  const installed = isServiceInstalled(scope);
  if (!installed) {
    return {
      installed: false,
      state: "unknown",
      description: `未安装 (${scope} scope)`,
      raw: "",
      platform: "linux",
    };
  }
  const base = systemctlBaseArgs(scope);
  // 用 `is-active` + `show -p ...` 拿结构化数据
  const active = spawnSync("systemctl", [...base, "is-active", "wand.service"], { encoding: "utf8" });
  const stateRaw = (active.stdout || "").trim();
  const show = spawnSync(
    "systemctl",
    [
      ...base,
      "show",
      "wand.service",
      "-p",
      "ActiveState",
      "-p",
      "SubState",
      "-p",
      "ActiveEnterTimestamp",
      "-p",
      "MainPID",
    ],
    { encoding: "utf8" },
  );
  const props = parseSystemctlShow(show.stdout || "");
  const status = spawnSync("systemctl", [...base, "status", "wand.service", "--no-pager", "-n", "5"], {
    encoding: "utf8",
  });
  const sub = props.SubState || stateRaw;
  const since = props.ActiveEnterTimestamp ? ` since ${props.ActiveEnterTimestamp}` : "";
  const pid = props.MainPID && props.MainPID !== "0" ? ` · PID ${props.MainPID}` : "";
  const desc = `[${scope}] ${stateRaw}${sub ? ` (${sub})` : ""}${since}${pid}`;

  let normalized: ServiceStatus["state"] = "unknown";
  if (stateRaw === "active") normalized = "active";
  else if (stateRaw === "inactive") normalized = "inactive";
  else if (stateRaw === "failed") normalized = "failed";
  else if (stateRaw === "activating" || stateRaw === "reloading") normalized = "active";

  return {
    installed: true,
    state: normalized,
    description: desc,
    raw: status.stdout || status.stderr || "",
    platform: "linux",
  };
}

function launchdStatus(scope: ServiceScope): ServiceStatus {
  const installed = isServiceInstalled(scope);
  if (!installed) {
    return {
      installed: false,
      state: "unknown",
      description: `未安装 (${scope} scope)`,
      raw: "",
      platform: "darwin",
    };
  }
  const target = launchdTarget(scope);
  const printed = spawnSync("launchctl", ["print", target], { encoding: "utf8", timeout: 10_000 });
  if (printed.status !== 0) {
    return {
      installed: true,
      state: "inactive",
      description: `[${scope}] installed 但未 bootstrap · ${target}`,
      raw: ((printed.stdout || "") + "\n" + (printed.stderr || "")).trim(),
      platform: "darwin",
    };
  }
  const text = printed.stdout || "";
  const state = matchLaunchdField(text, "state") || "loaded";
  const pid = Number(matchLaunchdField(text, "pid") || "0");
  const lastExit = matchLaunchdField(text, "last exit code");
  const normalized: ServiceStatus["state"] = pid > 0 || state === "running"
    ? "active"
    : state === "failed"
      ? "failed"
      : "inactive";
  const tail = pid > 0
    ? ` · PID ${pid}`
    : lastExit
      ? ` · last exit ${lastExit}`
      : "";
  const desc = `[${scope}] ${state}${tail} · ${target}`;
  return {
    installed: true,
    state: normalized,
    description: desc,
    raw: text,
    platform: "darwin",
  };
}

function runSystemctl(scope: ServiceScope, args: string[], successWord: string): CommandResult {
  const base = systemctlBaseArgs(scope);
  const r = spawnSync("systemctl", [...base, ...args], { encoding: "utf8", timeout: 15_000 });
  const scopeLabel = scope === "user" ? "--user " : "";
  if (r.status === 0) {
    return { ok: true, message: `systemctl ${scopeLabel}${args.join(" ")} ${successWord}` };
  }
  // system scope 没拿到 root 是最常见错误，给一个明确提示
  const stderr = (r.stderr || "").trim();
  const hint = scope === "system" && !isRoot()
    ? "\n提示: 系统级服务操作需要 root，请用 sudo 重试。"
    : "";
  return {
    ok: false,
    message: `systemctl ${scopeLabel}${args.join(" ")} 失败 (exit ${r.status})`,
    detail: ((r.stdout || "") + "\n" + stderr + hint).trim(),
  };
}

function launchctlLoad(scope: ServiceScope): CommandResult {
  const plist = servicePathFor(scope);
  if (!existsSync(plist)) return { ok: false, message: `未安装 (${plist} 不存在)` };
  return launchdBootstrap(scope, plist, `已启动 launchd ${scope}`);
}

function launchctlUnload(scope: ServiceScope): CommandResult {
  const plist = servicePathFor(scope);
  if (!existsSync(plist)) return { ok: false, message: `未安装 (${plist} 不存在)` };
  return launchdBootout(scope, plist, `已停止 launchd ${scope}`);
}

function launchdRestart(scope: ServiceScope): CommandResult {
  const target = launchdTarget(scope);
  const kicked = spawnSync("launchctl", ["kickstart", "-k", target], { encoding: "utf8", timeout: 10_000 });
  if (kicked.status === 0) return { ok: true, message: `已重启 launchd ${scope}: ${target}` };

  const started = launchctlLoad(scope);
  if (started.ok) return { ok: true, message: `已 bootstrap 并启动 launchd ${scope}: ${target}` };
  return {
    ok: false,
    message: `launchd 重启失败 (${target})`,
    detail: [
      `kickstart: ${formatSpawnResult(kicked)}`,
      `bootstrap: ${started.message}`,
      started.detail ?? "",
    ].filter(Boolean).join("\n"),
  };
}

function launchdDomain(scope: ServiceScope): string {
  return scope === "user" ? `gui/${currentUid()}` : "system";
}

function launchdTarget(scope: ServiceScope, label = LAUNCHD_LABEL): string {
  return `${launchdDomain(scope)}/${label}`;
}

function currentUid(): number {
  const fn = (process as unknown as { getuid?: () => number }).getuid;
  if (typeof fn === "function") {
    try { return fn.call(process); } catch { /* fall through */ }
  }
  const id = spawnSync("id", ["-u"], { encoding: "utf8", timeout: 3000 });
  const uid = Number((id.stdout || "").trim());
  return Number.isInteger(uid) && uid >= 0 ? uid : 0;
}

function matchLaunchdField(text: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^\\s*${escaped} = (.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

const LAUNCHD_POLL_INTERVAL_MS = 100;

function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, ms);
}

function waitForLaunchdCondition(check: () => boolean, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    sleepSync(Math.min(LAUNCHD_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
}

function launchdTargetIsLoaded(scope: ServiceScope, label = LAUNCHD_LABEL): boolean {
  const printed = spawnSync("launchctl", ["print", launchdTarget(scope, label)], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return printed.status === 0;
}

function waitForLaunchdTarget(scope: ServiceScope, loaded: boolean, timeoutMs: number, label = LAUNCHD_LABEL): boolean {
  return waitForLaunchdCondition(() => launchdTargetIsLoaded(scope, label) === loaded, timeoutMs);
}

function waitForLaunchdActive(scope: ServiceScope, timeoutMs: number, label = LAUNCHD_LABEL): boolean {
  return waitForLaunchdCondition(() => {
    const printed = spawnSync("launchctl", ["print", launchdTarget(scope, label)], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (printed.status !== 0) return false;
    const text = printed.stdout || "";
    return Number(matchLaunchdField(text, "pid") || "0") > 0
      || matchLaunchdField(text, "state") === "running";
  }, timeoutMs);
}

function launchdBootstrap(scope: ServiceScope, plist: string, successMessage: string, label = LAUNCHD_LABEL): CommandResult {
  const domain = launchdDomain(scope);
  const target = launchdTarget(scope, label);
  const bootout = spawnSync("launchctl", ["bootout", domain, plist], { encoding: "utf8", timeout: 10_000 });
  const detail: string[] = [
    `target: ${target}`,
    `bootout: ${formatSpawnResult(bootout)}`,
  ];

  // launchctl can return before the old job has fully disappeared. Starting a
  // new job in that window often produces the unhelpful "Bootstrap failed: 5"
  // error even though the plist is valid.
  if (!waitForLaunchdTarget(scope, false, 2_000, label)) {
    return {
      ok: false,
      message: `launchctl bootout 未生效 (${target})`,
      detail: detail.join("\n"),
    };
  }

  const bootstrapAttempts: Array<ReturnType<typeof spawnSync>> = [];
  let loaded = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const bootstrap = spawnSync("launchctl", ["bootstrap", domain, plist], {
      encoding: "utf8",
      timeout: 10_000,
    });
    bootstrapAttempts.push(bootstrap);
    loaded = waitForLaunchdTarget(scope, true, 750, label);
    if (loaded) break;
    if (!launchdIsTransientBootstrapFailure(bootstrap)) break;
    sleepSync(250);
  }
  detail.push(...bootstrapAttempts.map((result, index) =>
    `bootstrap${bootstrapAttempts.length > 1 ? ` #${index + 1}` : ""}: ${formatSpawnResult(result)}`
  ));

  if (!loaded) {
    return { ok: false, message: `launchctl bootstrap 失败 (${target})`, detail: detail.join("\n") };
  }

  const enable = spawnSync("launchctl", ["enable", target], { encoding: "utf8", timeout: 10_000 });
  detail.push(`enable: ${formatSpawnResult(enable)}`);
  if (enable.status !== 0) {
    return { ok: false, message: `launchctl enable 失败 (${target})`, detail: detail.join("\n") };
  }

  // RunAtLoad normally starts a freshly bootstrapped job. Avoid immediately
  // killing that still-starting process with kickstart -k; only kick an idle
  // job after giving launchd a short settling window.
  if (waitForLaunchdActive(scope, 2_000, label)) {
    detail.push("kickstart: skipped (already active)");
    return { ok: true, message: successMessage, detail: detail.join("\n") };
  }

  const kickstart = spawnSync("launchctl", ["kickstart", target], { encoding: "utf8", timeout: 10_000 });
  detail.push(`kickstart: ${formatSpawnResult(kickstart)}`);
  if (!waitForLaunchdActive(scope, 2_000, label)) {
    return { ok: false, message: `launchctl kickstart 失败 (${target})`, detail: detail.join("\n") };
  }
  return { ok: true, message: successMessage, detail: detail.join("\n") };
}

function launchdBootout(scope: ServiceScope, plist: string, successMessage: string, label = LAUNCHD_LABEL): CommandResult {
  const domain = launchdDomain(scope);
  const target = launchdTarget(scope, label);
  const bootout = spawnSync("launchctl", ["bootout", domain, plist], { encoding: "utf8", timeout: 10_000 });
  if (waitForLaunchdTarget(scope, false, 2_000, label)) {
    return {
      ok: true,
      message: successMessage,
      detail: `target: ${target}\nbootout: ${formatSpawnResult(bootout)}`,
    };
  }
  return {
    ok: false,
    message: `launchctl bootout 失败 (${target})`,
    detail: formatSpawnResult(bootout),
  };
}

function launchdIsTransientBootstrapFailure(result: ReturnType<typeof spawnSync>): boolean {
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  return /Bootstrap failed:\s*(?:5|37)|Input\/output error|resource busy|operation (?:now |in )?progress/i.test(text);
}

function formatSpawnResult(result: ReturnType<typeof spawnSync>): string {
  const text = ((result.stdout || "") + "\n" + (result.stderr || "")).trim();
  return result.status === 0
    ? "ok"
    : `failed (${text || `exit ${result.status}`})`;
}

function unsupported(): CommandResult {
  return { ok: false, message: `当前平台 ${process.platform} 不支持服务管理` };
}

function parseSystemctlShow(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return out;
}

export function installService(ctx: ServiceContext): CommandResult {
  const scope = ctx.scope ?? DEFAULT_SERVICE_SCOPE;
  // system scope 需要 root（除了 Windows，那里两个都不支持）
  if (scope === "system" && !isRoot() && process.platform !== "win32") {
    return {
      ok: false,
      message: "系统级服务安装需要 root 权限",
      detail: "请用 sudo 重跑，或传 --user 走用户级安装（不需要 root）。",
    };
  }
  if (process.platform === "linux") return installSystemdService(ctx, scope);
  if (process.platform === "darwin") return installLaunchdService(ctx, scope);
  return { ok: false, message: `当前平台 ${process.platform} 暂不支持服务注册` };
}

export function uninstallService(opts?: ServiceOpts): CommandResult {
  const scope = resolveScope(opts);
  if (scope === "system" && !isRoot() && process.platform !== "win32") {
    return {
      ok: false,
      message: "系统级服务卸载需要 root 权限",
      detail: "请用 sudo 重跑。",
    };
  }
  if (process.platform === "linux") return uninstallSystemdService(scope);
  if (process.platform === "darwin") return uninstallLaunchdService(scope);
  return { ok: false, message: `当前平台 ${process.platform} 暂不支持服务注册` };
}

function servicePathFor(scope: ServiceScope): string {
  if (process.platform === "linux") {
    return scope === "user"
      ? path.join(os.homedir(), ".config/systemd/user/wand.service")
      : "/etc/systemd/system/wand.service";
  }
  if (process.platform === "darwin") {
    return scope === "user"
      ? path.join(os.homedir(), "Library/LaunchAgents/com.wand.web.plist")
      : "/Library/LaunchDaemons/com.wand.web.plist";
  }
  return "";
}

function terminalServicePathFor(scope: ServiceScope): string {
  if (process.platform === "linux") {
    return scope === "user"
      ? path.join(os.homedir(), ".config/systemd/user/wand-terminald.service")
      : "/etc/systemd/system/wand-terminald.service";
  }
  if (process.platform === "darwin") {
    return scope === "user"
      ? path.join(os.homedir(), "Library/LaunchAgents/com.wand.terminald.plist")
      : "/Library/LaunchDaemons/com.wand.terminald.plist";
  }
  return "";
}

/**
 * 本 config 的 config 文件 owner uid。
 *
 * daemon 在 unit/plist 里被钉成 config owner，端点路径里的 uid 也是它；而
 * `wand service:install` 常常是 sudo 跑的（uid 0），所以任何涉及 daemon 文件的读取
 * 都必须用这个 uid，不能用调用者的。
 */
function configOwnerUid(configPath: string): number | undefined {
  try { return statUid(path.resolve(configPath)); } catch { return undefined; }
}

function hasLiveTerminalDaemon(configPath: string): boolean {
  const pid = readTerminalDaemonPid(configPath, configOwnerUid(configPath));
  return pid !== null && isPidAlive(pid);
}

/** 一个常驻 daemon 的端点状态（排查「终端全断」的第一手证据）。 */
interface DaemonEndpointState {
  label: string;
  kind: "render" | "terminald";
  pid: number | null;
  pidAlive: boolean;
  socketPath: string;
  socketExists: boolean;
}

/** 按 config 派生两套 daemon 的端点（socket 在 /tmp、pid 在 config 目录旁边）。
 *
 * uid 用 **config 文件 owner** 的，不是调用者的：`wand service:install` 常常是 sudo 跑的，
 * 而 daemon 在 unit/plist 里被钉成 config owner。用调用者的 uid 会算出 `-0-` 这种不存在的
 * 端点，把健康 daemon 当成僵尸（2026-09-24 真实发生过，两个 daemon 被误杀）。
 */
function daemonEndpointStates(configPath: string): DaemonEndpointState[] {
  const ownerUid = configOwnerUid(configPath);
  const render = renderPaths(configPath, ownerUid);
  const terminal = terminalDaemonPaths(configPath, ownerUid);
  const endpoints: Array<{ label: string; kind: "render" | "terminald"; pidPath: string; socketPath: string }> = [
    { label: "Render", kind: "render", pidPath: render.pidPath, socketPath: render.socketPath },
    { label: "terminald", kind: "terminald", pidPath: terminal.pidPath, socketPath: terminal.socketPath },
  ];
  return endpoints.map(({ label, kind, pidPath, socketPath }) => {
    const pid = readDaemonPidFile(pidPath);
    return {
      label,
      kind,
      pid,
      pidAlive: pid !== null && isPidAlive(pid),
      socketPath,
      socketExists: existsSync(socketPath),
    };
  });
}

function readDaemonPidFile(pidPath: string): number | null {
  try {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * 清掉「进程活着但端点没了」的僵尸 daemon。
 *
 * 这种 daemon 对任何客户端都已不可达（`/tmp` 下的 socket 文件被临时目录清理器删掉，
 * 它抱着一个已经无名的 inode），却会让 `wand web` 启动判定「pid 活着但 socket 不可用」
 * 而拒绝启动 —— 表现是整个服务起不回来，只能人工 kill。
 *
 * 自愈版 daemon（Node/Rust 两侧都有 recovery）会在 1s 内 rebind，所以先等一会儿
 * 复查，真的还是不可达才动手；杀掉后由服务（terminald 有 unit/plist，Render 由 Server
 * 启动时拉起）重新起一份新进程。
 */
function reapZombieDaemons(configPath: string): string[] {
  const actions: string[] = [];
  const suspects = daemonEndpointStates(configPath).filter((state) => state.pidAlive && !state.socketExists);
  if (suspects.length === 0) return actions;
  // 给自愈看门狗一点时间：端点丢得比这里早得多的话，下一轮就直接判死。
  sleepSync(1_500);
  for (const state of daemonEndpointStates(configPath)) {
    if (!state.pidAlive || state.socketExists) continue;
    // 最后一道闸：确认这个 pid 的**命令行**就是本 config 的这个 daemon。
    // 路径解析一旦与 daemon 不一致（比如 uid 算错），这条能挡住误杀。
    if (!isDaemonProcessForConfig(state.pid!, configPath, state.kind)) {
      actions.push(
        `${state.label} pid ${state.pid} 端点缺失但命令行不像是本 config 的 daemon，跳过清理（保存证据）`,
      );
      continue;
    }
    try {
      process.kill(state.pid!, "SIGKILL");
      actions.push(`${state.label} daemon pid ${state.pid} 进程活着但端点已丢失（${state.socketPath}），已清理`);
    } catch (error) {
      actions.push(`${state.label} daemon pid ${state.pid} 清理失败：${getErrorMessage(error)}`);
    }
  }
  return actions;
}

/** pid 的命令行是否确实是「本 config 的 render / terminald」。 */
export function isDaemonProcessForConfig(
  pid: number,
  configPath: string,
  kind: "render" | "terminald",
): boolean {
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
  const command = (result.stdout ?? "").trim();
  if (!command || !command.includes(configPath)) return false;
  return kind === "render" ? command.includes("wand-render") : command.includes("terminald");
}

/**
 * 「正在跑的 daemon 比装好的二进制旧」的提示（没有这种情形时返回 null）。
 *
 * npm 升级 / service:install 都不重启 daemon（那里可能挂着用户的 shell），所以升级完
 * 很容易一直在跑旧代码 —— 2026-09-24 的终端全断就是这么来的（9/23 补的端点自愈
 * 在 9/19 启的 terminald 里根本不存在）。service:install 的输出不带 --verbose 时
 * 看不到 detail，所以这句拼进 message 里。
 */
function staleDaemonNote(configPath: string): string | null {
  const render = renderPaths(configPath, configOwnerUid(configPath));
  const pid = readDaemonPidFile(render.pidPath);
  if (pid === null || !isPidAlive(pid)) return null;
  const daemonVersion = (() => {
    try {
      const meta = JSON.parse(readFileSync(render.metaPath, "utf8")) as { version?: unknown };
      return typeof meta.version === "string" && meta.version ? meta.version : null;
    } catch { return null; }
  })();
  const binaryPath = resolveRenderBinaryPath(configPath);
  if (!binaryPath) return null;
  const binaryVersion = (() => {
    try {
      const sidecar = readFileSync(`${binaryPath}.version`, "utf8").trim();
      if (/^\d+\.\d+\.\d+/.test(sidecar)) return sidecar;
    } catch { /* 没有 sidecar 就跑一次 --version */ }
    const result = spawnSync(binaryPath, ["--version"], { encoding: "utf8", timeout: 5_000 });
    const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)/.exec(result.stdout ?? "");
    return match?.[1] ?? null;
  })();
  if (!binaryVersion) return null;
  if (daemonVersion && compareSemver(daemonVersion, binaryVersion) >= 0) return null;
  const shown = daemonVersion ? `Render ${daemonVersion}` : "Render daemon";
  return `；但 ${shown} 仍在跑（装好的二进制是 ${binaryVersion}），它要重启才会用上新代码：./start.sh --restart-daemons`;
}

/** daemon 端点状态摘要，给服务命令的 detail 用。 */
function describeDaemonEndpoints(configPath: string): string {
  return daemonEndpointStates(configPath)
    .map((state) => {
      const pid = state.pid ?? "-";
      const alive = state.pidAlive ? "alive" : "-";
      const socket = state.socketExists ? "endpoint ok" : "endpoint MISSING";
      return `  ${state.label}: pid ${pid} (${alive}), ${socket} ${state.socketPath}`;
    })
    .join("\n");
}

/** 读取已安装服务 unit / plist 的入口命令；未安装或平台不支持时返回 null。 */
export function readServiceEntrypoint(scope: ServiceScope): string | null {
  const servicePath = servicePathFor(scope);
  if (process.platform === "darwin") {
    const result = spawnSync(
      "plutil",
      ["-extract", "ProgramArguments.1", "raw", "-o", "-", servicePath],
      { encoding: "utf8", timeout: 5_000 },
    );
    return result.status === 0 ? (result.stdout || "").trim() || null : null;
  }
  if (process.platform === "linux") {
    try {
      const execStart = readFileSync(servicePath, "utf8").split("\n").find((line) => line.startsWith("ExecStart="));
      if (!execStart) return null;
      return execStart.slice("ExecStart=".length).trim().split(/\s+/)[1] || null;
    } catch {
      return null;
    }
  }
  return null;
}

function checkInstalledServiceEntrypointsForUpdate(): CommandResult {
  const scopes: ServiceScope[] = (["system", "user"] as const).filter((scope) => isServiceInstalled(scope));
  if (scopes.length === 0) return { ok: true, message: "未安装服务" };
  const stableBin = resolveGlobalWandBin();
  if (!stableBin) {
    return { ok: false, message: "npm 全局 wand shim 不存在，已取消更新以保护当前服务。" };
  }
  for (const scope of scopes) {
    const entrypoint = readServiceEntrypoint(scope);
    if (!entrypoint || path.resolve(entrypoint) !== path.resolve(stableBin)) {
      const command = scope === "system"
        ? `sudo ${stableBin} service:install`
        : `${stableBin} service:install --user`;
      return {
        ok: false,
        message: `检测到 ${scope} 服务仍指向不稳定入口，已取消更新。请先运行: ${command}`,
        detail: `entrypoint: ${entrypoint || "无法读取"}\nstable shim: ${stableBin}`,
      };
    }
  }
  return { ok: true, message: "服务入口预检通过" };
}

function resolveWandBin(ctx: ServiceContext): string {
  // 更新后自修复：优先 npm 全局稳定 shim，避免沿用旧源码路径；不能钉死到包目录
  // dist/cli.js，因为事务回滚切换 canonical 目录时 shim 才能指向同盘安全备份。
  if (ctx.preferGlobalBin) {
    const globalBin = resolveGlobalWandBin();
    if (globalBin) return globalBin;
    throw new Error("npm 全局 wand shim 不存在，拒绝把服务 unit 写到不稳定的包目录路径。");
  }
  if (ctx.wandBin && existsSync(ctx.wandBin)) return ctx.wandBin;
  const argv1 = process.argv[1];
  if (argv1 && existsSync(argv1)) return argv1;
  const found = whichSync("wand");
  if (found) return found;
  return "wand";
}

/**
 * 构造写入 service unit 的 PATH，要覆盖以下来源（按优先级、去重）：
 *   1. nodeBinDir —— 保证 service 用的 node 和 install 时的一致
 *   2. process.env.PATH —— 调用 install 的终端 PATH，里面包含用户实际能跑通的 claude/codex 等
 *   3. 常见用户级 bin 兜底（~/.local/bin / ~/.npm-global/bin / ~/bin）—— 防 sudo 把 PATH 收窄
 *   4. /usr/local/... 等系统标准路径
 * 用 sudo 装系统级服务时 `process.env.PATH` 会被 secure_path 替换为极简集合，
 * 所以兜底路径不能省，否则又退化回 "command not found" 现场。
 */
function buildServicePath(nodeBinDir: string, home: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined): void => {
    if (!raw) return;
    for (const seg of raw.split(":")) {
      const trimmed = seg.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  };
  push(nodeBinDir);
  push(process.env.PATH);
  push(`${home}/.local/bin`);
  push(`${home}/.npm-global/bin`);
  push(`${home}/bin`);
  push("/usr/local/sbin");
  push("/usr/local/bin");
  push("/usr/sbin");
  push("/usr/bin");
  push("/sbin");
  push("/bin");
  return out.join(":");
}

/** 当前 process 的真实用户名（system unit 里要写 User=）。 */
function currentUserName(): string {
  try {
    return os.userInfo().username || "root";
  } catch {
    return process.env.USER || process.env.LOGNAME || "root";
  }
}

function ownerUserNameForPath(targetPath: string): string {
  const candidates = [targetPath, path.dirname(targetPath)];
  for (const candidate of candidates) {
    try {
      const uid = statUid(candidate);
      if (process.env.SUDO_UID === String(uid) && process.env.SUDO_USER) {
        return process.env.SUDO_USER;
      }
      const resolved = spawnSync("id", ["-un", String(uid)], { encoding: "utf8", timeout: 3000 });
      const name = (resolved.stdout || "").trim();
      if (resolved.status === 0 && name) return name;
    } catch {
      /* try next candidate */
    }
  }
  return process.env.SUDO_USER || currentUserName();
}

function homeForUser(userName: string, fallback: string): string {
  if (!userName || userName === "root") return fallback;
  if (process.platform === "darwin") {
    const resolved = spawnSync("dscl", [".", "-read", `/Users/${userName}`, "NFSHomeDirectory"], {
      encoding: "utf8",
      timeout: 3000,
    });
    const match = (resolved.stdout || "").match(/NFSHomeDirectory:\s*(.+)/);
    if (resolved.status === 0 && match?.[1]) return match[1].trim();
  }
  if (process.platform === "linux") {
    const resolved = spawnSync("getent", ["passwd", userName], { encoding: "utf8", timeout: 3000 });
    const home = (resolved.stdout || "").split(":")[5];
    if (resolved.status === 0 && home) return home.trim();
  }
  return fallback;
}

function statUid(targetPath: string): number {
  return readFileStat(targetPath).uid;
}

function readFileStat(targetPath: string): { uid: number } {
  return statSync(targetPath);
}

function installSystemdService(ctx: ServiceContext, scope: ServiceScope): CommandResult {
  const unitPath = servicePathFor(scope);
  const terminalUnitPath = terminalServicePathFor(scope);
  // 先清掉会阻塞启动的僵尸 daemon（pid 活着但端点没了），否则下一步 `wand web` 会
  // 因为「活着但 socket 不可用」直接拒绝启动。
  const daemonNotes = reapZombieDaemons(ctx.configPath);
  const wandBin = resolveWandBin(ctx);
  const nodeBin = process.execPath;
  const nodeBinDir = path.dirname(nodeBin);
  const runUser = scope === "system" ? ownerUserNameForPath(ctx.configPath) : currentUserName();
  const fallbackHome = process.env.HOME || os.homedir();
  const runHome = scope === "system" ? homeForUser(runUser, fallbackHome) : fallbackHome;
  // 关键：把调用 `wand service:install` 时的真实 PATH 写进 unit。
  // 否则 systemd 默认 PATH 极简（system scope 之前写死 `nodeBin:/usr/local/...`，
  // user scope 干脆没写），spawn 出的 claude/codex 子进程会撞 "command not found"
  // ——比如 claude 装在 ~/.local/bin、npm global 装在 ~/.npm-global/bin 都不在默认 PATH 里。
  const servicePath = buildServicePath(nodeBinDir, runHome);

  // 共同字段
  const commonExec = [
    "[Unit]",
    "Description=wand web console",
    "After=network-online.target wand-terminald.service",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${nodeBin} ${wandBin} web -c ${ctx.configPath}`,
    `Environment=WAND_NO_TUI=1`,
    `Environment=PATH=${servicePath}`,
    "Restart=always",
    "RestartSec=3",
    "StandardOutput=journal",
    "StandardError=journal",
    "SyslogIdentifier=wand",
  ];

  let unitLines: string[];
  if (scope === "system") {
    unitLines = [
      ...commonExec,
      `User=${runUser}`,
      `WorkingDirectory=${runHome}`,
      `Environment=HOME=${runHome}`,
      "OOMScoreAdjust=-500",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "",
    ];
  } else {
    // user scope: 跑在 user@<uid>.service cgroup 内，HOME 自带；PATH 也要写，
    // systemd 用户实例默认 PATH 同样不含 ~/.local/bin、nvm、npm-global 这些。
    unitLines = [
      ...commonExec,
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ];
  }
  const unit = unitLines.join("\n");
  const terminalCommon = [
    "[Unit]",
    "Description=wand persistent terminal host",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${nodeBin} ${wandBin} terminald -c ${ctx.configPath}`,
    `Environment=PATH=${servicePath}`,
    "Restart=always",
    "RestartSec=3",
    "StandardOutput=journal",
    "StandardError=journal",
    "SyslogIdentifier=wand-terminald",
  ];
  const terminalUnit = [
    ...terminalCommon,
    ...(scope === "system"
      ? [
          `User=${runUser}`,
          `WorkingDirectory=${runHome}`,
          `Environment=HOME=${runHome}`,
          "OOMScoreAdjust=-500",
          "",
          "[Install]",
          "WantedBy=multi-user.target",
        ]
      : ["", "[Install]", "WantedBy=default.target"]),
    "",
  ].join("\n");

  try {
    mkdirSync(path.dirname(unitPath), { recursive: true });
    writeFileSync(terminalUnitPath, terminalUnit, "utf8");
    writeFileSync(unitPath, unit, "utf8");
  } catch (err) {
    return { ok: false, message: `写入 unit 失败: ${getErrorMessage(err)}` };
  }

  const base = systemctlBaseArgs(scope);
  const reload = spawnSync("systemctl", [...base, "daemon-reload"], { encoding: "utf8" });
  const terminalAlreadyLive = hasLiveTerminalDaemon(ctx.configPath);
  const enableTerminal = spawnSync(
    "systemctl",
    [...base, "enable", ...(terminalAlreadyLive ? [] : ["--now"]), "wand-terminald.service"],
    { encoding: "utf8" },
  );
  const enable = spawnSync("systemctl", [...base, "enable", "--now", "wand.service"], { encoding: "utf8" });
  const hints = scope === "user"
    ? "提示: 若需登出后保持运行，请运行 `loginctl enable-linger $USER`"
    : "提示: 已写入系统级 unit；开机自启已 enable。";
  const detail = [
    `scope: ${scope}`,
    `unit: ${unitPath}`,
    `terminal unit: ${terminalUnitPath}`,
    ...daemonNotes,
    "daemons:",
    describeDaemonEndpoints(ctx.configPath),
    `daemon-reload: ${reload.status === 0 ? "ok" : `failed (${reload.stderr.trim()})`}`,
    `terminal enable${terminalAlreadyLive ? " (kept existing daemon)" : " --now"}: ${enableTerminal.status === 0 ? "ok" : `failed (${enableTerminal.stderr.trim()})`}`,
    `enable --now: ${enable.status === 0 ? "ok" : `failed (${enable.stderr.trim()})`}`,
    "",
    hints,
  ].join("\n");
  if (enableTerminal.status !== 0 || enable.status !== 0) {
    return {
      ok: false,
      message: `已写入 unit，但 systemctl ${scope === "user" ? "--user " : ""}启用失败`,
      detail,
    };
  }
  return {
    ok: true,
    message: `已注册 systemd ${scope === "user" ? "用户" : "系统"}服务: ${unitPath}` +
      (daemonNotes.length > 0 ? `（已清理 ${daemonNotes.length} 个僵尸 daemon）` : "") +
      (staleDaemonNote(ctx.configPath) ?? ""),
    detail,
  };
}

function uninstallSystemdService(scope: ServiceScope): CommandResult {
  const unitPath = servicePathFor(scope);
  const terminalUnitPath = terminalServicePathFor(scope);
  if (!existsSync(unitPath)) {
    return { ok: false, message: `未检测到已安装的 systemd ${scope} 服务` };
  }
  const base = systemctlBaseArgs(scope);
  const stop = spawnSync("systemctl", [...base, "disable", "--now", "wand.service"], { encoding: "utf8" });
  const stopTerminal = spawnSync("systemctl", [...base, "disable", "--now", "wand-terminald.service"], { encoding: "utf8" });
  try {
    unlinkSync(unitPath);
    if (existsSync(terminalUnitPath)) unlinkSync(terminalUnitPath);
  } catch (err) {
    return { ok: false, message: `删除 unit 失败: ${getErrorMessage(err)}` };
  }
  spawnSync("systemctl", [...base, "daemon-reload"], { encoding: "utf8" });
  return {
    ok: true,
    message: `已卸载 systemd ${scope === "user" ? "用户" : "系统"}服务`,
    detail: [
      stop.status === 0 ? "web disable --now: ok" : `web disable --now: ${stop.stderr.trim()}`,
      stopTerminal.status === 0 ? "terminal disable --now: ok" : `terminal disable --now: ${stopTerminal.stderr.trim()}`,
    ].join("\n"),
  };
}

function installLaunchdService(ctx: ServiceContext, scope: ServiceScope): CommandResult {
  const plistPath = servicePathFor(scope);
  const terminalPlistPath = terminalServicePathFor(scope);
  // 同 systemd：先例行清理僵尸 daemon，否则新起的 web 会因为端点缺失而拒绝启动。
  const daemonNotes = reapZombieDaemons(ctx.configPath);
  const wandBin = resolveWandBin(ctx);
  const nodeBin = process.execPath;
  const nodeBinDir = path.dirname(nodeBin);
  const runUser = scope === "system" ? ownerUserNameForPath(ctx.configPath) : currentUserName();
  const fallbackHome = process.env.HOME || os.homedir();
  const runHome = scope === "system" ? homeForUser(runUser, fallbackHome) : fallbackHome;
  // 与 systemd 同理：launchd 默认 PATH 极简，spawn 出的 claude 会找不到。
  const servicePath = buildServicePath(nodeBinDir, runHome);
  // launchd 默认把 stdout/stderr 丢进 /dev/null：线上出问题时连“daemon 活着但端点没了”
  // 这种一行告警都看不到（只能靠 lsof / 系统日志反推）。写进 config 目录旁边，
  // `wand service:logs` 直接读。
  const configDir = path.dirname(path.resolve(ctx.configPath));
  const logFields = (out: string, err: string): string =>
    `  <key>StandardOutPath</key><string>${path.join(configDir, out)}</string>\n` +
    `  <key>StandardErrorPath</key><string>${path.join(configDir, err)}</string>\n`;
  const userNameField = scope === "system"
    ? `  <key>UserName</key><string>${runUser}</string>\n`
    : "";
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.wand.web</string>
${userNameField}  <key>WorkingDirectory</key><string>${runHome}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${wandBin}</string>
    <string>web</string>
    <string>-c</string>
    <string>${ctx.configPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WAND_NO_TUI</key><string>1</string>
    <key>PATH</key><string>${servicePath}</string>
    <key>HOME</key><string>${runHome}</string>
  </dict>
  <key>RunAtLoad</key><true/>
${logFields("web.log", "web-error.log")}  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
  const terminalPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_TERMINAL_LABEL}</string>
${userNameField}  <key>WorkingDirectory</key><string>${runHome}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${wandBin}</string>
    <string>terminald</string>
    <string>-c</string>
    <string>${ctx.configPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${servicePath}</string>
    <key>HOME</key><string>${runHome}</string>
  </dict>
  <key>RunAtLoad</key><true/>
${logFields("terminald.log", "terminald-error.log")}  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
  try {
    mkdirSync(path.dirname(plistPath), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(terminalPlistPath, terminalPlist, "utf8");
    writeFileSync(plistPath, plist, "utf8");
  } catch (err) {
    return { ok: false, message: `写入 plist 失败: ${getErrorMessage(err)}` };
  }
  const terminalEnable = spawnSync(
    "launchctl",
    ["enable", launchdTarget(scope, LAUNCHD_TERMINAL_LABEL)],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (terminalEnable.status !== 0) {
    return {
      ok: false,
      message: "已写入 plist，但持久终端宿主 enable 失败",
      detail: formatSpawnResult(terminalEnable),
    };
  }
  let terminalDetail: string;
  if (launchdTargetIsLoaded(scope, LAUNCHD_TERMINAL_LABEL)) {
    terminalDetail = `terminal: kept running (${launchdTarget(scope, LAUNCHD_TERMINAL_LABEL)})`;
  } else if (hasLiveTerminalDaemon(ctx.configPath)) {
    // A daemon started by an older/manual web process already owns live PTYs.
    // Keep it untouched; the new plist will take ownership on the next boot.
    terminalDetail = "terminal: existing standalone daemon kept running; plist enabled for next boot";
  } else {
    const terminalStarted = launchdBootstrap(
      scope,
      terminalPlistPath,
      `已启动持久终端宿主: ${terminalPlistPath}`,
      LAUNCHD_TERMINAL_LABEL,
    );
    if (!terminalStarted.ok) {
      return {
        ok: false,
        message: "已写入 plist，但持久终端宿主启动失败",
        detail: terminalStarted.detail,
      };
    }
    terminalDetail = terminalStarted.detail ?? terminalStarted.message;
  }

  const started = launchdBootstrap(
    scope,
    plistPath,
    `已注册 launchd ${scope === "user" ? "用户代理" : "系统守护"}: ${plistPath}`,
  );
  if (!started.ok) {
    return {
      ok: false,
      message: "已写入 plist，但 launchctl 启动失败",
      detail: started.detail,
    };
  }
  return {
    ok: true,
    message: `已注册 launchd ${scope === "user" ? "用户代理" : "系统守护"}: ${plistPath}` +
      (daemonNotes.length > 0 ? `（已清理 ${daemonNotes.length} 个僵尸 daemon）` : "") +
      (staleDaemonNote(ctx.configPath) ?? ""),
    detail: [terminalDetail, started.detail, ...daemonNotes, "daemons:", describeDaemonEndpoints(ctx.configPath)]
      .filter(Boolean)
      .join("\n"),
  };
}

function uninstallLaunchdService(scope: ServiceScope): CommandResult {
  const plistPath = servicePathFor(scope);
  const terminalPlistPath = terminalServicePathFor(scope);
  if (!existsSync(plistPath)) {
    return { ok: false, message: `未检测到已安装的 launchd ${scope} 服务` };
  }
  const stopped = launchdBootout(scope, plistPath, `已停止 launchd ${scope}`);
  const stoppedTerminal = launchdBootout(
    scope,
    terminalPlistPath,
    `已停止持久终端宿主 ${scope}`,
    LAUNCHD_TERMINAL_LABEL,
  );
  const disabled = spawnSync("launchctl", ["disable", launchdTarget(scope)], { encoding: "utf8", timeout: 10_000 });
  const disabledTerminal = spawnSync(
    "launchctl",
    ["disable", launchdTarget(scope, LAUNCHD_TERMINAL_LABEL)],
    { encoding: "utf8", timeout: 10_000 },
  );
  try {
    unlinkSync(plistPath);
    if (existsSync(terminalPlistPath)) unlinkSync(terminalPlistPath);
  } catch (err) {
    return { ok: false, message: `删除 plist 失败: ${getErrorMessage(err)}` };
  }
  return {
    ok: true,
    message: `已卸载 launchd ${scope === "user" ? "用户代理" : "系统守护"}`,
    detail: [
      stopped.detail ?? stopped.message,
      stoppedTerminal.detail ?? stoppedTerminal.message,
      `disable: ${formatSpawnResult(disabled)}`,
      `terminal disable: ${formatSpawnResult(disabledTerminal)}`,
    ].join("\n"),
  };
}

// ─── 工具 ────────────────────────────────────────────────────────────────


// compareSemver 已统一到 ../version-utils.ts（上方已按需 import）
