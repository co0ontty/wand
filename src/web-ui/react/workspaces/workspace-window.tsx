// 活动工作窗口为 split 时取代单例终端槽位：split 节点递归渲染两个窗格和可拖拽 sash，
// pane 节点只显示窗格标题/窗口控制（不是第二层 Tab）。终端实例来自 terminal-pool，
// 每个 session 独立路由 input/output/resize，并拥有自己的缩放比例。

import * as React from "react";

import { workspaceContextStore } from "./workspace-context";
import { workspacesStore } from "./controller";
import { httpWorkspacesRepository } from "./repository";
import { setRatioAtPath } from "./layout-tree";
import {
  listSessionLabel,
  orderWorkspaceSessions,
  withLiveSessionTitle,
  workspaceProviderLabel,
} from "./session-order";
import type { LayoutNode, PaneTab, WorkspaceSessionSummary } from "./types";
import { SessionProviderMark } from "./session-mark";
import { classNames } from "../ui/class-names";
import { useUiDispatch, useUiStoreSnapshot } from "../shell/ui-store-react";
import {
  activeWorkWindow,
  activeWorkWindowTab,
  closeSessionPane,
  extractSessionWindow,
  focusWorkWindowTab,
  replaceWorkWindowLayout,
  ungroupWorkWindow,
} from "./window-layout";

function runtime() {
  return workspacesStore.getRuntime();
}

interface SessionMeta {
  title?: string;
  provider?: string;
  command?: string;
}

interface WindowApi {
  root: LayoutNode;
  sessionMeta: Map<string, SessionMeta>;
  mutateRoot(next: LayoutNode): void;
  focusTab(tab: PaneTab): void;
  closeTab(tab: PaneTab): void;
  closingSessionId: string | null;
  extractTab(tab: PaneTab): void;
  ungroupWindow(): void;
  openFiles(): void;
}

function paneLabel(tab: PaneTab, meta: Map<string, SessionMeta>): string {
  if (tab.kind !== "session") return tab.kind;
  const m = meta.get(tab.sessionId);
  const title = (m?.title || "").trim();
  if (title) return title;
  return m?.provider ? workspaceProviderLabel(m.provider) : "会话";
}

/** 在窗格容器里挂一个池终端（sessionId 自路由 input/resize/output）。 */
function SessionPane({ sessionId }: { sessionId: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const rt = runtime();
    const node = ref.current;
    if (!rt || !node) return;
    rt.mountSessionTerminal(sessionId, node);
    return () => rt.unmountSessionTerminal(sessionId);
  }, [sessionId]);
  return <div className="ws-session-pane" ref={ref} />;
}

function PaneEmpty() {
  return <div className="ws-pane-empty">这个窗格没有可显示的终端</div>;
}

function PaneNode({ pane, path, api }: { pane: Extract<LayoutNode, { type: "pane" }>; path: readonly number[]; api: WindowApi }) {
  const activeTab = pane.tabs[pane.active] ?? pane.tabs[0];
  const isPrimary = path.every((index) => index === 0);
  const sessionId = activeTab?.kind === "session" ? activeTab.sessionId : null;
  const sessionMeta = sessionId ? api.sessionMeta.get(sessionId) : undefined;
  const [scale, setScale] = React.useState(() => {
    const rt = runtime();
    return sessionId && rt ? rt.getSessionTerminalScale(sessionId) : 1;
  });

  React.useEffect(() => {
    const rt = runtime();
    setScale(sessionId && rt ? rt.getSessionTerminalScale(sessionId) : 1);
  }, [sessionId]);

  const changeScale = (next: number) => {
    const rt = runtime();
    if (!sessionId || !rt) return;
    setScale(rt.setSessionTerminalScale(sessionId, next));
  };

  return (
    <div
      className="ws-pane"
      onPointerDownCapture={() => {
        if (activeTab) api.focusTab(activeTab);
      }}
    >
      <div className="ws-pane-toolbar">
        <span className="ws-pane-title" title={activeTab ? paneLabel(activeTab, api.sessionMeta) : "空窗格"}>
          {sessionMeta ? <SessionProviderMark session={sessionMeta} className="ws-pane-logo"/> : null}
          {activeTab ? paneLabel(activeTab, api.sessionMeta) : "空窗格"}
        </span>
        {sessionId ? (
          <div className="ws-pane-scale" role="group" aria-label={`${paneLabel(activeTab, api.sessionMeta)} 终端缩放`}>
            <button
              type="button"
              className="ws-pane-scale-btn"
              aria-label="缩小终端"
              title="缩小这个终端"
              onClick={(event) => { event.stopPropagation(); changeScale(scale - 0.25); }}
            >−</button>
            <button
              type="button"
              className="ws-pane-scale-value"
              aria-label={`恢复终端缩放，当前 ${Math.round(scale * 100)}%`}
              title="恢复为 100%"
              onClick={(event) => { event.stopPropagation(); changeScale(1); }}
            >{Math.round(scale * 100)}%</button>
            <button
              type="button"
              className="ws-pane-scale-btn"
              aria-label="放大终端"
              title="放大这个终端"
              onClick={(event) => { event.stopPropagation(); changeScale(scale + 0.25); }}
            >+</button>
          </div>
        ) : null}
        {activeTab?.kind === "session" ? (
          <button
            type="button"
            className="ws-pane-btn extract"
            title="把这个终端移出为独立工作窗口 Tab"
            aria-label="移出为新 Tab"
            onClick={(event) => {
              event.stopPropagation();
              api.extractTab(activeTab);
            }}
          >
            ↗
          </button>
        ) : null}
        {activeTab?.kind === "session" ? (
          <button
            type="button"
            className="ws-pane-btn close"
            title="关闭这个终端"
            aria-label={`关闭终端 ${paneLabel(activeTab, api.sessionMeta)}`}
            disabled={api.closingSessionId === activeTab.sessionId}
            onClick={(event) => {
              event.stopPropagation();
              api.closeTab(activeTab);
            }}
          >
            ×
          </button>
        ) : null}
        {isPrimary ? (
          <>
            <button
              type="button"
              className="ws-pane-btn files"
              title="打开文件面板"
              aria-label="文件"
              onClick={api.openFiles}
            >
              ▤
            </button>
            <button
              type="button"
              className="ws-pane-btn exit"
              title="把当前分屏拆成独立工作窗口 Tabs"
              aria-label="全部移出为独立 Tabs"
              onClick={api.ungroupWindow}
            >
              ◫
            </button>
          </>
        ) : null}
      </div>
      <div className="ws-pane-content">
        {activeTab && activeTab.kind === "session"
          ? <SessionPane sessionId={activeTab.sessionId} />
          : <PaneEmpty />}
      </div>
    </div>
  );
}

function SplitNode({ node, path, api }: { node: Extract<LayoutNode, { type: "split" }>; path: readonly number[]; api: WindowApi }) {
  const [ratio, setRatio] = React.useState(node.ratio);
  const ratioRef = React.useRef(node.ratio);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const dragging = React.useRef(false);

  React.useEffect(() => {
    ratioRef.current = node.ratio;
    setRatio(node.ratio);
  }, [node.ratio]);

  const horizontal = node.dir === "h";

  const onPointerDown = (event: React.PointerEvent) => {
    dragging.current = true;
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* ignore */ }
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const raw = horizontal
      ? (event.clientX - rect.left) / rect.width
      : (event.clientY - rect.top) / rect.height;
    const nextRatio = Math.max(0.1, Math.min(0.9, raw));
    ratioRef.current = nextRatio;
    setRatio(nextRatio);
  };
  const onPointerUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    api.mutateRoot(setRatioAtPath(api.root, path, ratioRef.current));
  };

  return (
    <div className={classNames("ws-split", horizontal ? "h" : "v")} ref={containerRef}>
      <div className="ws-split-child" style={{ flexBasis: `${ratio * 100}%`, flexGrow: 0, flexShrink: 0 }}>
        <LayoutRenderer node={node.children[0]} path={[...path, 0]} api={api} />
      </div>
      <div
        className={classNames("ws-sash", horizontal ? "h" : "v")}
        role="separator"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div className="ws-split-child" style={{ flex: 1 }}>
        <LayoutRenderer node={node.children[1]} path={[...path, 1]} api={api} />
      </div>
    </div>
  );
}

function LayoutRenderer({ node, path, api }: { node: LayoutNode; path: readonly number[]; api: WindowApi }) {
  return node.type === "split"
    ? <SplitNode node={node} path={path} api={api} />
    : <PaneNode pane={node} path={path} api={api} />;
}

/** 轮询任务详情，拿会话标题/provider 给窗格标题显示。 */
function useTaskSessionMeta(
  taskId: string | null,
  parentNames: readonly string[] = [],
  liveTitles: ReadonlyMap<string, string> = new Map(),
): Map<string, SessionMeta> {
  const [sessions, setSessions] = React.useState<WorkspaceSessionSummary[]>([]);
  React.useEffect(() => {
    if (!taskId) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const detail = await httpWorkspacesRepository.getTask(taskId);
        if (cancelled || !detail) return;
        setSessions(orderWorkspaceSessions(detail.sessions));
      } catch { /* ignore */ }
    };
    void load();
    const timer = window.setInterval(() => void load(), 4_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [taskId]);
  const meta = new Map<string, SessionMeta>();
  sessions.forEach((s, index) => {
    const session = withLiveSessionTitle(s, liveTitles.get(s.id));
    meta.set(s.id, {
      title: listSessionLabel(session, index, parentNames),
      provider: session.provider,
      command: session.command,
    });
  });
  return meta;
}

export function WorkspaceWindow(): React.ReactElement | null {
  const dispatch = useUiDispatch();
  const snapshot = useUiStoreSnapshot();
  const [closingSessionId, setClosingSessionId] = React.useState<string | null>(null);
  const context = React.useSyncExternalStore(
    workspaceContextStore.subscribe,
    workspaceContextStore.getSnapshot,
    workspaceContextStore.getServerSnapshot,
  );
  const parentNames = [context.taskName, context.workspaceName].map((name) => name.trim()).filter(Boolean);
  const liveTitles = new Map(snapshot.sidebar.groups.flatMap((group) => (
    group.entries.map((entry) => [entry.id, entry.title] as const)
  )));
  const sessionMeta = useTaskSessionMeta(context.taskId, parentNames, liveTitles);

  // 分屏关闭 / 任务切换时，释放所有池终端。
  React.useEffect(() => {
    return () => {
      // 组件卸载（退出分屏视图）时清池。
      runtime()?.disposeAllSessionTerminals();
    };
  }, []);

  const taskLayout = context.layout;
  const workWindow = activeWorkWindow(taskLayout);
  if (!context.taskId || !taskLayout || !workWindow || workWindow.layout.type !== "split") return null;
  const root = workWindow.layout;
  const rt = runtime();
  if (!rt) return null;

  const api: WindowApi = {
    root,
    sessionMeta,
    closingSessionId,
    mutateRoot(next) {
      rt.saveTaskLayout(replaceWorkWindowLayout(taskLayout, workWindow.id, next));
    },
    focusTab(tab) {
      const next = focusWorkWindowTab(taskLayout, workWindow.id, tab.id);
      if (next === taskLayout) return;
      rt.saveTaskLayout(next);
      if (tab.kind === "session") void dispatch({ type: "session.select", id: tab.sessionId });
    },
    async closeTab(tab) {
      if (tab.kind !== "session" || closingSessionId) return;
      setClosingSessionId(tab.sessionId);
      try {
        if (!await rt.closeTaskSessions([tab.sessionId], "terminal")) return;
        const next = closeSessionPane(taskLayout, tab.sessionId);
        rt.saveTaskLayout(next);
        const active = activeWorkWindowTab(next);
        if (active?.kind === "session") void dispatch({ type: "session.select", id: active.sessionId });
        rt.toast("已关闭终端", "success");
      } finally {
        setClosingSessionId(null);
      }
    },
    extractTab(tab) {
      if (tab.kind !== "session") return;
      const next = extractSessionWindow(taskLayout, tab.sessionId);
      rt.saveTaskLayout(next);
      void dispatch({ type: "session.select", id: tab.sessionId });
    },
    ungroupWindow() {
      const next = ungroupWorkWindow(taskLayout, workWindow.id);
      rt.saveTaskLayout(next);
      const active = activeWorkWindowTab(next);
      if (active?.kind === "session") void dispatch({ type: "session.select", id: active.sessionId });
    },
    openFiles() {
      void dispatch({ type: "layout.files.toggle" });
    },
  };

  return (
    <div className="workspace-window">
      <div className="workspace-window-body">
        <LayoutRenderer node={root} path={[]} api={api} />
      </div>
    </div>
  );
}
