import { createRequire } from "node:module";
import { LogLevel, LogRecord } from "./log-bus.js";
import { SessionRow } from "./session-formatter.js";

const require = createRequire(import.meta.url);
// neo-blessed 是 CJS，没有匹配 @types/blessed 的 default export，统一当 any 用。
const blessed = require("neo-blessed") as any;

const HEADER_HEIGHT = 8;
const SESSIONS_HEIGHT = 12;
const HINT_HEIGHT = 2;
const LOG_TOP = HEADER_HEIGHT + SESSIONS_HEIGHT;
const LOG_BUFFER_LIMIT = 1000;
const RENDER_THROTTLE_MS = 50;
const TOAST_DEFAULT_TTL = 3500;

export interface HeaderInfo {
  version: string;
  url: string;
  scheme: "HTTP" | "HTTPS";
  bindAddr: string;
  configPath: string;
  dbPath: string;
  orphanRecoveredCount: number;
  sessionCounts: { active: number; archived: number; total: number };
  /** 服务启动时间（ms epoch），用于计算 uptime。 */
  startedAtMs: number;
  /** 当前进程 RSS 内存（字节），由调用方传入。 */
  rssBytes: number;
  /** 是否已注册系统服务（systemd / launchd），用于在 header 显示标签。 */
  serviceInstalled: boolean;
}

export type ToastLevel = "info" | "warn" | "error" | "success";

export interface ConfirmOptions {
  title: string;
  body: string;
  yes?: string;
  no?: string;
}

export interface ServicePanelView {
  /** 第一行状态描述，例如 "active (running) since ..." */
  statusLine: string;
  /** active / inactive / failed / unsupported / unknown / loaded。决定状态行颜色。 */
  state: "active" | "inactive" | "failed" | "loaded" | "unknown" | "unsupported";
  installed: boolean;
  platform: NodeJS.Platform;
  /** 用于"上次操作"提示行，可为空。 */
  lastAction?: string;
}

export interface ServicePanelHandlers {
  onStart: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onRestart: () => void | Promise<void>;
  onInstall: () => void | Promise<void>;
  onUninstall: () => void | Promise<void>;
  onLogs: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onClose: () => void;
}

export interface LayoutHandle {
  screen: any;
  refreshHeader(info: HeaderInfo): void;
  refreshSessions(rows: SessionRow[]): void;
  appendLog(record: LogRecord): void;
  setSelectionListener(listener: (index: number) => void): void;
  showHelp(visible: boolean): void;
  toggleHelp(): boolean;
  showToast(message: string, level?: ToastLevel, ttlMs?: number): void;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  showDetail(title: string, body: string): void;
  hideDetail(): void;
  clearLogs(): void;
  openServicePanel(handlers: ServicePanelHandlers, initial: ServicePanelView): void;
  updateServicePanel(view: ServicePanelView): void;
  closeServicePanel(): void;
  isServicePanelOpen(): boolean;
  destroy(): void;
}

export function buildLayout(): LayoutHandle {
  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: "wand",
    autoPadding: true,
    warnings: false,
  });

  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: HEADER_HEIGHT,
    border: { type: "line" },
    label: " ✦ wand ",
    tags: true,
    style: {
      border: { fg: "cyan" },
      label: { fg: "cyan", bold: true },
    },
  });

  const sessions = blessed.list({
    parent: screen,
    top: HEADER_HEIGHT,
    left: 0,
    width: "100%",
    height: SESSIONS_HEIGHT,
    border: { type: "line" },
    label: " Sessions ",
    keys: true,
    mouse: false,
    vi: false,
    tags: true,
    scrollable: true,
    scrollbar: { ch: " ", style: { bg: "gray" } },
    style: {
      border: { fg: "gray" },
      label: { fg: "cyan", bold: true },
      selected: { bg: "blue", fg: "white" },
      item: { fg: "white" },
    },
    items: [],
  });

  // 日志面板故意关掉 tags：用户日志可能含 `{...}`，开 tags 会被误解析。
  // 颜色通过 ANSI 转义码注入，blessed.log 能正确渲染 ANSI。
  const logbox = blessed.log({
    parent: screen,
    top: LOG_TOP,
    left: 0,
    width: "100%",
    bottom: HINT_HEIGHT,
    border: { type: "line" },
    label: " Logs ",
    tags: false,
    scrollable: true,
    scrollback: LOG_BUFFER_LIMIT,
    scrollbar: { ch: " ", style: { bg: "gray" } },
    style: {
      border: { fg: "gray" },
      label: { fg: "cyan", bold: true },
    },
  });

  const hint = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: HINT_HEIGHT,
    tags: true,
    content: buildHintContent(),
  });

  // —— Toast：右下角 1 行浮层 ——
  const toast = blessed.box({
    parent: screen,
    bottom: HINT_HEIGHT,
    right: 2,
    height: 1,
    width: "shrink",
    tags: true,
    hidden: true,
    style: { fg: "white" },
  });
  let toastTimer: NodeJS.Timeout | null = null;

  // —— Help Overlay ——
  const helpBox = blessed.box({
    parent: screen,
    top: "center",
    left: "center",
    width: 66,
    height: 24,
    border: { type: "line" },
    label: " ✦ Shortcuts ",
    tags: true,
    hidden: true,
    style: {
      border: { fg: "cyan" },
      label: { fg: "cyan", bold: true },
      bg: "black",
    },
    content: buildHelpContent(),
  });

  // —— Detail Overlay（用于显示命令输出详情）。tags 关闭，按纯文本渲染。 ——
  const detailBox = blessed.box({
    parent: screen,
    top: "center",
    left: "center",
    width: "80%",
    height: "70%",
    border: { type: "line" },
    label: " Detail ",
    tags: false,
    hidden: true,
    keys: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: " ", style: { bg: "gray" } },
    style: {
      border: { fg: "magenta" },
      label: { fg: "magenta", bold: true },
      bg: "black",
    },
  });

  // —— Service Control Panel —— 居中浮层，tags: true 用于上色
  const servicePanel = blessed.box({
    parent: screen,
    top: "center",
    left: "center",
    width: 64,
    height: 16,
    border: { type: "line" },
    label: " ✦ Service Control ",
    tags: true,
    hidden: true,
    keys: true,
    style: {
      border: { fg: "yellow" },
      label: { fg: "yellow", bold: true },
      bg: "black",
    },
  });
  let servicePanelHandlers: ServicePanelHandlers | null = null;
  let servicePanelView: ServicePanelView | null = null;
  const servicePanelKeys = ["s", "t", "r", "i", "u", "l", "R", "escape", "q"];

  // 让 sessions 默认获得焦点以接收键盘事件
  sessions.focus();

  let renderPending = false;
  let renderTimer: NodeJS.Timeout | null = null;
  function scheduleRender(): void {
    if (renderPending) return;
    renderPending = true;
    renderTimer = setTimeout(() => {
      renderPending = false;
      renderTimer = null;
      try { screen.render(); } catch { /* destroyed */ }
    }, RENDER_THROTTLE_MS);
    renderTimer.unref?.();
  }

  function refreshHeader(info: HeaderInfo): void {
    const counts = info.sessionCounts;
    const sess =
      `{green-fg}${counts.active}{/} active · ` +
      `{gray-fg}${counts.archived}{/} archived · ` +
      `{white-fg}${counts.total}{/} total`;
    const orphan = info.orphanRecoveredCount > 0
      ? `  {gray-fg}(${info.orphanRecoveredCount} orphan PTYs cleaned){/}`
      : "";
    const schemeColor = info.scheme === "HTTPS" ? "green" : "yellow";
    const serviceBadge = info.serviceInstalled
      ? "  {green-fg}[service: on]{/}"
      : "  {gray-fg}[service: off]{/}";
    const uptime = formatUptime(Date.now() - info.startedAtMs);
    const mem = formatBytes(info.rssBytes);
    const lines = [
      `{cyan-fg}{bold}Version{/}    ${info.version}` +
        `   {gray-fg}·{/}   {cyan-fg}{bold}Uptime{/} ${uptime}` +
        `   {gray-fg}·{/}   {cyan-fg}{bold}Memory{/} ${mem}` +
        serviceBadge,
      `{cyan-fg}{bold}URL{/}        {underline}${info.url}{/underline}  ` +
        `{${schemeColor}-fg}● ${info.scheme}{/}  {gray-fg}(bind ${info.bindAddr}){/}`,
      `{cyan-fg}{bold}Config{/}     ${info.configPath}`,
      `{cyan-fg}{bold}Database{/}   ${info.dbPath}`,
      `{cyan-fg}{bold}Sessions{/}   ${sess}${orphan}`,
      `{gray-fg}按 ?  查看快捷键 · q 退出 · R 重启 · u 检查更新 · s 注册服务 · o 浏览器打开 · c 拷贝 URL{/}`,
    ];
    header.setContent(lines.join("\n"));
    scheduleRender();
  }

  function refreshSessions(rows: SessionRow[]): void {
    if (rows.length === 0) {
      sessions.setItems(["{gray-fg}— 暂无会话 —{/}"]);
    } else {
      sessions.setItems(rows.map(formatRow));
    }
    scheduleRender();
  }

  function appendLog(record: LogRecord): void {
    const ts = formatTs(record.ts);
    const tsAnsi = `\x1b[90m${ts}\x1b[39m`;
    const lineAnsi = ansiColorize(record.level, record.line);
    logbox.log(`${tsAnsi} ${lineAnsi}`);
    scheduleRender();
  }

  function setSelectionListener(listener: (index: number) => void): void {
    sessions.on("select item", (_item: unknown, index: number) => listener(index));
  }

  function showHelp(visible: boolean): void {
    if (visible) {
      helpBox.setContent(buildHelpContent());
      helpBox.show();
      helpBox.setFront();
    } else {
      helpBox.hide();
      sessions.focus();
    }
    scheduleRender();
  }
  function toggleHelp(): boolean {
    const next = (helpBox as any).hidden === true;
    showHelp(next);
    return next;
  }

  function showToast(message: string, level: ToastLevel = "info", ttlMs = TOAST_DEFAULT_TTL): void {
    const color = level === "error" ? "red" : level === "warn" ? "yellow" : level === "success" ? "green" : "cyan";
    const icon = level === "error" ? "✖" : level === "warn" ? "⚠" : level === "success" ? "✔" : "ℹ";
    toast.setContent(`{${color}-fg}${icon} ${escapeTags(message)}{/}`);
    toast.show();
    toast.setFront();
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hide();
      scheduleRender();
      toastTimer = null;
    }, ttlMs);
    toastTimer.unref?.();
    scheduleRender();
  }

  function confirm(opts: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      const yes = opts.yes || "回车 / y 确认";
      const no = opts.no || "Esc / n 取消";
      const dlg = blessed.box({
        parent: screen,
        top: "center",
        left: "center",
        width: Math.min(78, Math.max(48, opts.body.length + 14)),
        height: 9,
        border: { type: "line" },
        label: ` ${opts.title} `,
        tags: true,
        keys: true,
        style: {
          border: { fg: "yellow" },
          label: { fg: "yellow", bold: true },
          bg: "black",
        },
        content:
          `\n  ${escapeTags(opts.body)}\n\n` +
          `  {green-fg}${yes}{/}    {gray-fg}${no}{/}`,
      });
      dlg.setFront();
      dlg.focus();

      const cleanup = (result: boolean) => {
        try { dlg.destroy(); } catch { /* noop */ }
        sessions.focus();
        scheduleRender();
        resolve(result);
      };
      dlg.key(["enter", "y", "Y"], () => cleanup(true));
      dlg.key(["escape", "n", "N", "q"], () => cleanup(false));
      scheduleRender();
    });
  }

  function showDetail(title: string, body: string): void {
    detailBox.setLabel(` ${title} (Esc 关闭) `);
    // tags: false 的 box 里 content 直接按字面值渲染。
    detailBox.setContent(body);
    detailBox.show();
    detailBox.setFront();
    detailBox.focus();
    detailBox.key(["escape", "q"], () => hideDetail());
    scheduleRender();
  }
  function hideDetail(): void {
    detailBox.hide();
    sessions.focus();
    scheduleRender();
  }

  function clearLogs(): void {
    // neo-blessed.log 没有公开 clear 方法，直接重置 content + scrollback
    try {
      (logbox as any).setContent("");
      (logbox as any)._clines && ((logbox as any)._clines.length = 0);
    } catch { /* noop */ }
    scheduleRender();
  }

  function openServicePanel(handlers: ServicePanelHandlers, initial: ServicePanelView): void {
    servicePanelHandlers = handlers;
    servicePanelView = initial;
    renderServicePanel();
    servicePanel.show();
    servicePanel.setFront();
    servicePanel.focus();
    // 绑定一次性按键
    for (const k of servicePanelKeys) servicePanel.unkey(k, () => {});
    servicePanel.key(["s"], () => { void handlers.onStart(); });
    servicePanel.key(["t"], () => { void handlers.onStop(); });
    servicePanel.key(["r"], () => { void handlers.onRestart(); });
    servicePanel.key(["R"], () => { void handlers.onRefresh(); });
    servicePanel.key(["i"], () => { void handlers.onInstall(); });
    servicePanel.key(["u"], () => { void handlers.onUninstall(); });
    servicePanel.key(["l"], () => { void handlers.onLogs(); });
    servicePanel.key(["escape", "q"], () => { handlers.onClose(); });
    scheduleRender();
  }
  function updateServicePanel(view: ServicePanelView): void {
    servicePanelView = view;
    renderServicePanel();
    scheduleRender();
  }
  function closeServicePanel(): void {
    servicePanel.hide();
    servicePanelHandlers = null;
    sessions.focus();
    scheduleRender();
  }
  function isServicePanelOpen(): boolean {
    return (servicePanel as any).hidden !== true;
  }
  function renderServicePanel(): void {
    if (!servicePanelView) return;
    const v = servicePanelView;
    const stateColor =
      v.state === "active" ? "green" :
      v.state === "failed" ? "red" :
      v.state === "inactive" ? "yellow" :
      v.state === "unsupported" ? "gray" : "white";
    const platformLabel =
      v.platform === "linux" ? "systemd (--user)" :
      v.platform === "darwin" ? "launchd (LaunchAgents)" :
      v.platform;
    const installedBadge = v.installed
      ? "{green-fg}[installed]{/}"
      : "{gray-fg}[not installed]{/}";
    const lastAction = v.lastAction
      ? `\n  {gray-fg}最近操作:{/} ${escapeTags(v.lastAction)}`
      : "";
    const lines = [
      "",
      `  {cyan-fg}{bold}Backend{/bold}{/}    ${platformLabel}   ${installedBadge}`,
      `  {cyan-fg}{bold}State{/bold}{/}      {${stateColor}-fg}${escapeTags(v.statusLine)}{/}`,
      lastAction ? lastAction.replace(/^\n/, "") : "",
      "",
      "  {yellow-fg}{bold}Actions{/bold}{/}",
      "    {green-fg}s{/} 启动 (start)        {yellow-fg}t{/} 停止 (stop)",
      "    {magenta-fg}r{/} 重启 (restart)     {cyan-fg}R{/} 刷新状态",
      "    {white-fg}i{/} 注册到系统         {gray-fg}u{/} 卸载",
      "    {blue-fg}l{/} 查看日志 (journalctl)",
      "",
      "  {gray-fg}按 Esc / q 关闭面板{/}",
    ];
    servicePanel.setContent(lines.join("\n"));
  }

  function destroy(): void {
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    try { screen.destroy(); } catch { /* already destroyed */ }
  }

  return {
    screen,
    refreshHeader,
    refreshSessions,
    appendLog,
    setSelectionListener,
    showHelp,
    toggleHelp,
    showToast,
    confirm,
    showDetail,
    hideDetail,
    clearLogs,
    openServicePanel,
    updateServicePanel,
    closeServicePanel,
    isServicePanelOpen,
    destroy,
  };
}

function buildHintContent(): string {
  // 两行底栏，分组展示，避免单行过长。
  const line1 =
    "{gray-fg}{bold}NAV{/bold}{/}  " +
    "{cyan-fg}↑↓{/} 选择   " +
    "{cyan-fg}r{/} 刷新   " +
    "{cyan-fg}l{/} 清日志   " +
    "{cyan-fg}?{/} 帮助   " +
    "{cyan-fg}q{/} 退出";
  const line2 =
    "{gray-fg}{bold}OPS{/bold}{/}  " +
    "{magenta-fg}g{/} 服务面板   " +
    "{magenta-fg}R{/} 重启   " +
    "{magenta-fg}u{/} 更新   " +
    "{magenta-fg}o{/} 浏览器   " +
    "{magenta-fg}c{/} 拷贝 URL";
  return `${line1}\n${line2}`;
}

function buildHelpContent(): string {
  const rows: Array<[string, string]> = [
    ["↑ / ↓", "在会话列表中上下移动"],
    ["r", "立即刷新 header 与会话列表"],
    ["l", "清空日志面板"],
    ["?  /  h", "切换本帮助面板"],
    ["q  /  Ctrl-C", "退出 wand"],
    ["—", "—"],
    ["g", "打开服务控制面板 (status/start/stop/restart/logs)"],
    ["R", "重启 wand 进程（保留同一组 argv）"],
    ["u", "检查 npm 更新，可选择安装"],
    ["o", "在默认浏览器中打开 URL"],
    ["c", "复制 URL 到剪贴板"],
    ["s", "注册为系统服务 (systemd / launchd)"],
    ["S", "卸载系统服务"],
  ];
  const lines = [
    "",
    "  {cyan-fg}{bold}NAV{/bold}{/}  浏览 & 渲染",
    "",
  ];
  let inOps = false;
  for (const [k, desc] of rows) {
    if (k === "—") {
      lines.push("");
      lines.push("  {magenta-fg}{bold}OPS{/bold}{/}  运维操作");
      lines.push("");
      inOps = true;
      continue;
    }
    const color = inOps ? "magenta-fg" : "cyan-fg";
    lines.push(`  {${color}}${padRight(k, 14)}{/}${desc}`);
  }
  lines.push("");
  lines.push("  {gray-fg}按 Esc / ? / h 关闭{/}");
  return lines.join("\n");
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

function escapeTags(text: string): string {
  // 把可能被 blessed tag parser 吞掉的 `{...}` 转为视觉相近的全角字符。
  // 这是给"tags: true"box 里嵌入用户文本时用的（confirm body / toast 等）。
  return text.replace(/\{/g, "｛").replace(/\}/g, "｝");
}

function formatRow(row: SessionRow): string {
  const glyphColor = toneColor(row.tone);
  const glyph = `{${glyphColor}-fg}${row.glyph}{/}`;
  const runner = pad(row.runner, 12);
  const cwd = pad(row.cwd, 30);
  const state = `{${toneColor(row.tone)}-fg}${pad(row.state, 9)}{/}`;
  const dur = row.duration ? `{gray-fg}${row.duration}{/}` : "";
  return `${glyph}  ${runner}  ${cwd}  ${state}  ${dur}`;
}

function pad(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width);
  return str + " ".repeat(width - str.length);
}

function toneColor(tone: SessionRow["tone"]): string {
  switch (tone) {
    case "running": return "green";
    case "idle": return "white";
    case "failed": return "red";
    case "stopped": return "yellow";
    case "exited": return "gray";
    case "archived": return "gray";
    default: return "white";
  }
}

function ansiColorize(level: LogLevel, line: string): string {
  // 把 line 内本身的颜色重置消掉（避免覆盖我们的颜色），再加上 level 颜色。
  const cleaned = stripAnsi(line);
  if (level === "error") return `\x1b[31m${cleaned}\x1b[39m`;
  if (level === "warn") return `\x1b[33m${cleaned}\x1b[39m`;
  return cleaned;
}

function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function formatTs(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const d = Math.floor(hr / 24);
  return `${d}d ${hr % 24}h`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
