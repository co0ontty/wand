import type { UiAction, UiManageTarget } from "./ui-store";

/**
 * Narrow command port implemented by today's imperative browser modules.
 * React actions remain independent of those modules and their import cycles.
 */
export interface LegacyUiCommands {
  goHome(): void | Promise<unknown>;
  refreshPage(): void | Promise<unknown>;
  openNewSession(): void | Promise<unknown>;
  quickStartClaudeTerminal(): void | Promise<unknown>;
  quickStartCodexTerminal(): void | Promise<unknown>;
  quickStartOpenCodeTerminal(): void | Promise<unknown>;
  quickStartStructuredSession(): void | Promise<unknown>;
  selectSession(id: string): void | Promise<unknown>;
  resumeSession(id: string): void | Promise<unknown>;
  resumeHistory(provider: "claude" | "codex", id: string, cwd: string): void | Promise<unknown>;
  deleteItem(target: UiManageTarget, id: string): void | Promise<unknown>;
  mergeSession(id: string): void | Promise<unknown>;
  cleanupSession(id: string): void | Promise<unknown>;
  toggleManageMode(): void | Promise<unknown>;
  toggleManagedSelection(target: UiManageTarget, id: string): void | Promise<unknown>;
  selectAllManaged(): void | Promise<unknown>;
  clearManagedSelection(): void | Promise<unknown>;
  deleteManagedSelection(): void | Promise<unknown>;
  toggleSessionsDrawer(): void | Promise<unknown>;
  closeSessionsDrawer(): void | Promise<unknown>;
  toggleSidebarPin(): void | Promise<unknown>;
  toggleSidebarCollapsed(): void | Promise<unknown>;
  expandSidebarGroup(group: "automation" | "history"): void | Promise<unknown>;
  setSidebarGroupExpanded(group: "automation" | "history", expanded: boolean): void | Promise<unknown>;
  toggleFilePanel(): void | Promise<unknown>;
  closeFilePanel(): void | Promise<unknown>;
  refreshFiles(): void | Promise<unknown>;
  navigateFiles(cwd: string): void | Promise<unknown>;
  navigateFilesUp(): void | Promise<unknown>;
  searchFiles(query: string): void | Promise<unknown>;
  clearFileSearch(): void | Promise<unknown>;
  openFolderPicker(): void | Promise<unknown>;
  toggleTopbarMenu(): void | Promise<unknown>;
  copyTopbarField(field: "providerSessionId" | "cwd" | "sessionId"): void | Promise<unknown>;
  openGitCommit(): void | Promise<unknown>;
  openSettings(): void | Promise<unknown>;
  backToNative(): void | Promise<unknown>;
  switchServer(): void | Promise<unknown>;
  logout(): void | Promise<unknown>;
}

/** Exhaustive action-to-command mapping shared by production and unit tests. */
export function applyLegacyUiAction(
  commands: LegacyUiCommands,
  action: UiAction,
): void | Promise<unknown> {
  switch (action.type) {
    case "nav.home": return commands.goHome();
    case "nav.refresh": return commands.refreshPage();
    case "session.new": return commands.openNewSession();
    case "session.quickStart.claude": return commands.quickStartClaudeTerminal();
    case "session.quickStart.codex": return commands.quickStartCodexTerminal();
    case "session.quickStart.opencode": return commands.quickStartOpenCodeTerminal();
    case "session.quickStart.structured": return commands.quickStartStructuredSession();
    case "session.select": return commands.selectSession(action.id);
    case "session.resume": return commands.resumeSession(action.id);
    case "session.resumeHistory": return commands.resumeHistory(action.provider, action.id, action.cwd);
    case "session.delete": return commands.deleteItem(action.target, action.id);
    case "session.merge": return commands.mergeSession(action.id);
    case "session.cleanup": return commands.cleanupSession(action.id);
    case "session.manage.toggle": return commands.toggleManageMode();
    case "session.manage.select": return commands.toggleManagedSelection(action.target, action.id);
    case "session.manage.selectAll": return commands.selectAllManaged();
    case "session.manage.clear": return commands.clearManagedSelection();
    case "session.manage.deleteSelected": return commands.deleteManagedSelection();
    case "layout.drawer.toggle": return commands.toggleSessionsDrawer();
    case "layout.drawer.close": return commands.closeSessionsDrawer();
    case "layout.drawer.pin": return commands.toggleSidebarPin();
    case "layout.drawer.collapse": return commands.toggleSidebarCollapsed();
    case "layout.drawer.expandGroup": return commands.expandSidebarGroup(action.group);
    case "layout.drawer.group.set": return commands.setSidebarGroupExpanded(action.group, action.expanded);
    case "layout.files.toggle": return commands.toggleFilePanel();
    case "layout.files.close": return commands.closeFilePanel();
    case "layout.files.refresh": return commands.refreshFiles();
    case "layout.files.navigate": return commands.navigateFiles(action.cwd);
    case "layout.files.up": return commands.navigateFilesUp();
    case "layout.files.search": return commands.searchFiles(action.query);
    case "layout.files.search.clear": return commands.clearFileSearch();
    case "folderPicker.open": return commands.openFolderPicker();
    case "topbar.menu.toggle": return commands.toggleTopbarMenu();
    case "topbar.copy": return commands.copyTopbarField(action.field);
    case "topbar.gitCommit": return commands.openGitCommit();
    case "settings.open": return commands.openSettings();
    case "native.back": return commands.backToNative();
    case "native.switchServer": return commands.switchServer();
    case "auth.logout": return commands.logout();
    default: return assertNever(action);
  }
}

function assertNever(action: never): never {
  throw new Error(`Unsupported UI action: ${JSON.stringify(action)}`);
}
