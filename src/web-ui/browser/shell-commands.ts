import { type LegacyUiCommands, type UiManageTarget } from "../react";
import {
  closeFilePanel,
  filterFileTree,
  navigateExplorerUp,
  refreshFileExplorer,
  toggleFilePanel,
} from "./file-browser";
import { openQuickCommitModal } from "./git-commit";
import {
  deleteClaudeHistorySession,
  deleteCodexHistorySession,
  deleteSession,
  focusInputBox,
  resumeHistoryFromList,
  resumeSessionFromList,
} from "./input";
import {
  backToNativeApp,
  createStructuredSession,
  dismissDrawerIfOverlay,
  goHome,
  logout,
  openSessionModal,
  openSettingsModal,
  openWorktreeMergeModal,
  quickStartSession,
  retryWorktreeCleanup,
  selectSession,
  switchServer,
  toggleSessionsDrawer,
  closeSessionsDrawer,
  toggleSidebarCollapsed,
  toggleSidebarPin,
} from "./session-engine";
import {
  batchDeleteSelected,
  clearSelections,
  confirmDelete,
  selectAllVisibleItems,
  toggleManageMode,
  toggleManagedItemSelection,
} from "./sidebar";
import { state, writeStoredBoolean } from "./state";
import { openFolderPickerFromLegacy } from "./folder-picker-adapter";
import { copySelectedSessionField } from "./terminal";

function managedKind(target: UiManageTarget): "sessions" | "history" | "codex" {
  if (target === "claude-history") return "history";
  if (target === "codex-history") return "codex";
  return "sessions";
}

function confirmAndDelete(target: UiManageTarget, id: string): Promise<unknown> {
  const provider = target === "codex-history" ? "Codex" : target === "claude-history" ? "Claude" : "Wand";
  return confirmDelete(`确认删除这条 ${provider} 会话吗？`, { title: "删除会话" })
    .then((confirmed: boolean) => {
      if (!confirmed) return undefined;
      if (target === "codex-history") return deleteCodexHistorySession(id);
      if (target === "claude-history") return deleteClaudeHistorySession(id, null);
      return deleteSession(id);
    });
}

function setQuickStartProvider(provider: "claude" | "codex" | "opencode"): void {
  state.sessionTool = provider;
  state.preferredCommand = provider;
  if (provider === "codex") state.modeValue = "full-access";
  if (provider === "opencode") state.modeValue = "managed";
}

function quickStart(provider: "claude" | "codex" | "opencode"): void | Promise<unknown> {
  setQuickStartProvider(provider);
  return quickStartSession();
}

function quickStartStructured(): Promise<unknown> {
  setQuickStartProvider("claude");
  return createStructuredSession().then((created: unknown) => {
    focusInputBox(true);
    return created;
  });
}

function copyTopbarField(field: "providerSessionId" | "cwd" | "sessionId"): void | Promise<unknown> {
  const selected = state.sessions.find((session: any) => session.id === state.selectedId);
  if (field === "cwd") return copySelectedSessionField("cwd", "工作目录已复制");
  if (field === "sessionId") return copySelectedSessionField("id", "会话 ID 已复制");
  const provider = selected?.provider;
  const label = provider === "codex"
    ? "Codex thread ID 已复制"
    : provider === "opencode"
      ? "OpenCode session ID 已复制"
      : "Claude 会话 ID 已复制";
  return copySelectedSessionField("claudeSessionId", label);
}

/** The only imperative command port consumed by the React shell UiStore. */
export function createBrowserShellCommands(): LegacyUiCommands {
  return {
    goHome,
    refreshPage: () => window.location.reload(),
    openNewSession: openSessionModal,
    quickStartClaudeTerminal: () => quickStart("claude"),
    quickStartCodexTerminal: () => quickStart("codex"),
    quickStartOpenCodeTerminal: () => quickStart("opencode"),
    quickStartStructuredSession: quickStartStructured,
    selectSession: (id) => {
      selectSession(id);
      dismissDrawerIfOverlay();
    },
    resumeSession: (id) => resumeSessionFromList(id).then((value: unknown) => {
      dismissDrawerIfOverlay();
      return value;
    }),
    resumeHistory: (provider, id, cwd) => resumeHistoryFromList(provider, id, cwd),
    deleteItem: confirmAndDelete,
    mergeSession: openWorktreeMergeModal,
    cleanupSession: retryWorktreeCleanup,
    toggleManageMode,
    toggleManagedSelection: (target, id) => toggleManagedItemSelection(managedKind(target), id),
    selectAllManaged: selectAllVisibleItems,
    clearManagedSelection: clearSelections,
    deleteManagedSelection: batchDeleteSelected,
    toggleSessionsDrawer,
    closeSessionsDrawer,
    toggleSidebarPin,
    toggleSidebarCollapsed,
    expandSidebarGroup: (group) => {
      writeStoredBoolean(
        group === "automation"
          ? "wand-automation-sessions-expanded"
          : "wand-non-wand-sessions-expanded",
        true,
      );
      toggleSidebarCollapsed();
    },
    setSidebarGroupExpanded: (group, expanded) => {
      writeStoredBoolean(
        group === "automation"
          ? "wand-automation-sessions-expanded"
          : "wand-non-wand-sessions-expanded",
        expanded,
      );
    },
    toggleFilePanel,
    closeFilePanel,
    refreshFiles: () => refreshFileExplorer(),
    navigateFiles: (cwd) => refreshFileExplorer({ cwd }),
    navigateFilesUp: navigateExplorerUp,
    searchFiles: (query) => {
      state.fileSearchQuery = query.trim();
      filterFileTree();
    },
    clearFileSearch: () => {
      state.fileSearchQuery = "";
      filterFileTree();
    },
    openFolderPicker: () => { openFolderPickerFromLegacy(); },
    toggleTopbarMenu: () => {
      state.topbarMoreOpen = !state.topbarMoreOpen;
    },
    copyTopbarField,
    openGitCommit: openQuickCommitModal,
    openSettings: openSettingsModal,
    backToNative: backToNativeApp,
    switchServer,
    logout,
  };
}
