import {
  configureNewSessionRuntime,
  folderPickerController,
  quickCommitController,
  worktreeMergeController,
  type NewSessionCreateRequest,
  type NewSessionCreated,
  type NewSessionRuntimeAdapter,
} from "../react";
import { persistSelectedId } from "./chat-scroll";
import { focusInputBox } from "./input";
import { getEffectiveCwd, resetChatRenderCache } from "./render";
import {
  closeSettingsModal,
  dismissDrawerIfOverlay,
  ensureTerminalReady,
  getChatModelForProvider,
  loadSessions,
  selectSession,
  syncComposerModeSelect,
  syncComposerModelSelect,
  updateDrawerState,
} from "./session-engine";
import { state, writeStoredBoolean } from "./state";
import { saveWorkingDir } from "./terminal";

let uninstallRuntime: (() => void) | null = null;

const legacyRuntime: NewSessionRuntimeAdapter = {
  onOpen(): void {
    folderPickerController.closeIfOpen();
    quickCommitController.closeIfOpen();
    worktreeMergeController.closeIfOpen();
    closeSettingsModal();
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
      },
      thinkingEffort: state.chatThinking || "off",
    };
  },

  async prepareCreate(kind) {
    if (kind !== "pty") return {};
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
    state.modeValue = request.mode;
    state.chatMode = request.mode;
    state.sessionTool = request.provider;
    state.preferredCommand = request.provider;
    state.selectedId = created.id;
    state.drafts[created.id] = "";
    persistSelectedId();
    saveWorkingDir(request.cwd);
    resetChatRenderCache();
    syncComposerModeSelect();
    await loadSessions();
    syncComposerModelSelect(state.sessions.find((session) => session.id === created.id) || null);
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
