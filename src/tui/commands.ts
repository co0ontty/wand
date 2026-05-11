/**
 * TUI 运维操作命令集合。
 *
 * 所有命令统一返回 CommandResult，UI 层负责把结果渲染到 toast / 弹窗 / 日志。
 * 命令本身不直接写 stdout / stderr —— TUI 模式下 stderr 已经被 log-bus 劫持。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export interface CommandResult {
  ok: boolean;
  /** 给用户看的简短状态行（一行）。 */
  message: string;
  /** 可选的详细输出（多行），供"详情"折叠展示。 */
  detail?: string;
}

const PACKAGE_NAME = "@co0ontty/wand";

// ─── 重启 ────────────────────────────────────────────────────────────────

/**
 * 重启当前进程。
 * 通过 spawn 一个 detached 子进程复用同一份 argv，然后退出父进程，
 * 让 systemd / 用户终端把控制权交给新进程。
 */
export function restartSelf(): CommandResult {
  try {
    const child = spawn(process.execPath, process.argv.slice(1), {
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
    return { ok: false, message: `重启失败: ${errMsg(err)}` };
  }
}

// ─── 检查 / 安装更新 ────────────────────────────────────────────────────

export interface UpdateInfo {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
}

/** 通过 npm view 拿到最新版本号。失败返回 latest=null。 */
export function checkUpdate(currentVersion: string): UpdateInfo {
  const res = spawnSync("npm", ["view", PACKAGE_NAME, "version"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (res.status !== 0 || !res.stdout) {
    return { current: currentVersion, latest: null, hasUpdate: false };
  }
  const latest = res.stdout.trim();
  return {
    current: currentVersion,
    latest,
    hasUpdate: compareSemver(latest, currentVersion) > 0,
  };
}

/**
 * 执行 `npm install -g @co0ontty/wand@latest`。
 * 此调用同步阻塞（TUI 上层应在另一线程的 setImmediate 调度，或直接 await）。
 * 返回 npm 输出供调试。
 */
export function installUpdate(): CommandResult {
  const res = spawnSync("npm", ["install", "-g", `${PACKAGE_NAME}@latest`], {
    encoding: "utf8",
    timeout: 180_000,
  });
  const out = (res.stdout || "") + (res.stderr ? "\n" + res.stderr : "");
  if (res.status === 0) {
    return {
      ok: true,
      message: "更新已安装。按 [R] 重启以生效。",
      detail: out.trim(),
    };
  }
  return {
    ok: false,
    message: `npm install 失败 (exit ${res.status})`,
    detail: out.trim(),
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
    return { ok: false, message: `打开失败: ${errMsg(err)}` };
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

// ─── 系统服务（systemd user / launchd） ──────────────────────────────────

export interface ServiceContext {
  configPath: string;
  /** wand 可执行文件路径。优先使用 process.argv[1]，回退到 which wand。 */
  wandBin?: string;
}

export function isServiceInstalled(): boolean {
  return existsSync(servicePath());
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

export function serviceStatus(): ServiceStatus {
  if (process.platform === "linux") return systemdStatus();
  if (process.platform === "darwin") return launchdStatus();
  return {
    installed: false,
    state: "unsupported",
    description: `当前平台 ${process.platform} 不支持服务管理`,
    raw: "",
    platform: process.platform,
  };
}

export function serviceStart(): CommandResult {
  if (process.platform === "linux") return runSystemctl(["start", "wand.service"], "已启动");
  if (process.platform === "darwin") return launchctlLoad();
  return unsupported();
}

export function serviceStop(): CommandResult {
  if (process.platform === "linux") return runSystemctl(["stop", "wand.service"], "已停止");
  if (process.platform === "darwin") return launchctlUnload();
  return unsupported();
}

export function serviceRestart(): CommandResult {
  if (process.platform === "linux") return runSystemctl(["restart", "wand.service"], "已重启");
  if (process.platform === "darwin") return launchdRestart();
  return unsupported();
}

/** 取最近 N 行服务日志。 */
export function serviceLogs(lines: number = 80): CommandResult {
  if (process.platform === "linux") {
    const r = spawnSync(
      "journalctl",
      ["--user", "-u", "wand.service", "-n", String(lines), "--no-pager"],
      { encoding: "utf8", timeout: 10_000 },
    );
    if (r.status === 0) return { ok: true, message: `journalctl 输出 ${lines} 行`, detail: r.stdout.trim() };
    return { ok: false, message: "journalctl 调用失败", detail: r.stderr.trim() || `exit ${r.status}` };
  }
  if (process.platform === "darwin") {
    return {
      ok: false,
      message: "launchd 不直接写日志，请用 Console.app 或在 plist 里配置 StandardOutPath",
    };
  }
  return unsupported();
}

function systemdStatus(): ServiceStatus {
  const installed = isServiceInstalled();
  if (!installed) {
    return {
      installed: false,
      state: "unknown",
      description: "未安装 (按 i 注册)",
      raw: "",
      platform: "linux",
    };
  }
  // 用 `systemctl --user is-active` + `show -p ActiveState,SubState,ActiveEnterTimestamp` 拿结构化数据
  const active = spawnSync("systemctl", ["--user", "is-active", "wand.service"], { encoding: "utf8" });
  const stateRaw = (active.stdout || "").trim();
  const show = spawnSync(
    "systemctl",
    [
      "--user",
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
  const status = spawnSync("systemctl", ["--user", "status", "wand.service", "--no-pager", "-n", "5"], {
    encoding: "utf8",
  });
  const sub = props.SubState || stateRaw;
  const since = props.ActiveEnterTimestamp ? ` since ${props.ActiveEnterTimestamp}` : "";
  const pid = props.MainPID && props.MainPID !== "0" ? ` · PID ${props.MainPID}` : "";
  const desc = `${stateRaw}${sub ? ` (${sub})` : ""}${since}${pid}`;

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

function launchdStatus(): ServiceStatus {
  const installed = isServiceInstalled();
  if (!installed) {
    return {
      installed: false,
      state: "unknown",
      description: "未安装 (按 i 注册)",
      raw: "",
      platform: "darwin",
    };
  }
  // launchctl list 输出三列：PID  Status  Label
  const list = spawnSync("launchctl", ["list", "com.wand.web"], { encoding: "utf8" });
  if (list.status !== 0) {
    return {
      installed: true,
      state: "inactive",
      description: "loaded 但未在运行（launchctl list 找不到）",
      raw: list.stderr || "",
      platform: "darwin",
    };
  }
  // launchctl list <label> 给出多行 plist 格式：包含 PID / LastExitStatus
  const text = list.stdout;
  const pidMatch = text.match(/"PID"\s*=\s*(\d+);/);
  const exitMatch = text.match(/"LastExitStatus"\s*=\s*(-?\d+);/);
  const pid = pidMatch ? Number(pidMatch[1]) : 0;
  const lastExit = exitMatch ? Number(exitMatch[1]) : 0;
  const desc = pid > 0 ? `running · PID ${pid}` : `stopped (last exit=${lastExit})`;
  return {
    installed: true,
    state: pid > 0 ? "active" : "inactive",
    description: desc,
    raw: text,
    platform: "darwin",
  };
}

function runSystemctl(args: string[], successWord: string): CommandResult {
  const r = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 15_000 });
  if (r.status === 0) {
    return { ok: true, message: `systemctl --user ${args.join(" ")} ${successWord}` };
  }
  return {
    ok: false,
    message: `systemctl 失败 (exit ${r.status})`,
    detail: ((r.stdout || "") + "\n" + (r.stderr || "")).trim(),
  };
}

function launchctlLoad(): CommandResult {
  const plist = servicePath();
  if (!existsSync(plist)) return { ok: false, message: "未安装 (plist 不存在)" };
  const r = spawnSync("launchctl", ["load", "-w", plist], { encoding: "utf8", timeout: 10_000 });
  if (r.status === 0) return { ok: true, message: "已 launchctl load" };
  return {
    ok: false,
    message: `launchctl load 失败 (exit ${r.status})`,
    detail: ((r.stdout || "") + "\n" + (r.stderr || "")).trim(),
  };
}

function launchctlUnload(): CommandResult {
  const plist = servicePath();
  if (!existsSync(plist)) return { ok: false, message: "未安装 (plist 不存在)" };
  const r = spawnSync("launchctl", ["unload", plist], { encoding: "utf8", timeout: 10_000 });
  if (r.status === 0) return { ok: true, message: "已 launchctl unload" };
  return {
    ok: false,
    message: `launchctl unload 失败 (exit ${r.status})`,
    detail: ((r.stdout || "") + "\n" + (r.stderr || "")).trim(),
  };
}

function launchdRestart(): CommandResult {
  const stop = launchctlUnload();
  const start = launchctlLoad();
  if (stop.ok && start.ok) return { ok: true, message: "已 launchd 重启" };
  return {
    ok: false,
    message: "launchd 重启失败",
    detail: `unload: ${stop.message}\nload: ${start.message}`,
  };
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
  if (process.platform === "linux") return installSystemdUserService(ctx);
  if (process.platform === "darwin") return installLaunchdAgent(ctx);
  return { ok: false, message: `当前平台 ${process.platform} 暂不支持服务注册` };
}

export function uninstallService(): CommandResult {
  if (process.platform === "linux") return uninstallSystemdUserService();
  if (process.platform === "darwin") return uninstallLaunchdAgent();
  return { ok: false, message: `当前平台 ${process.platform} 暂不支持服务注册` };
}

function servicePath(): string {
  if (process.platform === "linux") {
    return path.join(os.homedir(), ".config/systemd/user/wand.service");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library/LaunchAgents/com.wand.web.plist");
  }
  return "";
}

function resolveWandBin(ctx: ServiceContext): string {
  if (ctx.wandBin && existsSync(ctx.wandBin)) return ctx.wandBin;
  const argv1 = process.argv[1];
  if (argv1 && existsSync(argv1)) return argv1;
  const which = spawnSync("which", ["wand"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout) return which.stdout.trim();
  return "wand";
}

function installSystemdUserService(ctx: ServiceContext): CommandResult {
  const unitPath = servicePath();
  const wandBin = resolveWandBin(ctx);
  const nodeBin = process.execPath;
  const unit = [
    "[Unit]",
    "Description=wand web console",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${nodeBin} ${wandBin} web -c ${ctx.configPath}`,
    `Environment=WAND_NO_TUI=1`,
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

  try {
    mkdirSync(path.dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, unit, "utf8");
  } catch (err) {
    return { ok: false, message: `写入 unit 失败: ${errMsg(err)}` };
  }

  const reload = spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  const enable = spawnSync("systemctl", ["--user", "enable", "--now", "wand.service"], { encoding: "utf8" });
  const detail = [
    `unit: ${unitPath}`,
    `daemon-reload: ${reload.status === 0 ? "ok" : `failed (${reload.stderr.trim()})`}`,
    `enable --now: ${enable.status === 0 ? "ok" : `failed (${enable.stderr.trim()})`}`,
    "",
    "提示: 若需开机自启请运行 `loginctl enable-linger $USER`",
  ].join("\n");
  if (enable.status !== 0) {
    return {
      ok: false,
      message: "已写入 unit，但 systemctl 启用失败",
      detail,
    };
  }
  return {
    ok: true,
    message: `已注册 systemd 用户服务: ${unitPath}`,
    detail,
  };
}

function uninstallSystemdUserService(): CommandResult {
  const unitPath = servicePath();
  if (!existsSync(unitPath)) {
    return { ok: false, message: "未检测到已安装的 systemd 用户服务" };
  }
  const stop = spawnSync("systemctl", ["--user", "disable", "--now", "wand.service"], { encoding: "utf8" });
  try {
    unlinkSync(unitPath);
  } catch (err) {
    return { ok: false, message: `删除 unit 失败: ${errMsg(err)}` };
  }
  spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
  return {
    ok: true,
    message: "已卸载 systemd 用户服务",
    detail: stop.status === 0 ? "disable --now: ok" : `disable --now: ${stop.stderr.trim()}`,
  };
}

function installLaunchdAgent(ctx: ServiceContext): CommandResult {
  const plistPath = servicePath();
  const wandBin = resolveWandBin(ctx);
  const nodeBin = process.execPath;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.wand.web</string>
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
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
  try {
    mkdirSync(path.dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plist, "utf8");
  } catch (err) {
    return { ok: false, message: `写入 plist 失败: ${errMsg(err)}` };
  }
  const load = spawnSync("launchctl", ["load", "-w", plistPath], { encoding: "utf8" });
  if (load.status !== 0) {
    return {
      ok: false,
      message: "已写入 plist，但 launchctl load 失败",
      detail: load.stderr.trim() || `exit ${load.status}`,
    };
  }
  return {
    ok: true,
    message: `已注册 launchd 用户代理: ${plistPath}`,
  };
}

function uninstallLaunchdAgent(): CommandResult {
  const plistPath = servicePath();
  if (!existsSync(plistPath)) {
    return { ok: false, message: "未检测到已安装的 launchd 用户代理" };
  }
  const unload = spawnSync("launchctl", ["unload", "-w", plistPath], { encoding: "utf8" });
  try {
    unlinkSync(plistPath);
  } catch (err) {
    return { ok: false, message: `删除 plist 失败: ${errMsg(err)}` };
  }
  return {
    ok: true,
    message: "已卸载 launchd 用户代理",
    detail: unload.status === 0 ? "unload: ok" : `unload: ${unload.stderr.trim()}`,
  };
}

// ─── 工具 ────────────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 简易语义化版本比较；返回正数 = a > b。 */
function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.\-+]/).map((s) => Number.parseInt(s, 10));
  const pb = b.replace(/^v/, "").split(/[.\-+]/).map((s) => Number.parseInt(s, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}
