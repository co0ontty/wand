import * as React from "react";
import { createPortal } from "react-dom";
import { Alert, Badge, Flex, Splitter, Typography } from "antd";
import { WandButton, WandIconButton } from "../ui/button";
import { WandIcon } from "../ui/icons";
import { WandDropdownMenu, WandDropdownMenuTrigger, WandDropdownMenuContent, WandDropdownMenuItem, WandDropdownMenuSeparator } from "../ui/dropdown-menu";
import { ensureTerminalLibrary } from "../../vendor-loader.js";
import { quickTerminalRuntime, terminalConnectionLabel } from "./runtime";
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
  const [chromeOwners, setChromeOwners] = React.useState<ReadonlySet<string>>(() => new Set());
  const registerChrome = React.useCallback((owner: string) => {
    setChromeOwners(previous => new Set(previous).add(owner));
    return () => setChromeOwners(previous => { const next = new Set(previous); next.delete(owner); return next; });
  }, []);
  const topbarActive = chromeOwners.size > 0;
  const frame = React.useRef<HTMLDivElement>(null);
  const button = React.useRef<HTMLButtonElement>(null);
  const session = React.useRef("");
  const attached = React.useRef(false);
  const visible = React.useRef(false);
  const lifetime = React.useRef(0);
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
  const focusRequestedTerminal = React.useCallback(() => {
    if (!focusIntent.current || !visible.current || !attached.current || !session.current) return;
    const active = document.activeElement;
    if (active === button.current || active === document.body || terminalHost.contains(active)) quickTerminalRuntime().focus(session.current);
    focusIntent.current = false;
  }, [terminalHost]);
  // A retained terminal is still inert while show() is handling the click.
  // Focus only after React removes inert and applies the reopened layout.
  React.useLayoutEffect(() => { if (open) focusRequestedTerminal(); }, [open, focusRequestedTerminal]);
  React.useEffect(() => quickTerminalRuntime().observe(event => {
    const label = terminalConnectionLabel(session.current, event);
    if (!label) return;
    setConnection(label);
    if (event.type === "init") {
      setError("");
      if (event.data?.cwd) setCwd(event.data.cwd);
      if (label === "已连接") focusRequestedTerminal();
    } else if (label === "连接异常") setError("终端操作未确认，请检查输出后重新连接；不会自动重发输入。");
  }), [focusRequestedTerminal]);
  React.useEffect(() => () => {
    lifetime.current++;
    attached.current = false;
    focusIntent.current = false;
    pending.current = false;
    if (session.current) {
      quickTerminalRuntime().retain(session.current, false);
      quickTerminalRuntime().dispose(session.current); // client lease only, never a stop/delete request
    }
  }, []);
  // Async connection/resize never steal focus from the editor the user returned to.
  const show = async (reconnect = false) => {
    visible.current = true;
    setOpen(true); setMenu(false);
    focusIntent.current = true;
    if (session.current && attached.current && !reconnect) {
      if (open) focusRequestedTerminal();
      return;
    }
    if (pending.current) return;
    const attempt = lifetime.current;
    pending.current = true; setBusy(true); setConnection("连接中"); setError("");
    try {
      const context = workspaceContextStore.getSnapshot();
      const directory = ui.selected?.worktree?.path || context.cwd || ui.selected?.cwd || "~";
      const result = session.current ? { id: session.current, cwd } : await withQuickTerminalLock(async () => {
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
      if (attempt !== lifetime.current) return;
      session.current = result.id;
      setCwd(result.cwd);
      await ensureTerminalLibrary();
      if (attempt !== lifetime.current) return;
      if (!surface.current) throw new Error("终端容器尚未就绪，请重新连接。");
      quickTerminalRuntime().retain(result.id, true);
      if (!quickTerminalRuntime().mount(result.id, surface.current)) throw new Error("终端组件加载失败，请重新连接。");
      attached.current = true;
      if (reconnect) quickTerminalRuntime().reconnect(result.id);
    } catch (cause) {
      if (attempt !== lifetime.current) return;
      setConnection("连接失败"); setError(cause instanceof Error ? cause.message : "终端连接失败");
    } finally {
      if (attempt === lifetime.current) { pending.current = false; setBusy(false); }
    }
  };
  const close = () => {
    visible.current = false;
    focusIntent.current = false; setMenu(false); setOpen(false);
    button.current?.focus({ preventScroll: true });
  };
  const dock = narrow ? "bottom" : preference.dock;
  const changeDock = (next: TerminalDock) => { persist({ ...preferenceRef.current, dock: next }); setRatio(null); };
  const canReconnect = !!(session.current || preference.sessionId);
  return <QuickTerminalActionContext.Provider value={{ open, show: () => { void show(); }, trigger: button, chromeHost, registerChrome }}><Flex vertical ref={frame} className="quick-terminal-workspace" style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
    <Flex align="center" justify="end" className="quick-terminal-toolbar" style={{ padding: topbarActive ? 0 : "2px var(--wand-page-inset, 20px)", borderBottom: topbarActive ? undefined : "1px solid var(--border-subtle)", flexShrink: 0 }}>
      <div style={{ width: "100%", display: topbarActive ? undefined : "none" }}><StableSlot host={chromeHost}/></div>
      {!topbarActive && <QuickTerminalButton/>}
    </Flex>
    <Splitter key={dock} orientation={dock === "right" ? "horizontal" : "vertical"} className="quick-terminal-split" data-dragging={dragging} onResizeStart={() => setDragging(true)} onResizeEnd={() => setDragging(false)} style={{ flex: 1, minHeight: 0, minWidth: 0 }} onResize={sizes => { const total = sizes[0] + sizes[1]; if (open && total) setRatio(sizes[1] / total * 100); }}>
      <Splitter.Panel min={open ? "20%" : 0} size={open ? `${100 - (ratio ?? (dock === "right" ? 40 : 35))}%` : "100%"}><StableSlot host={mainHost}/></Splitter.Panel>
      <Splitter.Panel min={open ? "25%" : 0} max="70%" size={open ? `${ratio ?? (dock === "right" ? 40 : 35)}%` : 0} resizable={open}><StableSlot host={terminalHost}/></Splitter.Panel>
    </Splitter>
    {createPortal(children, mainHost)}
    {createPortal(<section id="quick-terminal-panel" aria-label="快捷终端" aria-describedby="quick-terminal-description" aria-hidden={!open} inert={!open} className="quick-terminal-panel" data-open={open} data-dock={dock}>
      <Flex align="center" gap={8} className="quick-terminal-header">
        <Typography.Text strong className="quick-terminal-title">终端</Typography.Text>
        <span role="status" className="quick-terminal-status" title={busy ? "连接中" : connection}>
          {!busy && connection === "已连接" ? <><Badge status="success" aria-hidden/><span className="workbar-accessible-title">已连接</span></> : busy ? "连接中" : connection}
        </span>
        <Typography.Text ellipsis={{ tooltip: cwd || "服务端主目录" }} title={cwd || "服务端主目录"} className="quick-terminal-directory">{cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd || "服务端主目录"}</Typography.Text>
        <WandDropdownMenu open={menu && open} onOpenChange={setMenu}>
          <WandDropdownMenuTrigger render={<WandIconButton aria-label="终端选项" title={`终端选项 · ${dock === "right" ? "右侧" : "底部"}停靠`}><WandIcon name="more" size={16}/></WandIconButton>}/>
          <WandDropdownMenuContent aria-label="终端选项" align="end">
            <WandDropdownMenuItem onSelect={() => changeDock("right")} hint={preference.dock === "right" ? "已选" : undefined}>停靠到右侧</WandDropdownMenuItem>
            <WandDropdownMenuItem onSelect={() => changeDock("bottom")} hint={preference.dock === "bottom" ? "已选" : undefined}>停靠到底部</WandDropdownMenuItem>
            <WandDropdownMenuSeparator/>
            <WandDropdownMenuItem icon="refresh" disabled={busy || !canReconnect} onSelect={() => void show(true)}>重新连接</WandDropdownMenuItem>
          </WandDropdownMenuContent>
        </WandDropdownMenu>
        <WandIconButton aria-label="关闭终端面板" title="仅隐藏面板，命令继续运行；结束 shell 请在终端输入 exit" onClick={close}><WandIcon name="close" size={16}/></WandIconButton>
      </Flex>
      <span id="quick-terminal-description" className="workbar-accessible-title">运行在 Wand 主机；关闭仅隐藏，命令继续运行。结束 shell 请在终端输入 exit。{narrow && preference.dock === "right" ? "窄窗临时在底部显示。" : ""}</span>
      {storageWarning && <Alert type="warning" title="本页已应用，但客户端存储不可用，刷新后可能无法恢复位置或终端。"/>}
      {error && <Alert type="error" title={error} action={canReconnect ? <WandButton disabled={busy} onClick={() => void show(true)}>重新连接</WandButton> : undefined}/>}
      <div ref={surface} className="quick-terminal-surface" style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative", overflow: "hidden" }}/>
    </section>, terminalHost)}
  </Flex></QuickTerminalActionContext.Provider>;
}
