import * as React from "react";
import { createPortal } from "react-dom";
import { Alert, Flex, Splitter, Typography } from "antd";
import { WandButton, WandIcon, WandIconButton, WandDropdownMenu, WandDropdownMenuTrigger, WandDropdownMenuContent, WandDropdownMenuItem } from "../ui";
import { ensureTerminalLibrary } from "../../vendor-loader.js";
import { quickTerminalRuntime } from "./runtime";
import { installQuickTerminalStyles } from "./styles";
import { QuickTerminalActionContext, QuickTerminalButton } from "./action";
import { workspaceContextStore } from "../workspaces/workspace-context";
import { useUiStoreSnapshot } from "../shell/ui-store-react";
import { readQuickTerminalPreference, saveQuickTerminalPreference, resolveQuickTerminal, withQuickTerminalLock, type TerminalDock, type QuickTerminalPreference } from "./state";

function StableSlot({ host }: { host: HTMLDivElement }) {
  const bind = React.useCallback((node: HTMLDivElement | null) => { if (node) node.appendChild(host); }, [host]);
  return <div ref={bind} style={{ width: "100%", height: "100%", minWidth: 0, minHeight: 0, overflow: "hidden" }}/>;
}

/** Portals target stable hosts: Splitter direction changes cannot remount a draft or xterm. */
export function QuickTerminalWorkspace({ children }: { children: React.ReactNode }) {
  // The shell also has a server-rendered contract used by tests and static previews.
  return typeof document === "undefined" ? <>{children}</> : <BrowserQuickTerminalWorkspace>{children}</BrowserQuickTerminalWorkspace>;
}

function BrowserQuickTerminalWorkspace({ children }: { children: React.ReactNode }) {
  const ui = useUiStoreSnapshot();
  const [preference, setPreference] = React.useState<QuickTerminalPreference>(() => {
    try { return readQuickTerminalPreference(localStorage); }
    catch { return { dock: "right" as TerminalDock, sessionId: "" }; }
  });
  const preferenceRef = React.useRef(preference);
  const [open, setOpen] = React.useState(false);
  const [menu, setMenu] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [cwd, setCwd] = React.useState("");
  const [connection, setConnection] = React.useState("未连接");
  const [error, setError] = React.useState(preference.creationPending ? "上次创建终端未确认，请先在会话列表检查；不会重复创建。" : "");
  const [storageWarning, setStorageWarning] = React.useState(false);
  const [narrow, setNarrow] = React.useState(false);
  const [ratio, setRatio] = React.useState<number | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [topbarActive, setTopbarActive] = React.useState(false);
  const frame = React.useRef<HTMLDivElement>(null);
  const button = React.useRef<HTMLButtonElement>(null);
  const session = React.useRef("");
  const pending = React.useRef(false);
  const focusIntent = React.useRef(false);
  const [chromeHost] = React.useState(() => document.createElement("div"));
  const [mainHost] = React.useState(() => document.createElement("div"));
  const [terminalHost] = React.useState(() => document.createElement("div"));
  const surface = React.useRef<HTMLDivElement>(null);
  const persist = (next: typeof preference) => {
    preferenceRef.current = next;
    setPreference(next);
    let saved = false;
    try { saved = saveQuickTerminalPreference(localStorage, next); } catch { /* storage getter can be denied */ }
    setStorageWarning(!saved);
  };
  React.useLayoutEffect(() => {
    installQuickTerminalStyles();
    chromeHost.style.width = "100%";
    for (const host of [mainHost, terminalHost]) Object.assign(host.style, { width: "100%", height: "100%", minWidth: "0", minHeight: "0", display: "flex", flexDirection: "column" });
    const observer = new ResizeObserver(entries => setNarrow(entries[0].contentRect.width < 680));
    if (frame.current) observer.observe(frame.current);
    return () => observer.disconnect();
  }, [chromeHost, mainHost, terminalHost]);
  React.useEffect(() => quickTerminalRuntime().observe(event => {
    if (!session.current || (event.sessionId && event.sessionId !== session.current)) return;
    if (event.type === "init") {
      const ended = ["stopped", "exited", "failed"].includes(event.data?.status || "");
      setConnection(ended ? "进程已结束" : "已连接"); setError("");
      if (event.data?.cwd) setCwd(event.data.cwd);
      if (focusIntent.current && !ended) {
        const active = document.activeElement;
        if (active === button.current || active === document.body || terminalHost.contains(active)) quickTerminalRuntime().focus(session.current);
        focusIntent.current = false;
      }
    } else if (event.type === "disconnected") setConnection("已断开 · 自动重连中");
    else if (event.type === "connected" || event.type === "resync_required") setConnection("连接中");
    else if (event.type === "pty_error" || event.type === "error") {
      setConnection("连接异常"); setError("终端操作未确认，请检查输出后重新连接；不会自动重发输入。");
    } else if (event.type === "ended" || (event.type === "status" && ["stopped", "exited", "failed"].includes(event.data?.status || ""))) setConnection("进程已结束");
  }), [terminalHost]);
  React.useEffect(() => () => {
    if (session.current) {
      quickTerminalRuntime().retain(session.current, false);
      quickTerminalRuntime().dispose(session.current); // client lease only, never a stop/delete request
    }
  }, []);
  // Async connection/resize never steal focus from the editor the user returned to.
  const show = async () => {
    setOpen(true); setMenu(false);
    focusIntent.current = true;
    if (session.current) { quickTerminalRuntime().focus(session.current); return; }
    if (pending.current) return;
    pending.current = true; setBusy(true); setConnection("连接中");
    try {
      const context = workspaceContextStore.getSnapshot();
      const directory = ui.selected?.worktree?.path || context.cwd || ui.selected?.cwd || "~";
      const result = await withQuickTerminalLock(async () => {
        let current = preferenceRef.current;
        try {
          const stored = readQuickTerminalPreference(localStorage);
          if (stored.sessionId || stored.creationPending) current = stored;
        } catch { /* this page still retains the unconfirmed-creation guard */ }
        if (!current.sessionId && current.creationPending) throw new Error("上次创建终端未确认，请先在会话列表检查；不会重复创建。");
        if (!current.sessionId) persist({ ...current, creationPending: true });
        const resolved = await resolveQuickTerminal(current.sessionId, directory);
        // Commit before releasing the cross-window lock.
        persist({ dock: preferenceRef.current.dock, sessionId: resolved.id });
        return resolved;
      });
      session.current = result.id;
      setCwd(result.cwd);
      await ensureTerminalLibrary();
      if (!surface.current) throw new Error("终端容器尚未就绪，请重新连接。");
      quickTerminalRuntime().retain(result.id, true);
      if (!quickTerminalRuntime().mount(result.id, surface.current)) throw new Error("终端组件加载失败，请重新连接。");
    } catch (cause) {
      setConnection("连接失败"); setError(cause instanceof Error ? cause.message : "终端连接失败");
    } finally { pending.current = false; setBusy(false); }
  };
  const close = () => {
    focusIntent.current = false; setMenu(false); setOpen(false);
    button.current?.focus({ preventScroll: true });
  };
  const dock = narrow ? "bottom" : preference.dock;
  const changeDock = (next: TerminalDock) => { persist({ ...preference, dock: next }); setRatio(null); };
  const retry = async () => {
    if (!session.current) {
      if (preference.sessionId) {
        try {
          const result = await resolveQuickTerminal(preference.sessionId, "~");
          session.current = result.id; setCwd(result.cwd);
          quickTerminalRuntime().retain(result.id, true);
        } catch { setError("原终端暂不可用，请检查连接或在会话列表确认；不会自动新建。"); return; }
      } else { setError("请先在会话列表确认原终端，避免重复创建进程。"); return; }
    }
    try {
      await ensureTerminalLibrary();
      if (surface.current) quickTerminalRuntime().mount(session.current, surface.current);
      quickTerminalRuntime().reconnect(session.current); setConnection("连接中"); setError("");
    } catch { setError("终端组件加载失败，请重试连接。"); }
  };
  return <QuickTerminalActionContext.Provider value={{ open, show: () => { void show(); }, trigger: button, chromeHost, setTopbarActive }}><Flex vertical ref={frame} className="quick-terminal-workspace" style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
    <Flex align="center" justify="end" className="quick-terminal-toolbar" style={{ padding: topbarActive ? 0 : "2px var(--wand-page-inset, 20px)", borderBottom: topbarActive ? undefined : "1px solid var(--border-subtle)", flexShrink: 0 }}>
      <div style={{ width: "100%", display: topbarActive ? undefined : "none" }}><StableSlot host={chromeHost}/></div>
      {!topbarActive && <QuickTerminalButton/>}
    </Flex>
    <Splitter key={dock} orientation={dock === "right" ? "horizontal" : "vertical"} className="quick-terminal-split" data-dragging={dragging} onResizeStart={() => setDragging(true)} onResizeEnd={() => setDragging(false)} style={{ flex: 1, minHeight: 0, minWidth: 0 }} onResize={sizes => { const total = sizes[0] + sizes[1]; if (open && total) setRatio(sizes[1] / total * 100); }}>
      <Splitter.Panel min={open ? "20%" : 0} size={open ? `${100 - (ratio ?? (dock === "right" ? 40 : 35))}%` : "100%"}><StableSlot host={mainHost}/></Splitter.Panel>
      <Splitter.Panel min={open ? "25%" : 0} max="70%" size={open ? `${ratio ?? (dock === "right" ? 40 : 35)}%` : 0} resizable={open}><StableSlot host={terminalHost}/></Splitter.Panel>
    </Splitter>
    {createPortal(children, mainHost)}
    {createPortal(<section id="quick-terminal-panel" aria-label="快捷终端" aria-hidden={!open} inert={!open} className="quick-terminal-panel" data-open={open} data-dock={dock} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", background: "var(--bg-primary)" }}>
      <Flex align="center" gap={8} wrap style={{ padding: "6px 8px", flexShrink: 0, borderBottom: "1px solid var(--border-subtle)" }}>
        <Typography.Text strong>终端</Typography.Text>
        <Typography.Text type="secondary" role="status">{busy ? "连接中" : connection}</Typography.Text>
        <Typography.Text ellipsis={{ tooltip: cwd || "服务端主目录" }} title={cwd || "服务端主目录"} style={{ flex: "1 1 100px", minWidth: 0 }}>{cwd || "服务端主目录"}</Typography.Text>
        <WandDropdownMenu open={menu && open} onOpenChange={setMenu}>
          <WandDropdownMenuTrigger render={<WandButton kind="ghost" aria-label={`停靠位置：${preference.dock === "right" ? "右侧" : "底部"}`}>停靠位置：{preference.dock === "right" ? "右侧" : "底部"}</WandButton>}/>
          <WandDropdownMenuContent aria-label="停靠位置" align="end">
            <WandDropdownMenuItem onSelect={() => changeDock("right")} hint={preference.dock === "right" ? "已选" : undefined}>右侧</WandDropdownMenuItem>
            <WandDropdownMenuItem onSelect={() => changeDock("bottom")} hint={preference.dock === "bottom" ? "已选" : undefined}>底部</WandDropdownMenuItem>
          </WandDropdownMenuContent>
        </WandDropdownMenu>
        <WandIconButton aria-label="关闭终端面板" title="仅隐藏面板，命令继续运行；结束 shell 请在终端输入 exit" onClick={close}><WandIcon name="close" size={16}/></WandIconButton>
      </Flex>
      <Typography.Text type="secondary" style={{ padding: "2px 8px", fontSize: 12 }}>Wand / PTY 主机 · 关闭仅隐藏 · 结束 shell 输入 exit{narrow && preference.dock === "right" ? " · 窄窗临时底部显示" : ""}</Typography.Text>
      {storageWarning && <Alert type="warning" title="本页已应用，但客户端存储不可用，刷新后可能无法恢复位置或终端。"/>}
      {error && <Alert type="error" title={error} action={session.current || preference.sessionId ? <WandButton onClick={() => void retry()}>重新连接</WandButton> : undefined}/>}
      {!error && (connection !== "已连接" && connection !== "进程已结束") && session.current && <WandButton kind="ghost" onClick={() => void retry()}>重新连接原终端</WandButton>}
      <div ref={surface} className="quick-terminal-surface" style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative", overflow: "hidden" }}/>
    </section>, terminalHost)}
  </Flex></QuickTerminalActionContext.Provider>;
}
