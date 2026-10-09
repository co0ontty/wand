import { WandDropdownMenu, WandDropdownMenuTrigger, WandDropdownMenuContent, WandDropdownMenuItem, WandDropdownMenuSeparator } from "../ui";
// 任务顶部的“工作窗口”标签栏。每个顶层 Tab 是一个工作窗口：默认含一个终端；
// 终端移入另一窗口后，来源空 Tab 消失、目标 Tab 内部转为 split。单窗格继续复用全局终端，
// 只有活动工作窗口为 split 时才由 WorkspaceWindow 挂载多终端池。

import * as React from "react";

import { workspaceContextStore } from "./workspace-context";
import { workspacesStore } from "./controller";
import { taskDetailStore, useTaskDetail } from "./task-detail-store";
import {
  listSessionLabel,
  orderWorkspaceSessions,
  withLiveSessionTitle,
} from "./session-order";
import type {
  TaskWindowLayout,
  WorkWindowLayout,
  WorkspaceSessionSummary,
} from "./types";
import { newSessionController } from "../new-session/controller";
import { useUiDispatch, useUiStoreSnapshot } from "../shell/ui-store-react";
import { ChatWidthToggle } from "../shell/chat-width-toggle";
import { TopbarGitBadge } from "../shell/topbar-git-badge";
import { WorkspaceDesktopActionsChrome, WorkspaceMoreButton, WorkspaceTabBarChrome } from "./workspace-tab-chrome";
import { StandaloneSessionTabBar } from "./standalone-session-tab-bar";
import {
  activateWorkWindow,
  activeLayoutTab,
  activeWorkWindowTab,
  closeWorkWindow,
  layoutSessionIds,
  moveSessionBeside,
  reconcileTaskWindowLayout,
} from "./window-layout";

function runtime() {
  return workspacesStore.getRuntime();
}

function layoutsEqual(left: TaskWindowLayout | null, right: TaskWindowLayout): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function windowPresentation(
  window: WorkWindowLayout,
  sessionById: ReadonlyMap<string, { session: WorkspaceSessionSummary; index: number }>,
): { label: string; status?: string; count: number; session?: WorkspaceSessionSummary } {
  const ids = layoutSessionIds(window.layout);
  const active = activeLayoutTab(window.layout, window.activeTabId);
  const activeSessionId = active?.kind === "session" ? active.sessionId : ids[0];
  const meta = activeSessionId ? sessionById.get(activeSessionId) : undefined;
  const base = meta ? listSessionLabel(meta.session, meta.index) : "工作窗口";
  return {
    label: ids.length > 1 ? `${base} · ${ids.length}` : base,
    status: meta?.session.status,
    count: ids.length,
    session: meta?.session,
  };
}

export function WorkspaceTabBar(): React.ReactElement | null {
  const context = React.useSyncExternalStore(
    workspaceContextStore.subscribe,
    workspaceContextStore.getSnapshot,
    workspaceContextStore.getServerSnapshot,
  );
  const snapshot = useUiStoreSnapshot();
  const dispatch = useUiDispatch();
  const mobile = snapshot.viewport.mobile;
  const [moving, setMoving] = React.useState<{ sessionId: string; dir: "h" | "v" } | null>(null);
  const [closingWindowId, setClosingWindowId] = React.useState<string | null>(null);
  const selectedId = snapshot.selected?.id ?? null;
  const detail = useTaskDetail(context.taskId);

  React.useEffect(() => {
    setMoving(null);
  }, [context.taskId]);

  React.useEffect(() => () => newSessionController.close(), []);

  React.useEffect(() => {
    if (!moving) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoving(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [moving]);

  const liveTitles = new Map(snapshot.sidebar.groups.flatMap((group) => (
    group.entries.map((entry) => [entry.id, entry.title] as const)
  )));
  const sessions = orderWorkspaceSessions(detail?.sessions ?? [])
    .map((session) => withLiveSessionTitle(session, liveTitles.get(session.id)));
  const taskCwd = detail?.cwd ?? context.cwd;
  const sessionIds = sessions.map((session) => session.id);
  // 打开任务时宿主会先同步写入 taskId，再异步恢复 layout。此处若只看暂时为
  // null 的 context.layout，会把服务端已有分屏抢先重建成“每终端一个窗口”并回写。
  // 详情已返回时优先把其中的持久化布局作为恢复基线，避免打开任务的竞态覆盖。
  const persistedLayout = context.layout ?? detail?.layout ?? null;
  const taskLayout = reconcileTaskWindowLayout(persistedLayout, sessionIds, selectedId);
  const sessionById = new Map(sessions.map((session, index) => [session.id, { session, index }]));

  React.useEffect(() => {
    if (!context.taskId || !detail || layoutsEqual(persistedLayout, taskLayout)) return;
    runtime()?.saveTaskLayout(taskLayout, { automatic: true });
  }, [persistedLayout, context.taskId, detail, taskLayout]);

  if (!context.taskId) return <StandaloneSessionTabBar/>;
  // 任务还没有任何工作窗口：让主区全页 CLI 选择桌面单独出现，
  // 避免空标签栏和选择器叠在一起。
  if (taskLayout.windows.length === 0) return null;

  const selectWindow = (window: WorkWindowLayout) => {
    const rt = runtime();
    if (!rt) return;
    if (moving) {
      const target = activeLayoutTab(window.layout, window.activeTabId);
      const next = moveSessionBeside(taskLayout, moving.sessionId, window.id, target?.id, moving.dir);
      if (next !== taskLayout) {
        rt.saveTaskLayout(next);
        const active = activeWorkWindowTab(next);
        if (active?.kind === "session") void dispatch({ type: "session.select", id: active.sessionId });
      }
      setMoving(null);
      return;
    }
    const next = activateWorkWindow(taskLayout, window.id);
    rt.saveTaskLayout(next);
    const active = activeLayoutTab(window.layout, window.activeTabId);
    if (active?.kind === "session") void dispatch({ type: "session.select", id: active.sessionId, focusInput: false });
  };

  const beginMove = (dir: "h" | "v") => {
    const active = activeWorkWindowTab(taskLayout);
    if (active?.kind !== "session" || taskLayout.windows.length < 2) return;
    setMoving({ sessionId: active.sessionId, dir });
  };

  const closeWindow = async (window: WorkWindowLayout) => {
    const rt = runtime();
    if (!rt || closingWindowId) return;
    const sessionIds = layoutSessionIds(window.layout);
    setClosingWindowId(window.id);
    try {
      if (!await rt.closeTaskSessions(sessionIds, "window")) return;
      if (workspaceContextStore.getSnapshot().taskId !== context.taskId) return;
      const next = closeWorkWindow(taskLayout, window.id);
      rt.saveTaskLayout(next);
      const active = activeWorkWindowTab(next);
      if (active?.kind === "session") void dispatch({ type: "session.select", id: active.sessionId });
      setMoving(null);
      if (context.taskId) void taskDetailStore.load(context.taskId).catch(() => {});
      rt.toast(sessionIds.length > 1 ? `已关闭 ${sessionIds.length} 个终端` : "已关闭终端", "success");
    } finally {
      setClosingWindowId(null);
    }
  };

  const handleClose = () => {
    runtime()?.closeWorkspace();
    void dispatch({ type: "nav.home" });
  };

  const openNewSession = () => newSessionController.open({
    initialCwd: taskCwd,
    workspaceId: context.workspaceId || undefined,
    workspaceTaskId: context.taskId || undefined,
    taskName: context.taskName || undefined,
  });
  const activeWindow = taskLayout.windows.find((window) => window.id === taskLayout.activeWindowId);

  return (
    <WorkspaceTabBarChrome mobile={mobile} taskName={context.taskName} activeWindowId={taskLayout.activeWindowId}
      windows={taskLayout.windows.map(window => ({ id: window.id, ...windowPresentation(window, sessionById),
        containsMoving: Boolean(moving && layoutSessionIds(window.layout).includes(moving.sessionId)) }))}
      movingDir={moving?.dir} closingWindowId={closingWindowId}
      onSelectWindow={id => { const window = taskLayout.windows.find(window => window.id === id); if (window) selectWindow(window); }}
      onCloseWindow={id => { const window = taskLayout.windows.find(window => window.id === id); if (window) void closeWindow(window); }}
      onNewSession={openNewSession} onCancelMove={() => setMoving(null)}
      onToggleMove={dir => moving?.dir === dir ? setMoving(null) : beginMove(dir)}
      actions={mobile ? <WandDropdownMenu>
        <WandDropdownMenuTrigger render={<WorkspaceMoreButton/>}/>
        <WandDropdownMenuContent align="end" aria-label="工作窗口操作">
          <WandDropdownMenuItem icon="plus" onSelect={openNewSession}>新建 Agent 或空白终端</WandDropdownMenuItem>
          <WandDropdownMenuItem icon="explorer" onSelect={() => void dispatch({ type: "layout.files.toggle" })}>文件</WandDropdownMenuItem>
          {snapshot.topbar.git ? <WandDropdownMenuItem icon="git" onSelect={() => void dispatch({ type: "topbar.gitCommit" })}>快捷提交 · {snapshot.topbar.git.branch}</WandDropdownMenuItem> : null}
          {taskLayout.windows.length > 1 ? <>
            <WandDropdownMenuSeparator/>
            <WandDropdownMenuItem icon="splitHorizontal" onSelect={() => beginMove("h")}>移动终端并左右分屏</WandDropdownMenuItem>
            <WandDropdownMenuItem icon="splitVertical" onSelect={() => beginMove("v")}>移动终端并上下分屏</WandDropdownMenuItem>
          </> : null}
          <WandDropdownMenuSeparator/>
          {activeWindow ? <WandDropdownMenuItem icon="close" disabled={closingWindowId !== null} onSelect={() => void closeWindow(activeWindow)}>关闭当前工作窗口</WandDropdownMenuItem> : null}
          <WandDropdownMenuItem icon="close" onSelect={handleClose}>关闭任务标签组</WandDropdownMenuItem>
        </WandDropdownMenuContent>
      </WandDropdownMenu> : <WorkspaceDesktopActionsChrome onFiles={() => void dispatch({ type: "layout.files.toggle" })} onClose={handleClose}>
        <TopbarGitBadge id="workspace-tab-git-badge" className="workspace-tab-git"/>
        <ChatWidthToggle className="workspace-tab-chat-width"/>
      </WorkspaceDesktopActionsChrome>}/>
  );
}
