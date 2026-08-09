// 任务顶部的“工作窗口”标签栏。每个顶层 Tab 是一个工作窗口：默认含一个终端；
// 终端移入另一窗口后，来源空 Tab 消失、目标 Tab 内部转为 split。单窗格继续复用全局终端，
// 只有活动工作窗口为 split 时才由 WorkspaceWindow 挂载多终端池。

import * as React from "react";

import { workspaceContextStore } from "./workspace-context";
import { workspacesStore } from "./controller";
import { httpWorkspacesRepository } from "./repository";
import {
  orderWorkspaceSessions,
  workspaceProviderLabel,
  workspaceSessionLabel,
} from "./session-order";
import type {
  NewTaskSessionPayload,
  TaskWindowLayout,
  WorkWindowLayout,
  WorkspaceSessionTarget,
  WorkspaceSessionSummary,
  WorkspaceTaskDetail,
} from "./types";
import { WorkspaceAgentDialog } from "./workspace-agent-dialog";
import {
  workspaceAgentDialogController,
  workspaceAgentDialogStore,
} from "./workspace-agent-dialog-controller";
import { useUiDispatch, useUiStoreSnapshot } from "../shell/ui-store-react";
import { classNames } from "../ui/class-names";
import {
  activateWorkWindow,
  activeLayoutTab,
  activeWorkWindowTab,
  addSessionWindow,
  closeWorkWindow,
  layoutSessionIds,
  moveSessionBeside,
  reconcileTaskWindowLayout,
} from "./window-layout";

function presentError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message || error.message === "Failed to fetch") return fallback;
  return error.message;
}

function runtime() {
  return workspacesStore.getRuntime();
}

function StatusDot({ status }: { status?: string }) {
  const tone = status === "running" || status === "thinking" || status === "waiting-input"
    ? "running"
    : status === "exited" || status === "failed" || status === "stopped"
      ? "ended"
      : "idle";
  return <span className={classNames("workspace-tab-dot", tone)} aria-hidden />;
}

function layoutsEqual(left: TaskWindowLayout | null, right: TaskWindowLayout): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function windowPresentation(
  window: WorkWindowLayout,
  sessionById: ReadonlyMap<string, { session: WorkspaceSessionSummary; index: number }>,
): { label: string; status?: string; count: number } {
  const ids = layoutSessionIds(window.layout);
  const active = activeLayoutTab(window.layout, window.activeTabId);
  const activeSessionId = active?.kind === "session" ? active.sessionId : ids[0];
  const meta = activeSessionId ? sessionById.get(activeSessionId) : undefined;
  const base = meta ? workspaceSessionLabel(meta.session, meta.index) : "工作窗口";
  return {
    label: ids.length > 1 ? `${base} · ${ids.length}` : base,
    status: meta?.session.status,
    count: ids.length,
  };
}

// 轮询拉取活动任务详情（含其会话列表）。新增会话或宿主选中首会话后立即重拉。
function useActiveTaskDetail(
  taskId: string | null,
  refreshTick: number,
  selectedSessionId: string | null,
): {
  detail: WorkspaceTaskDetail | null;
  loading: boolean;
} {
  const [detail, setDetail] = React.useState<WorkspaceTaskDetail | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!taskId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      setLoading(true);
      try {
        const fetched = await httpWorkspacesRepository.getTask(taskId);
        if (!cancelled) setDetail(fetched);
      } catch {
        // 静默：标签栏会保留上一次的会话列表或显示空态。
        if (!cancelled && !detail) setDetail(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    timer = window.setInterval(() => void load(), 4_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
    // detail 不进依赖：避免每次拉到新详情都重建定时器。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, refreshTick, selectedSessionId]);

  return { detail, loading };
}

export function WorkspaceTabBar(): React.ReactElement | null {
  const context = React.useSyncExternalStore(
    workspaceContextStore.subscribe,
    workspaceContextStore.getSnapshot,
    workspaceContextStore.getServerSnapshot,
  );
  const snapshot = useUiStoreSnapshot();
  const dispatch = useUiDispatch();
  const [refreshTick, setRefreshTick] = React.useState(0);
  const agentDialog = React.useSyncExternalStore(
    workspaceAgentDialogStore.subscribe,
    workspaceAgentDialogStore.getSnapshot,
    workspaceAgentDialogStore.getServerSnapshot,
  );
  const [moving, setMoving] = React.useState<{ sessionId: string; dir: "h" | "v" } | null>(null);
  const [closingWindowId, setClosingWindowId] = React.useState<string | null>(null);
  const selectedId = snapshot.selected?.id ?? null;
  const { detail, loading } = useActiveTaskDetail(context.taskId, refreshTick, selectedId);

  React.useEffect(() => {
    setMoving(null);
    workspaceAgentDialogController.close();
  }, [context.taskId]);

  React.useEffect(() => () => workspaceAgentDialogController.close(), []);

  React.useEffect(() => {
    if (!moving) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoving(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [moving]);

  const sessions = orderWorkspaceSessions(detail?.sessions ?? []);
  const taskCwd = detail?.cwd ?? context.cwd;
  const sessionIds = sessions.map((session) => session.id);
  // 打开任务时宿主会先同步写入 taskId，再异步恢复 layout。此处若只看暂时为
  // null 的 context.layout，会把服务端已有分屏抢先重建成“每终端一个窗口”并回写。
  // 详情已返回时优先把其中的持久化布局作为恢复基线，避免打开任务的竞态覆盖。
  const persistedLayout = context.layout ?? detail?.layout ?? null;
  const taskLayout = reconcileTaskWindowLayout(persistedLayout, sessionIds, selectedId);
  const sessionById = new Map(sessions.map((session, index) => [session.id, { session, index }]));

  React.useEffect(() => {
    if (!context.taskId || !detail || layoutsEqual(context.layout, taskLayout)) return;
    runtime()?.saveTaskLayout(taskLayout);
  }, [context.layout, context.taskId, detail, taskLayout]);

  // 无活动任务 → 不渲染标签栏（SSR 与 reactShell=0 兜底同样走这里）。
  if (!context.taskId) return null;

  const handleNewSession = async (target: WorkspaceSessionTarget) => {
    if (!context.taskId || !context.workspaceId) {
      throw new Error("当前任务上下文已失效，请重新打开任务后重试。");
    }
    const rt = runtime();
    if (!rt) throw new Error("工作空间运行环境尚未就绪，请刷新页面后重试。");
    const payload: NewTaskSessionPayload = {
      workspaceId: context.workspaceId,
      taskId: context.taskId,
      cwd: taskCwd,
      target,
    };
    const result = await rt.newTaskSession(payload);
    const sessionId = typeof result === "string" ? result : null;
    if (!sessionId) throw new Error("服务端未返回新会话 ID。");
    const latest = workspaceContextStore.getSnapshot().layout;
    const base = reconcileTaskWindowLayout(latest, [...sessionIds, sessionId], selectedId);
    const next = addSessionWindow(base, sessionId, true);
    rt.saveTaskLayout(next);
    void dispatch({ type: "session.select", id: sessionId });
    // 会话创建后立即重拉任务详情，新标签马上出现。
    setRefreshTick((n) => n + 1);
    rt.toast(target === "shell" ? "已新建空白终端" : `已新建 ${workspaceProviderLabel(target)} 对话`, "success");
  };

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
    if (active?.kind === "session") void dispatch({ type: "session.select", id: active.sessionId });
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
      const next = closeWorkWindow(taskLayout, window.id);
      rt.saveTaskLayout(next);
      const active = activeWorkWindowTab(next);
      if (active?.kind === "session") void dispatch({ type: "session.select", id: active.sessionId });
      setMoving(null);
      setRefreshTick((value) => value + 1);
      rt.toast(sessionIds.length > 1 ? `已关闭 ${sessionIds.length} 个终端` : "已关闭终端", "success");
    } finally {
      setClosingWindowId(null);
    }
  };

  const handleClose = () => {
    runtime()?.closeWorkspace();
    void dispatch({ type: "nav.home" });
  };

  return (
    <div className="workspace-tab-bar" role="tablist" aria-label={`任务 ${context.taskName} 的工作窗口标签`}>
      <div className="workspace-tab-bar-list">
        {!loading && taskLayout.windows.length === 0 ? (
          <span className="workspace-tab-bar-empty">该任务还没有工作窗口</span>
        ) : taskLayout.windows.length === 0 ? (
          <span className="workspace-tab-bar-empty">加载中…</span>
        ) : (
          taskLayout.windows.map((window) => {
            const active = window.id === taskLayout.activeWindowId;
            const presentation = windowPresentation(window, sessionById);
            const containsMoving = moving
              ? layoutSessionIds(window.layout).includes(moving.sessionId)
              : false;
            return (
              <div
                key={window.id}
                className={classNames("workspace-tab-item", active && "active")}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={classNames(
                    "workspace-tab",
                    active && "active",
                    moving && !containsMoving && "move-target",
                    containsMoving && "moving-source",
                  )}
                  title={moving && !containsMoving
                    ? `把当前终端移入「${presentation.label}」`
                    : `${presentation.label}${presentation.count > 1 ? "（分屏工作窗口）" : ""}`}
                  onClick={() => selectWindow(window)}
                >
                  <StatusDot status={presentation.status} />
                  <span className="workspace-tab-label">{presentation.label}</span>
                </button>
                <button
                  type="button"
                  className="workspace-tab-item-close"
                  aria-label={`关闭工作窗口 ${presentation.label}`}
                  title="关闭这个工作窗口"
                  disabled={closingWindowId === window.id}
                  onClick={() => void closeWindow(window)}
                >
                  ×
                </button>
              </div>
            );
          })
        )}
        <button
          type="button"
          className="workspace-tab-add"
          title="新建 Agent 或空白终端（在同一 worktree）"
          aria-label="新建 Agent 或空白终端"
          onClick={() => workspaceAgentDialogController.open()}
        >
          +
        </button>
        {taskLayout.windows.length > 1 ? (
          <>
            <button
              type="button"
              className={classNames("workspace-tab-move", moving?.dir === "h" && "active")}
              title="把当前终端移入另一个工作窗口并左右分屏"
              aria-label="移动终端并左右分屏"
              aria-pressed={moving?.dir === "h"}
              onClick={() => moving?.dir === "h" ? setMoving(null) : beginMove("h")}
            >
              ⇆
            </button>
            <button
              type="button"
              className={classNames("workspace-tab-move", moving?.dir === "v" && "active")}
              title="把当前终端移入另一个工作窗口并上下分屏"
              aria-label="移动终端并上下分屏"
              aria-pressed={moving?.dir === "v"}
              onClick={() => moving?.dir === "v" ? setMoving(null) : beginMove("v")}
            >
              ⇅
            </button>
          </>
        ) : null}
      </div>
      {moving ? (
        <button
          type="button"
          className="workspace-tab-move-hint"
          title="取消移动"
          onClick={() => setMoving(null)}
        >
          选择目标窗口 · Esc 取消
        </button>
      ) : null}
      <button
        type="button"
        className="workspace-tab-files"
        title="打开文件面板"
        aria-label="文件"
        onClick={() => void dispatch({ type: "layout.files.toggle" })}
      >
        ▤
      </button>
      <button
        type="button"
        className="workspace-tab-close"
        title="关闭任务标签组"
        aria-label="关闭任务标签组"
        onClick={handleClose}
      >
        ×
      </button>
      <WorkspaceAgentDialog
        open={agentDialog.open}
        initialProvider={context.provider}
        onConfirm={handleNewSession}
        onDismiss={() => workspaceAgentDialogController.close()}
      />
    </div>
  );
}
