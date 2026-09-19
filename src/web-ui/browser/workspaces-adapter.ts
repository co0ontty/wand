import { notifyTasksChanged, subscribeTaskChanges } from "../react/task-changes";
import { configureWorkspacesRuntime } from "../react/workspaces/controller";
import { clearActiveWorkspaceContext, setActiveWorkspaceContext, workspaceContextStore } from "../react/workspaces/workspace-context";
import { persistActiveTask } from "./active-task";
import { closeReactOverlays } from "./react-overlay-coordinator";
import { dismissDrawerIfOverlay, goHome, refreshAll, selectSession, startSessionInCwd } from "./session-engine";
import { getEffectiveCwd } from "./render";
import { showToast } from "./notifications";
import { confirmDelete } from "./sidebar";
import { notifyLegacyUiChange } from "./ui-store-bridge";
import { state } from "./state";
import {
  createPooledTerminal,
  disposeAllPooledTerminals,
  disposePooledTerminal,
  getPooledTerminalScale,
  setPooledTerminalScale,
} from "./terminal-pool";
import { httpWorkspacesRepository } from "../react/workspaces/repository";
import { taskDetailStore } from "../react/workspaces/task-detail-store";
import { createTaskLayoutController } from "../react/workspaces/task-layout-controller";
import { orderWorkspaceSessions } from "../react/workspaces/session-order";
import {
  activeWorkWindow,
  activeWorkWindowTab,
  layoutSessionIds,
  reconcileTaskWindowLayout,
} from "../react/workspaces/window-layout";
import type {
  NewTaskSessionPayload,
  OpenWorkspaceTaskPayload,
  TaskWindowLayout,
  TaskLayoutSaveOptions,
  Workspace,
} from "../react/workspaces/types";

let uninstall: (() => void) | null = null;
let openTaskGeneration = 0;

/**
 * 当前打开的任务 id。唯一来源是 workspaceContextStore（标签栏同源），
 * 适配器不再另存一份副本：两份状态曾经出现「一处被持久化、另一处被读取」
 * 的分叉，刷新后任务上下文就丢了。
 */
function currentTaskId(): string | null {
  return workspaceContextStore.getSnapshot().taskId;
}
const taskLayouts = createTaskLayoutController(httpWorkspacesRepository, {
  onSaved(taskId, layoutRevision) {
    if (currentTaskId() === taskId) setActiveWorkspaceContext({ layoutRevision });
  },
  onError(taskId, error) {
    const message = error instanceof Error ? error.message : "请检查网络后重试。";
    showToast(`任务 ${taskId} 的布局未保存：${message}`, "danger");
  },
  onRestore(taskId, detail) {
    if (currentTaskId() !== taskId) return;
    const ids = orderWorkspaceSessions(detail.sessions).map((session) => session.id);
    const savedActive = activeWorkWindowTab(detail.layout);
    const preferred = savedActive?.kind === "session" ? savedActive.sessionId : ids[0];
    const layout = reconcileTaskWindowLayout(detail.layout, ids, preferred);
    if (activeWorkWindow(layout)?.layout.type !== "split") disposeAllPooledTerminals();
    const active = activeWorkWindowTab(layout);
    if (active?.kind === "session") selectSession(active.sessionId);
    else goHome();
    setActiveWorkspaceContext({ layout, layoutRevision: detail.layoutRevision });
  },
});

function saveTaskLayout(taskId: string, layout: TaskWindowLayout | null, options?: TaskLayoutSaveOptions) {
  if (options?.automatic && !taskLayouts.canSaveAutomatically(taskId)) return Promise.resolve("failed");
  if (currentTaskId() === taskId) {
    if (activeWorkWindow(layout)?.layout.type !== "split") disposeAllPooledTerminals();
    setActiveWorkspaceContext({ layout });
  }
  return taskLayouts.save(taskId, layout, options);
}


/**
 * 把浏览器侧的「当前 cwd / 打开工作空间 / 打开任务 / toast / 终端池」能力接进 React 工作空间面板。
 * 单窗格走单例全局终端（state.terminal）；显式分屏后才创建池终端（terminal-pool），与单例隔离，
 * 非工作空间默认 UI 零影响。
 */
export function installWorkspacesLegacyAdapter(): void {
  if (uninstall) return;
  const stopChanges = subscribeTaskChanges(() => {
    const taskId = currentTaskId();
    if (!taskId) return;
    void taskLayouts.flush(taskId).then(async () => {
      const detail = await taskDetailStore.reload(taskId);
      if (currentTaskId() !== taskId) return;
      taskLayouts.remember(taskId, detail.layoutRevision);
      setActiveWorkspaceContext({
        taskName: detail.name, cwd: detail.cwd, workspaceId: detail.workspaceId,
        layout: detail.layout, layoutRevision: detail.layoutRevision,
      });
    }).catch(() => {});
  });
  const stopRuntime = configureWorkspacesRuntime({
    onOpen() {
      closeReactOverlays(["workspaces"]);
      dismissDrawerIfOverlay();
    },
    onClose() {},
    effectiveCwd: getEffectiveCwd,
    openWorkspace(workspace: Workspace) {
      ++openTaskGeneration;
      persistActiveTask(null);
      setActiveWorkspaceContext({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        taskId: null,
        taskName: "",
        cwd: workspace.cwd,
        provider: workspace.defaultProvider,
        layout: null,
      });
      notifyLegacyUiChange("workspace:open");
      goHome();
      dismissDrawerIfOverlay();
    },
    closeWorkspace() {
      ++openTaskGeneration;
      persistActiveTask(null);
      clearActiveWorkspaceContext();
      notifyLegacyUiChange("workspace:close");
    },
    refreshSessions: refreshAll,
    selectSession(sessionId: string) {
      selectSession(sessionId);
      dismissDrawerIfOverlay();
    },
    async openTask(payload: OpenWorkspaceTaskPayload) {
      const generation = ++openTaskGeneration;
      // 刷新 / 重新登录后据此恢复整个任务上下文，见 active-task.ts。
      persistActiveTask(payload.taskId);
      setActiveWorkspaceContext({
        workspaceId: payload.workspaceId,
        workspaceName: payload.workspaceName,
        taskId: payload.taskId,
        taskName: payload.taskName,
        cwd: payload.cwd,
        provider: payload.provider,
        layout: null,
        layoutRevision: undefined,
      });
      notifyLegacyUiChange("workspace:open");
      // 任务上下文已经切换，旧任务的终端不能继续挂在新任务标题下。
      // 先即时进入任务欢迎/加载态；详情返回后再恢复已有会话。
      goHome();
      // 已有会话的任务只恢复标签 / 布局，不因每次点击任务而偷偷再起一个会话。
      // 空任务进入任务欢迎页，由用户主动选择 Agent 或空白终端。
      // 返回 Promise：调用方（如侧栏「＋」建会话）需等恢复完成再动作。
      const saving = taskLayouts.isSaving(payload.taskId);
      await taskLayouts.flush(payload.taskId);
      if (generation !== openTaskGeneration) return;
      return (saving ? taskDetailStore.reload(payload.taskId) : taskDetailStore.load(payload.taskId)).then((detail) => {
        if (generation !== openTaskGeneration) return;
        const sessionIds = orderWorkspaceSessions(detail.sessions).map((session) => session.id);
        const savedActive = activeWorkWindowTab(detail.layout);
        const preferred = state.selectedId && sessionIds.includes(state.selectedId)
          ? state.selectedId
          : savedActive?.kind === "session" && sessionIds.includes(savedActive.sessionId)
            ? savedActive.sessionId
            : sessionIds[0];
        const layout = sessionIds.length > 0
          ? reconcileTaskWindowLayout(detail.layout, sessionIds, preferred)
          : reconcileTaskWindowLayout(detail.layout, [], null);
        const active = activeWorkWindowTab(layout);
        if (active?.kind === "session") selectSession(active.sessionId);
        taskLayouts.remember(payload.taskId, detail.layoutRevision);
        setActiveWorkspaceContext({ layout, layoutRevision: detail.layoutRevision });
        if (JSON.stringify(layout) !== JSON.stringify(detail.layout)) {
          void saveTaskLayout(payload.taskId, layout, { automatic: true });
        }
        dismissDrawerIfOverlay();
      }).catch(() => { /* 任务详情加载失败时保留当前任务的空态，等待重试。 */ });
    },
    newTaskSession(payload: NewTaskSessionPayload) {
      // 标签栏「+」/ 窗格「+」/ 空白桌面：在同一任务 worktree 再起一个绑定会话；
      // startSessionInCwd 在 resolve 前已把新会话写入 state.selectedId。
      // PTY 路径回传 sessionId 字符串，结构化路径回传会话对象，这里统一成 id。
      return Promise.resolve(startSessionInCwd(payload.cwd, {
        workspaceId: payload.workspaceId,
        workspaceTaskId: payload.taskId,
        shell: payload.target === "shell",
        provider: payload.target === "shell" ? undefined : payload.target,
        kind: payload.target === "shell" ? "pty" : (payload.kind ?? "structured"),
        initialInput: payload.prompt,
      })).then(async (created) => {
        const sessionId = typeof created === "string" && created
          ? created
          : (created && typeof created === "object" && "id" in created && typeof created.id === "string" && created.id
            ? created.id
            : undefined);
        if (!sessionId) return undefined;
        await taskDetailStore.reload(payload.taskId).catch(() => {});
        if (currentTaskId() === payload.taskId) {
          const current = workspaceContextStore.getSnapshot().layout;
          const existing = current
            ? current.windows.flatMap((window) => layoutSessionIds(window.layout))
            : [];
          const next = reconcileTaskWindowLayout(current, [...existing, sessionId], sessionId);
          void saveTaskLayout(payload.taskId, next);
        }
        notifyTasksChanged();
        return sessionId;
      });
    },
    startWorktreeMergeAgent(payload) {
      return startSessionInCwd(payload.cwd, {
        workspaceId: payload.workspaceId,
        provider: payload.provider,
        mode: "managed",
        initialInput: payload.prompt,
      });
    },
    saveTaskLayout(layout: TaskWindowLayout | null, options?: TaskLayoutSaveOptions) {
      const taskId = currentTaskId();
      if (!taskId) return;
      return saveTaskLayout(taskId, layout, options);
    },
    async closeTaskSessions(sessionIds, scope) {
      const ids = [...new Set(sessionIds.filter(Boolean))];
      if (ids.length === 0) return true;
      const isWindow = scope === "window";
      const confirmed = await confirmDelete(
        isWindow && ids.length > 1
          ? `关闭这个工作窗口？其中的 ${ids.length} 个终端会话会结束并被删除。`
          : "关闭这个终端？当前会话会结束并被删除。",
        {
          title: isWindow ? "关闭工作窗口" : "关闭终端",
          okLabel: "关闭",
        },
      );
      if (!confirmed) return false;
      try {
        await httpWorkspacesRepository.deleteSessions(ids);
        ids.forEach((sessionId) => disposePooledTerminal(sessionId));
        await refreshAll();
        return true;
      } catch (error) {
        await refreshAll().catch(() => { /* 保留原错误提示 */ });
        showToast(error instanceof Error ? error.message : "无法关闭终端，请稍后重试。", "danger");
        return false;
      }
    },
    mountSessionTerminal(sessionId: string, container: HTMLElement) {
      return createPooledTerminal(sessionId, container);
    },
    unmountSessionTerminal(sessionId: string) {
      disposePooledTerminal(sessionId);
    },
    getSessionTerminalScale(sessionId: string) {
      return getPooledTerminalScale(sessionId);
    },
    setSessionTerminalScale(sessionId: string, scale: number) {
      return setPooledTerminalScale(sessionId, scale);
    },
    disposeAllSessionTerminals() {
      disposeAllPooledTerminals();
    },
    toast(message, tone) {
      showToast(message, tone);
    },
  });
  uninstall = () => { stopChanges(); stopRuntime(); };
}
