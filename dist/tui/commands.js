/**
 * TUI 运维操作命令集合。
 *
 * 所有命令统一返回 CommandResult，UI 层负责把结果渲染到 toast / 弹窗 / 日志。
 * 命令本身不直接写 stdout / stderr —— TUI 模式下 stderr 已经被 log-bus 劫持。
 */
import { spawn, spawnSync } from "node:child_process";
import { compareSemver } from "../version-utils.js";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { installPackageGloballySync, resolveGlobalWandCli } from "../npm-update-utils.js";
import { whichSync } from "../path-repair.js";
import { computeRelaunch } from "../relaunch.js";
const PACKAGE_NAME = "@co0ontty/wand";
// ─── 重启 ────────────────────────────────────────────────────────────────
/**
 * 重启当前进程。
 * 通过 spawn 一个 detached 子进程复用同一份 argv，然后退出父进程，
 * 让 systemd / 用户终端把控制权交给新进程。
 */
export function restartSelf() {
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
    }
    catch (err) {
        return { ok: false, message: `重启失败: ${errMsg(err)}` };
    }
}
/** 通过 npm view 拿到最新版本号。失败返回 latest=null。 */
export function checkUpdate(currentVersion) {
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
 *
 * 此调用同步阻塞（TUI 上层应在另一线程的 setImmediate 调度，或直接 await）。
 * 通过 npm-update-utils 自动处理 `.wand-XXXXXX` 残留目录和 ENOTEMPTY 回退，
 * 行为与 server.ts 的 /api/update / performAutoUpdate 保持一致。
 *
 * 返回 npm 输出供调试。
 */
export function installUpdate() {
    const res = installPackageGloballySync(`${PACKAGE_NAME}@latest`, 180_000);
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
export function openInBrowser(url) {
    const cmd = process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
            ? "cmd"
            : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
        const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
        child.unref();
        return { ok: true, message: `已在浏览器打开: ${url}` };
    }
    catch (err) {
        return { ok: false, message: `打开失败: ${errMsg(err)}` };
    }
}
// ─── 复制到剪贴板 ───────────────────────────────────────────────────────
export function copyToClipboard(text) {
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
function clipboardCandidates() {
    if (process.platform === "darwin")
        return [{ cmd: "pbcopy", args: [] }];
    if (process.platform === "win32")
        return [{ cmd: "clip", args: [] }];
    // Linux：优先 wl-copy（Wayland），其次 xclip / xsel
    return [
        { cmd: "wl-copy", args: [] },
        { cmd: "xclip", args: ["-selection", "clipboard"] },
        { cmd: "xsel", args: ["--clipboard", "--input"] },
    ];
}
export const DEFAULT_SERVICE_SCOPE = "system";
/** 当前 process 是不是 root（POSIX）。Windows 永远返回 false。 */
function isRoot() {
    const fn = process.getuid;
    if (typeof fn !== "function")
        return false;
    try {
        return fn.call(process) === 0;
    }
    catch {
        return false;
    }
}
/** 自动检测哪个 scope 已经装了 unit；优先 system，找不到就 user。两个都没装返回 null。 */
export function detectInstalledScope() {
    if (existsSync(servicePathFor("system")))
        return "system";
    if (existsSync(servicePathFor("user")))
        return "user";
    return null;
}
/** 给定一个 opts.scope，如果没传就按 detect → default 顺序回退。 */
function resolveScope(opts) {
    if (opts?.scope)
        return opts.scope;
    return detectInstalledScope() ?? DEFAULT_SERVICE_SCOPE;
}
export function isServiceInstalled(scope) {
    if (scope)
        return existsSync(servicePathFor(scope));
    return detectInstalledScope() !== null;
}
export function serviceStatus(opts) {
    const scope = resolveScope(opts);
    if (process.platform === "linux")
        return systemdStatus(scope);
    if (process.platform === "darwin")
        return launchdStatus(scope);
    return {
        installed: false,
        state: "unsupported",
        description: `当前平台 ${process.platform} 不支持服务管理`,
        raw: "",
        platform: process.platform,
    };
}
export function serviceStart(opts) {
    const scope = resolveScope(opts);
    if (process.platform === "linux")
        return runSystemctl(scope, ["start", "wand.service"], "已启动");
    if (process.platform === "darwin")
        return launchctlLoad(scope);
    return unsupported();
}
export function serviceStop(opts) {
    const scope = resolveScope(opts);
    if (process.platform === "linux")
        return runSystemctl(scope, ["stop", "wand.service"], "已停止");
    if (process.platform === "darwin")
        return launchctlUnload(scope);
    return unsupported();
}
export function serviceRestart(opts) {
    const scope = resolveScope(opts);
    if (process.platform === "linux")
        return runSystemctl(scope, ["restart", "wand.service"], "已重启");
    if (process.platform === "darwin")
        return launchdRestart(scope);
    return unsupported();
}
/** 取最近 N 行服务日志。 */
export function serviceLogs(lines = 80, opts) {
    const scope = resolveScope(opts);
    if (process.platform === "linux") {
        const args = scope === "user"
            ? ["--user", "-u", "wand.service", "-n", String(lines), "--no-pager"]
            : ["-u", "wand.service", "-n", String(lines), "--no-pager"];
        const r = spawnSync("journalctl", args, { encoding: "utf8", timeout: 10_000 });
        if (r.status === 0)
            return { ok: true, message: `journalctl 输出 ${lines} 行`, detail: r.stdout.trim() };
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
/** systemctl 调用根据 scope 决定要不要 --user。system scope 也意味着调用方需要 root。 */
function systemctlBaseArgs(scope) {
    return scope === "user" ? ["--user"] : [];
}
function systemdStatus(scope) {
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
    const show = spawnSync("systemctl", [
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
    ], { encoding: "utf8" });
    const props = parseSystemctlShow(show.stdout || "");
    const status = spawnSync("systemctl", [...base, "status", "wand.service", "--no-pager", "-n", "5"], {
        encoding: "utf8",
    });
    const sub = props.SubState || stateRaw;
    const since = props.ActiveEnterTimestamp ? ` since ${props.ActiveEnterTimestamp}` : "";
    const pid = props.MainPID && props.MainPID !== "0" ? ` · PID ${props.MainPID}` : "";
    const desc = `[${scope}] ${stateRaw}${sub ? ` (${sub})` : ""}${since}${pid}`;
    let normalized = "unknown";
    if (stateRaw === "active")
        normalized = "active";
    else if (stateRaw === "inactive")
        normalized = "inactive";
    else if (stateRaw === "failed")
        normalized = "failed";
    else if (stateRaw === "activating" || stateRaw === "reloading")
        normalized = "active";
    return {
        installed: true,
        state: normalized,
        description: desc,
        raw: status.stdout || status.stderr || "",
        platform: "linux",
    };
}
function launchdStatus(scope) {
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
    // launchctl list 输出三列：PID  Status  Label
    const list = spawnSync("launchctl", ["list", "com.wand.web"], { encoding: "utf8" });
    if (list.status !== 0) {
        return {
            installed: true,
            state: "inactive",
            description: `[${scope}] loaded 但未在运行（launchctl list 找不到）`,
            raw: list.stderr || "",
            platform: "darwin",
        };
    }
    const text = list.stdout;
    const pidMatch = text.match(/"PID"\s*=\s*(\d+);/);
    const exitMatch = text.match(/"LastExitStatus"\s*=\s*(-?\d+);/);
    const pid = pidMatch ? Number(pidMatch[1]) : 0;
    const lastExit = exitMatch ? Number(exitMatch[1]) : 0;
    const desc = pid > 0 ? `[${scope}] running · PID ${pid}` : `[${scope}] stopped (last exit=${lastExit})`;
    return {
        installed: true,
        state: pid > 0 ? "active" : "inactive",
        description: desc,
        raw: text,
        platform: "darwin",
    };
}
function runSystemctl(scope, args, successWord) {
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
function launchctlLoad(scope) {
    const plist = servicePathFor(scope);
    if (!existsSync(plist))
        return { ok: false, message: `未安装 (${plist} 不存在)` };
    const r = spawnSync("launchctl", ["load", "-w", plist], { encoding: "utf8", timeout: 10_000 });
    if (r.status === 0)
        return { ok: true, message: `已 launchctl load (${scope})` };
    return {
        ok: false,
        message: `launchctl load 失败 (exit ${r.status})`,
        detail: ((r.stdout || "") + "\n" + (r.stderr || "")).trim(),
    };
}
function launchctlUnload(scope) {
    const plist = servicePathFor(scope);
    if (!existsSync(plist))
        return { ok: false, message: `未安装 (${plist} 不存在)` };
    const r = spawnSync("launchctl", ["unload", plist], { encoding: "utf8", timeout: 10_000 });
    if (r.status === 0)
        return { ok: true, message: `已 launchctl unload (${scope})` };
    return {
        ok: false,
        message: `launchctl unload 失败 (exit ${r.status})`,
        detail: ((r.stdout || "") + "\n" + (r.stderr || "")).trim(),
    };
}
function launchdRestart(scope) {
    const stop = launchctlUnload(scope);
    const start = launchctlLoad(scope);
    if (stop.ok && start.ok)
        return { ok: true, message: `已 launchd 重启 (${scope})` };
    return {
        ok: false,
        message: "launchd 重启失败",
        detail: `unload: ${stop.message}\nload: ${start.message}`,
    };
}
function unsupported() {
    return { ok: false, message: `当前平台 ${process.platform} 不支持服务管理` };
}
function parseSystemctlShow(text) {
    const out = {};
    for (const line of text.split("\n")) {
        const eq = line.indexOf("=");
        if (eq <= 0)
            continue;
        out[line.slice(0, eq)] = line.slice(eq + 1).trim();
    }
    return out;
}
export function installService(ctx) {
    const scope = ctx.scope ?? DEFAULT_SERVICE_SCOPE;
    // system scope 需要 root（除了 Windows，那里两个都不支持）
    if (scope === "system" && !isRoot() && process.platform !== "win32") {
        return {
            ok: false,
            message: "系统级服务安装需要 root 权限",
            detail: "请用 sudo 重跑，或传 --user 走用户级安装（不需要 root）。",
        };
    }
    if (process.platform === "linux")
        return installSystemdService(ctx, scope);
    if (process.platform === "darwin")
        return installLaunchdService(ctx, scope);
    return { ok: false, message: `当前平台 ${process.platform} 暂不支持服务注册` };
}
export function uninstallService(opts) {
    const scope = resolveScope(opts);
    if (scope === "system" && !isRoot() && process.platform !== "win32") {
        return {
            ok: false,
            message: "系统级服务卸载需要 root 权限",
            detail: "请用 sudo 重跑。",
        };
    }
    if (process.platform === "linux")
        return uninstallSystemdService(scope);
    if (process.platform === "darwin")
        return uninstallLaunchdService(scope);
    return { ok: false, message: `当前平台 ${process.platform} 暂不支持服务注册` };
}
function servicePathFor(scope) {
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
function resolveWandBin(ctx) {
    // 更新后自修复：优先全局安装的 dist/cli.js，避免沿用旧源码路径。
    if (ctx.preferGlobalBin) {
        const global = resolveGlobalWandCli();
        if (global)
            return global;
    }
    if (ctx.wandBin && existsSync(ctx.wandBin))
        return ctx.wandBin;
    const argv1 = process.argv[1];
    if (argv1 && existsSync(argv1))
        return argv1;
    const found = whichSync("wand");
    if (found)
        return found;
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
function buildServicePath(nodeBinDir, home) {
    const out = [];
    const seen = new Set();
    const push = (raw) => {
        if (!raw)
            return;
        for (const seg of raw.split(":")) {
            const trimmed = seg.trim();
            if (!trimmed || seen.has(trimmed))
                continue;
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
function currentUserName() {
    try {
        return os.userInfo().username || "root";
    }
    catch {
        return process.env.USER || process.env.LOGNAME || "root";
    }
}
function installSystemdService(ctx, scope) {
    const unitPath = servicePathFor(scope);
    const wandBin = resolveWandBin(ctx);
    const nodeBin = process.execPath;
    const nodeBinDir = path.dirname(nodeBin);
    const runHome = process.env.HOME || os.homedir();
    // 关键：把调用 `wand service:install` 时的真实 PATH 写进 unit。
    // 否则 systemd 默认 PATH 极简（system scope 之前写死 `nodeBin:/usr/local/...`，
    // user scope 干脆没写），spawn 出的 claude/codex 子进程会撞 "command not found"
    // ——比如 claude 装在 ~/.local/bin、npm global 装在 ~/.npm-global/bin 都不在默认 PATH 里。
    const servicePath = buildServicePath(nodeBinDir, runHome);
    // 共同字段
    const commonExec = [
        "[Unit]",
        "Description=wand web console",
        "After=network-online.target",
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
    let unitLines;
    if (scope === "system") {
        const runUser = currentUserName();
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
    }
    else {
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
    try {
        mkdirSync(path.dirname(unitPath), { recursive: true });
        writeFileSync(unitPath, unit, "utf8");
    }
    catch (err) {
        return { ok: false, message: `写入 unit 失败: ${errMsg(err)}` };
    }
    const base = systemctlBaseArgs(scope);
    const reload = spawnSync("systemctl", [...base, "daemon-reload"], { encoding: "utf8" });
    const enable = spawnSync("systemctl", [...base, "enable", "--now", "wand.service"], { encoding: "utf8" });
    const hints = scope === "user"
        ? "提示: 若需登出后保持运行，请运行 `loginctl enable-linger $USER`"
        : "提示: 已写入系统级 unit；开机自启已 enable。";
    const detail = [
        `scope: ${scope}`,
        `unit: ${unitPath}`,
        `daemon-reload: ${reload.status === 0 ? "ok" : `failed (${reload.stderr.trim()})`}`,
        `enable --now: ${enable.status === 0 ? "ok" : `failed (${enable.stderr.trim()})`}`,
        "",
        hints,
    ].join("\n");
    if (enable.status !== 0) {
        return {
            ok: false,
            message: `已写入 unit，但 systemctl ${scope === "user" ? "--user " : ""}启用失败`,
            detail,
        };
    }
    return {
        ok: true,
        message: `已注册 systemd ${scope === "user" ? "用户" : "系统"}服务: ${unitPath}`,
        detail,
    };
}
function uninstallSystemdService(scope) {
    const unitPath = servicePathFor(scope);
    if (!existsSync(unitPath)) {
        return { ok: false, message: `未检测到已安装的 systemd ${scope} 服务` };
    }
    const base = systemctlBaseArgs(scope);
    const stop = spawnSync("systemctl", [...base, "disable", "--now", "wand.service"], { encoding: "utf8" });
    try {
        unlinkSync(unitPath);
    }
    catch (err) {
        return { ok: false, message: `删除 unit 失败: ${errMsg(err)}` };
    }
    spawnSync("systemctl", [...base, "daemon-reload"], { encoding: "utf8" });
    return {
        ok: true,
        message: `已卸载 systemd ${scope === "user" ? "用户" : "系统"}服务`,
        detail: stop.status === 0 ? "disable --now: ok" : `disable --now: ${stop.stderr.trim()}`,
    };
}
function installLaunchdService(ctx, scope) {
    const plistPath = servicePathFor(scope);
    const wandBin = resolveWandBin(ctx);
    const nodeBin = process.execPath;
    const nodeBinDir = path.dirname(nodeBin);
    const runHome = process.env.HOME || os.homedir();
    // 与 systemd 同理：launchd 默认 PATH 极简，spawn 出的 claude 会找不到。
    const servicePath = buildServicePath(nodeBinDir, runHome);
    // LaunchDaemon (system) 跑在 root，但 wand 数据应该归 ctx.configPath 的 owner；
    // 简化处理：system 模式下不强制改 owner，让用户自己提前 chown。
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
    <key>PATH</key><string>${servicePath}</string>
    <key>HOME</key><string>${runHome}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
    try {
        mkdirSync(path.dirname(plistPath), { recursive: true });
        writeFileSync(plistPath, plist, "utf8");
    }
    catch (err) {
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
        message: `已注册 launchd ${scope === "user" ? "用户代理" : "系统守护"}: ${plistPath}`,
    };
}
function uninstallLaunchdService(scope) {
    const plistPath = servicePathFor(scope);
    if (!existsSync(plistPath)) {
        return { ok: false, message: `未检测到已安装的 launchd ${scope} 服务` };
    }
    const unload = spawnSync("launchctl", ["unload", "-w", plistPath], { encoding: "utf8" });
    try {
        unlinkSync(plistPath);
    }
    catch (err) {
        return { ok: false, message: `删除 plist 失败: ${errMsg(err)}` };
    }
    return {
        ok: true,
        message: `已卸载 launchd ${scope === "user" ? "用户代理" : "系统守护"}`,
        detail: unload.status === 0 ? "unload: ok" : `unload: ${unload.stderr.trim()}`,
    };
}
// ─── 工具 ────────────────────────────────────────────────────────────────
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
// compareSemver 已统一到 ../version-utils.ts
