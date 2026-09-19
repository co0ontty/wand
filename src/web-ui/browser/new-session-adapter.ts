import {
  configureNewSessionRuntime,
  type NewSessionCreateRequest,
  type NewSessionCreated,
  type NewSessionRuntimeAdapter,
} from "../react";
import { persistSelectedId } from "./chat-scroll";
import { focusInputBox } from "./input";
import { getEffectiveCwd, resetChatRenderCache } from "./render";
import {
  clearDraftValueForSession,
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
import { closeReactOverlays } from "./react-overlay-coordinator";

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
      },
      thinkingEffort: state.chatThinking || "off",
    };
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
    state.selectedId = created.id;
    // 新会话的输入框必须是空的：连 localStorage 里的旧草稿一起清掉，否则刷新后
    // 同 id 的旧草稿会被 getDraftValueForSession() 读回来。
    clearDraftValueForSession(created.id, true);
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
