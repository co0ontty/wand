import { configureWorkspacesRuntime } from "../react/workspaces/controller";
import { clearActiveWorkspaceContext, setActiveWorkspaceContext } from "../react/workspaces/workspace-context";
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
import { orderWorkspaceSessions } from "../react/workspaces/session-order";
import {
  activeWorkWindow,
  activeWorkWindowTab,
  reconcileTaskWindowLayout,
} from "../react/workspaces/window-layout";
import type {
  NewTaskSessionPayload,
  OpenWorkspaceTaskPayload,
  TaskWindowLayout,
  Workspace,
} from "../react/workspaces/types";

let uninstall: (() => void) | null = null;

/**
 * 把浏览器侧的「当前 cwd / 打开工作空间 / 打开任务 / toast / 终端池」能力接进 React 工作空间面板。
 * 单窗格走单例全局终端（state.terminal）；显式分屏后才创建池终端（terminal-pool），与单例隔离，
 * 非工作空间默认 UI 零影响。
 */
export function installWorkspacesLegacyAdapter(): void {
  if (uninstall) return;
  uninstall = configureWorkspacesRuntime({
    onOpen() {
      closeReactOverlays(["workspaces"]);
      dismissDrawerIfOverlay();
    },
    onClose() {},
    effectiveCwd: getEffectiveCwd,
    openWorkspace(workspace: Workspace) {
      state.activeWorkspaceId = workspace.id;
      state.activeWorkspaceTaskId = null;
      try { localStorage.setItem("wand-active-workspace", workspace.id); } catch (e) {}
      notifyLegacyUiChange("workspace:open");
      setActiveWorkspaceContext({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        taskId: null,
        taskName: "",
        cwd: workspace.cwd,
        provider: workspace.defaultProvider,
        layout: null,
      });
    },
    closeWorkspace() {
      state.activeWorkspaceId = null;
      state.activeWorkspaceTaskId = null;
      try { localStorage.removeItem("wand-active-workspace"); } catch (e) {}
      clearActiveWorkspaceContext();
      notifyLegacyUiChange("workspace:close");
    },
    refreshSessions: refreshAll,
    selectSession(sessionId: string) {
      selectSession(sessionId);
      dismissDrawerIfOverlay();
    },
    openTask(payload: OpenWorkspaceTaskPayload) {
      state.activeWorkspaceId = payload.workspaceId;
      state.activeWorkspaceTaskId = payload.taskId;
      try { localStorage.setItem("wand-active-workspace", payload.workspaceId); } catch (e) {}
      notifyLegacyUiChange("workspace:open");
      setActiveWorkspaceContext({
        workspaceId: payload.workspaceId,
        workspaceName: payload.workspaceName,
        taskId: payload.taskId,
        taskName: payload.taskName,
        cwd: payload.cwd,
        provider: payload.provider,
        layout: null,
      });
      // 任务上下文已经切换，旧任务的终端不能继续挂在新任务标题下。
      // 先即时进入任务欢迎/加载态；详情返回后再恢复已有会话。
      goHome();
      // 已有会话的任务只恢复标签 / 布局，不因每次点击任务而偷偷再起一个会话。
      // 空任务进入任务欢迎页，由用户主动选择 Agent 或空白终端。
      void httpWorkspacesRepository.getTask(payload.taskId).then((detail) => {
        if (!detail) return;
        const sessionIds = orderWorkspaceSessions(detail.sessions).map((session) => session.id);
        if (sessionIds.length > 0) {
          const preferred = state.selectedId && sessionIds.includes(state.selectedId)
            ? state.selectedId
            : sessionIds[0];
          const layout = reconcileTaskWindowLayout(detail.layout, sessionIds, preferred);
          const active = activeWorkWindowTab(layout);
          if (active?.kind === "session") selectSession(active.sessionId);
          setActiveWorkspaceContext({ layout });
          void httpWorkspacesRepository.saveTaskLayout(payload.taskId, layout).catch(() => { /* ignore */ });
        } else {
          const layout = reconcileTaskWindowLayout(detail.layout, [], null);
          setActiveWorkspaceContext({ layout });
          void httpWorkspacesRepository.saveTaskLayout(payload.taskId, layout).catch(() => { /* ignore */ });
        }
        dismissDrawerIfOverlay();
      }).catch(() => { /* 任务详情加载失败时保留当前界面，等待下一次用户操作。 */ });
    },
    newTaskSession(payload: NewTaskSessionPayload) {
      // 标签栏「+」/ 窗格「+」：在同一任务 worktree 再起一个绑定会话；
      // startSessionInCwd 在 resolve 前已把新会话写入 state.selectedId，resolve 时回传给调用方建 tab。
      return startSessionInCwd(payload.cwd, {
        workspaceId: payload.workspaceId,
        workspaceTaskId: payload.taskId,
        shell: payload.target === "shell",
        provider: payload.target === "shell" ? undefined : payload.target,
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
    saveTaskLayout(layout: TaskWindowLayout | null) {
      const taskId = state.activeWorkspaceTaskId;
      const nextWindow = activeWorkWindow(layout);
      if (nextWindow?.layout.type !== "split") disposeAllPooledTerminals();
      setActiveWorkspaceContext({ layout });
      if (!taskId) return;
      return httpWorkspacesRepository.saveTaskLayout(taskId, layout).catch(() => { /* ignore */ });
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
}
