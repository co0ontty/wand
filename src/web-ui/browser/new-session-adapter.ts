import {
  configureNewSessionRuntime,
  type NewSessionCreateRequest,
  type NewSessionCreated,
  type NewSessionRuntimeAdapter,
} from "../react";
import { focusInputBox } from "./input";
import { getEffectiveCwd } from "./render";
import {
  clearDraftValueForSession,
  dismissDrawerIfOverlay,
  ensureTerminalReady,
  getChatModelForProvider,
  loadSessions,
  selectSession,
  setChatModelForProvider,
  updateDrawerState,
} from "./session-engine";
import { state, writeStoredBoolean } from "./state";
import { saveWorkingDir } from "./terminal";
import { closeReactOverlays } from "./react-overlay-coordinator";
import { notifyTasksChanged } from "../react/task-changes";
import { taskDetailStore } from "../react/workspaces/task-detail-store";
import { workspaceContextStore } from "../react/workspaces/workspace-context";
import { workspacesStore } from "../react/workspaces/controller";
import { reconcileTaskWindowLayout, layoutSessionIds } from "../react/workspaces/window-layout";

let uninstallRuntime: (() => void) | null = null;

const legacyRuntime: NewSessionRuntimeAdapter = {
  onOpen(): void {
    closeReactOverlays(["newSession"]);
    state.sessionsDrawerOpen = false;
    writeStoredBoolean("wand-sidebar-open", false);
    updateDrawerState();
  },

  onClose(): void {
  },

  getContext() {
    return {
      effectiveCwd: getEffectiveCwd(),
      selectedModels: {
        claude: getChatModelForProvider("claude"),
        codex: getChatModelForProvider("codex"),
        opencode: getChatModelForProvider("opencode"),
        grok: getChatModelForProvider("grok"),
        qoder: getChatModelForProvider("qoder"),
        pi: getChatModelForProvider("pi"),
        gemini: getChatModelForProvider("gemini"),
      },
      thinkingEffort: state.chatThinking || "off",
    };
  },

  rememberModel(provider, model): void {
    setChatModelForProvider(provider, model || "");
  },

  async prepareCreate(kind) {
    if (kind === "structured") return {};
    await ensureTerminalReady();
    try {
      state.terminal?.remeasure?.();
    } catch (_error) {}
    const cols = state.terminal?.cols;
    const rows = state.terminal?.rows;
    return {
      cols: typeof cols === "number" && Number.isFinite(cols) && cols > 0 ? cols : undefined,
      rows: typeof rows === "number" && Number.isFinite(rows) && rows > 0 ? rows : undefined,
    };
  },

  async completeCreate(request: NewSessionCreateRequest, created: NewSessionCreated): Promise<void> {
    state.chatMode = request.mode;
    if (request.kind !== "shell") {
      state.sessionTool = request.provider;
      state.preferredCommand = request.provider;
    }
    // 新会话的输入框必须是空的：连 localStorage 里的旧草稿一起清掉，否则刷新后
    // 同 id 的旧草稿会被 getDraftValueForSession() 读回来。
    clearDraftValueForSession(created.id, true);
    saveWorkingDir(request.cwd);
    await loadSessions({ skipSelectedOutputReload: true });
    if (request.workspaceTaskId) {
      await taskDetailStore.reload(request.workspaceTaskId).catch(() => {});
      const rt = workspacesStore.getRuntime();
      if (workspaceContextStore.getSnapshot().taskId === request.workspaceTaskId && rt) {
        const current = workspaceContextStore.getSnapshot().layout;
        const existing = current
          ? current.windows.flatMap((window) => layoutSessionIds(window.layout))
          : [];
        const next = reconcileTaskWindowLayout(current, [...existing, created.id], created.id);
        void rt.saveTaskLayout(next);
      }
      notifyTasksChanged();
    }
    selectSession(created.id);
    dismissDrawerIfOverlay();
    window.setTimeout(() => focusInputBox(true), 0);
  },
};

/** Installs the only adapter that lets the React form activate legacy sessions. */
export function installNewSessionLegacyAdapter(): void {
  if (uninstallRuntime) return;
  uninstallRuntime = configureNewSessionRuntime(legacyRuntime);
}
