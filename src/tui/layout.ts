import { createRequire } from "node:module";
import { LogLevel, LogRecord } from "./log-bus.js";
import { SessionRow } from "./session-formatter.js";

const require = createRequire(import.meta.url);
// neo-blessed 是 CJS，没有匹配 @types/blessed 的 default export，统一当 any 用。
const blessed = require("neo-blessed") as any;

const HEADER_HEIGHT = 6;
const SESSIONS_HEIGHT = 12;
const LOG_TOP = HEADER_HEIGHT + SESSIONS_HEIGHT;
const LOG_BUFFER_LIMIT = 1000;
const RENDER_THROTTLE_MS = 50;

export interface HeaderInfo {
  version: string;
  url: string;
  scheme: "HTTP" | "HTTPS";
  bindAddr: string;
  configPath: string;
  dbPath: string;
  orphanRecoveredCount: number;
  sessionCounts: { active: number; archived: number; total: number };
}

export interface LayoutHandle {
  screen: any;
  refreshHeader(info: HeaderInfo): void;
  refreshSessions(rows: SessionRow[]): void;
  appendLog(record: LogRecord): void;
  setSelectionListener(listener: (index: number) => void): void;
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
    label: " wand ",
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
    bottom: 1,
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
    height: 1,
    tags: true,
    content: "{gray-fg}[q]uit  [r]efresh  [↑↓] navigate{/}",
  });

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
    const orphan = info.orphanRecoveredCount > 0
      ? `  {gray-fg}(${info.orphanRecoveredCount} orphan PTYs cleaned){/}`
      : "";
    const counts = info.sessionCounts;
    const sess = `${counts.active} active · ${counts.archived} archived · ${counts.total} total`;
    const lines = [
      `{cyan-fg}Version{/}    ${info.version}`,
      `{cyan-fg}URL{/}        ${info.url} {gray-fg}(${info.scheme}, bind ${info.bindAddr}){/}`,
      `{cyan-fg}Config{/}     ${info.configPath}`,
      `{cyan-fg}Database{/}   ${info.dbPath}`,
      `{cyan-fg}Sessions{/}   ${sess}${orphan}`,
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

  function destroy(): void {
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    try { screen.destroy(); } catch { /* already destroyed */ }
  }

  return {
    screen,
    refreshHeader,
    refreshSessions,
    appendLog,
    setSelectionListener,
    destroy,
  };
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
