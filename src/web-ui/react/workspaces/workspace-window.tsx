import { WandButton } from "../ui";
import { Empty, Flex, Splitter, Typography } from "../design-library";
// 活动工作窗口为 split 时取代单例终端槽位：split 节点递归渲染两个窗格和可拖拽 sash，
// pane 节点只显示窗格标题/窗口控制（不是第二层 Tab）。终端实例来自 terminal-pool，
// 每个 session 独立路由 input/output/resize，并拥有自己的缩放比例。

import * as React from "react";

import { workspaceContextStore } from "./workspace-context";
import { workspacesStore } from "./controller";
import { useTaskDetail } from "./task-detail-store";
import { setRatioAtPath } from "./layout-tree";
import {
  listSessionLabel,
  orderWorkspaceSessions,
  withLiveSessionTitle,
  workspaceProviderLabel,
} from "./session-order";
import type { LayoutNode, PaneTab } from "./types";
import { SessionProviderMark } from "./session-mark";
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
const pendingTerminalUnmounts = new Map<string, () => void>();

function SessionPane({ sessionId }: { sessionId: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const rt = runtime();
    const node = ref.current;
    if (!rt || !node) return;
    pendingTerminalUnmounts.delete(sessionId);
    rt.mountSessionTerminal(sessionId, node);
    return () => {
      // A Splitter direction change replaces panel containers in one commit.
      // Let the new pane move the existing terminal before releasing its lease.
      const dispose = () => rt.unmountSessionTerminal(sessionId);
      pendingTerminalUnmounts.set(sessionId, dispose);
      queueMicrotask(() => {
        if (pendingTerminalUnmounts.get(sessionId) !== dispose) return;
        pendingTerminalUnmounts.delete(sessionId);
        dispose();
      });
    };
  }, [sessionId]);
  return <div className="ws-session-pane" ref={ref} style={{ height: "100%", width: "100%", position: "relative" }} />;
}

function PaneEmpty() {
  return <Empty className="ws-pane-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个窗格没有可显示的终端"/>;
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
    <Flex vertical
      className="ws-pane" style={{ height: "100%", minHeight: 0, minWidth: 0 }}
      onPointerDownCapture={() => {
        if (activeTab) api.focusTab(activeTab);
      }}
    >
      <Flex align="center" gap="small" wrap className="ws-pane-toolbar" style={{ padding: 8, flexShrink: 0 }}>
        <Flex align="center" gap={4} style={{ flex: "1 1 140px", minWidth: 0 }}>
          {sessionMeta ? <SessionProviderMark session={sessionMeta} className="ws-pane-logo" size={14}/> : null}
          <Typography.Text ellipsis style={{ flex: 1, minWidth: 0 }} className="ws-pane-title" title={activeTab ? paneLabel(activeTab, api.sessionMeta) : "空窗格"}>
            {activeTab ? paneLabel(activeTab, api.sessionMeta) : "空窗格"}
          </Typography.Text>
        </Flex>
        {sessionId ? (
          <Flex align="center" gap={4} className="ws-pane-scale" role="group" aria-label={`${paneLabel(activeTab, api.sessionMeta)} 终端缩放`}>
            <WandButton kind="ghost"
              type="button"
              className="ws-pane-scale-btn"
              aria-label="缩小终端"
              title="缩小这个终端"
              onClick={(event) => { event.stopPropagation(); changeScale(scale - 0.25); }}
            >−</WandButton>
            <WandButton kind="ghost"
              type="button"
              className="ws-pane-scale-value"
              aria-label={`恢复终端缩放，当前 ${Math.round(scale * 100)}%`}
              title="恢复为 100%"
              onClick={(event) => { event.stopPropagation(); changeScale(1); }}
            >{Math.round(scale * 100)}%</WandButton>
            <WandButton kind="ghost"
              type="button"
              className="ws-pane-scale-btn"
              aria-label="放大终端"
              title="放大这个终端"
              onClick={(event) => { event.stopPropagation(); changeScale(scale + 0.25); }}
            >+</WandButton>
          </Flex>
        ) : null}
        {activeTab?.kind === "session" ? (
          <WandButton kind="ghost"
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
          </WandButton>
        ) : null}
        {activeTab?.kind === "session" ? (
          <WandButton kind="ghost"
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
          </WandButton>
        ) : null}
        {isPrimary ? (
          <>
            <WandButton kind="ghost"
              type="button"
              className="ws-pane-btn files"
              title="打开文件面板"
              aria-label="文件"
              onClick={api.openFiles}
            >
              ▤
            </WandButton>
            <WandButton kind="ghost"
              type="button"
              className="ws-pane-btn exit"
              title="把当前分屏拆成独立工作窗口 Tabs"
              aria-label="全部移出为独立 Tabs"
              onClick={api.ungroupWindow}
            >
              ◫
            </WandButton>
          </>
        ) : null}
      </Flex>
      <div className="ws-pane-content" style={{ flex: 1, minHeight: 0, position: "relative", contain: "strict", isolation: "isolate", background: "var(--bg-terminal)" }}>
        {activeTab && activeTab.kind === "session"
          ? <SessionPane sessionId={activeTab.sessionId} />
          : <PaneEmpty />}
      </div>
    </Flex>
  );
}

function SplitNode({ node, path, api }: { node: Extract<LayoutNode, { type: "split" }>; path: readonly number[]; api: WindowApi }) {
  const [ratio, setRatio] = React.useState(node.ratio);
  React.useEffect(() => setRatio(node.ratio), [node.ratio]);
  const ratioFromSizes = (sizes: number[]) => {
    const total = sizes.reduce((sum, size) => sum + size, 0);
    return total > 0 ? Math.max(0.1, Math.min(0.9, sizes[0] / total)) : node.ratio;
  };
  // Ant 6 caches the measured axis until the outer box resizes. A direction
  // change must reset that measurement even when the box has the same bounds.
  return <Splitter key={node.dir} className="ws-split" orientation={node.dir === "h" ? "horizontal" : "vertical"}
    style={{ width: "100%", height: "100%" }}
    onResize={sizes => setRatio(ratioFromSizes(sizes))}
    onResizeEnd={sizes => api.mutateRoot(setRatioAtPath(api.root, path, ratioFromSizes(sizes)))}>
    <Splitter.Panel size={`${ratio * 100}%`} min="10%" max="90%">
      <LayoutRenderer node={node.children[0]} path={[...path, 0]} api={api}/>
    </Splitter.Panel>
    <Splitter.Panel size={`${(1 - ratio) * 100}%`} min="10%" max="90%">
      <LayoutRenderer node={node.children[1]} path={[...path, 1]} api={api}/>
    </Splitter.Panel>
  </Splitter>;
}

function LayoutRenderer({ node, path, api }: { node: LayoutNode; path: readonly number[]; api: WindowApi }) {
  return node.type === "split"
    ? <SplitNode node={node} path={path} api={api} />
    : <PaneNode pane={node} path={path} api={api} />;
}

/** 轮询任务详情，拿会话标题/provider 给窗格标题显示。 */
function useTaskSessionMeta(
  taskId: string | null,
  liveTitles: ReadonlyMap<string, string> = new Map(),
): Map<string, SessionMeta> {
  const detail = useTaskDetail(taskId);
  const sessions = orderWorkspaceSessions(detail?.sessions ?? []);
  const meta = new Map<string, SessionMeta>();
  sessions.forEach((s, index) => {
    const session = withLiveSessionTitle(s, liveTitles.get(s.id));
    meta.set(s.id, {
      title: listSessionLabel(session, index),
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
  const liveTitles = new Map(snapshot.sidebar.groups.flatMap((group) => (
    group.entries.map((entry) => [entry.id, entry.title] as const)
  )));
  const sessionMeta = useTaskSessionMeta(context.taskId, liveTitles);

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
        if (workspaceContextStore.getSnapshot().taskId !== context.taskId) return;
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
    <div className="workspace-window" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
      <div className="workspace-window-body" style={{ height: "100%" }}>
        <LayoutRenderer node={root} path={[]} api={api} />
      </div>
    </div>
  );
}
