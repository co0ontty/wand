import assert from "node:assert/strict";
import test from "node:test";

import {
  applyLegacyUiAction,
  deriveLegacyUiSnapshot,
  type LegacySnapshotEnvironment,
  type LegacyUiCommands,
  type UiAction,
} from "../src/web-ui/react/shell/index.js";

const mobileEnvironment: LegacySnapshotEnvironment = {
  width: 390,
  online: true,
  embedTerminal: true,
  nativeInput: true,
  backToNative: true,
  switchServer: true,
  automationExpanded: false,
  historyExpanded: true,
};

test("legacy snapshot exposes PTY resume for every managed provider", () => {
  const providers = ["claude", "codex", "opencode", "grok", "qoder"];
  const snapshot = deriveLegacyUiSnapshot({
    loginChecked: true,
    sessions: providers.map((provider) => ({
      id: provider,
      provider,
      command: provider === "qoder" ? "qodercli" : provider,
      sessionKind: "pty",
      status: "stopped",
      claudeSessionId: `${provider}-session`,
    })),
  }, mobileEnvironment);

  assert.deepEqual(
    snapshot.sidebar.groups[0].entries.map((entry) => [entry.provider, entry.resumable]),
    providers.map((provider) => [provider, true]),
  );
});

test("legacy snapshot derivation projects the complete shell state and excludes hot fields", () => {
  const snapshot = deriveLegacyUiSnapshot({
    config: { defaultCwd: "/workspace" },
    loginChecked: true,
    isOnline: false,
    selectedId: "structured-1",
    sessionsDrawerOpen: true,
    sidebarPinned: true,
    sidebarCollapsed: false,
    filePanelOpen: true,
    topbarMoreOpen: true,
    currentView: "terminal",
    sessionsManageMode: true,
    selectedSessionIds: { "structured-1": true },
    selectedClaudeHistoryIds: { "history-1": true },
    selectedCodexHistoryIds: { "codex-1": true },
    sessions: [
      {
        id: "pty-1",
        provider: "claude",
        command: "claude",
        sessionKind: "pty",
        sessionSource: "interactive",
        title: "Older PTY",
        cwd: "/pty",
        status: "stopped",
        startedAt: "2026-07-15T08:00:00.000Z",
        claudeSessionId: "managed-history",
        worktreeEnabled: true,
        worktree: { branch: "wand/pty", path: "/worktrees/pty" },
        worktreeMergeStatus: "ready",
      },
      {
        id: "structured-1",
        provider: "codex",
        sessionKind: "structured",
        title: "Shell migration",
        description: "Move chrome to React",
        cwd: "/migration",
        status: "running",
        startedAt: "2026-07-16T08:00:00.000Z",
        structuredState: { inFlight: true },
        currentTaskTitle: "Fallback task",
      },
      {
        id: "automation-1",
        provider: "claude",
        sessionKind: "pty",
        sessionSource: "automation",
        summary: "Nightly task",
        status: "idle",
        startedAt: "2026-07-16T09:00:00.000Z",
      },
    ],
    claudeHistoryLoaded: true,
    claudeHistory: [
      {
        claudeSessionId: "history-1",
        hasConversation: true,
        firstUserMessage: "Visible Claude history",
        cwd: "/history",
        timestamp: "2026-07-14T08:00:00.000Z",
      },
      {
        claudeSessionId: "managed-history",
        hasConversation: true,
        firstUserMessage: "Already managed",
      },
      {
        claudeSessionId: "empty-history",
        hasConversation: false,
      },
    ],
    codexHistoryLoaded: true,
    codexHistory: [{
      claudeSessionId: "codex-1",
      hasConversation: true,
      firstUserMessage: "Visible Codex history",
      cwd: "/codex-history",
      mtimeMs: new Date("2026-07-15T08:00:00.000Z").getTime(),
    }],
    currentTask: { title: "Live task" },
    gitStatusSessionId: "structured-1",
    gitStatus: { isGit: true, branch: "codex/shell", modifiedCount: 2 },
    // The derivation contract must not leak these high-frequency fields.
    terminalOutput: "many megabytes",
    currentMessages: [{ role: "assistant", content: "streaming" }],
    drafts: { "structured-1": "unfinished" },
  } as Parameters<typeof deriveLegacyUiSnapshot>[0], mobileEnvironment);

  assert.deepEqual(snapshot.auth, { phase: "authenticated" });
  assert.deepEqual(snapshot.viewport, {
    mobile: true,
    online: false,
    embedTerminal: true,
    nativeInput: true,
  });
  assert.deepEqual(snapshot.capabilities, { backToNative: true, switchServer: true });
  assert.deepEqual(snapshot.layout, {
    sessionsDrawerOpen: true,
    sidebarPinned: true,
    sidebarCollapsed: false,
    sidebarAnchored: false,
    sessionsBackdropVisible: true,
    filePanelOpen: true,
    filePanelBackdropVisible: true,
    topbarMoreOpen: true,
    currentView: "chat",
  });
  assert.equal(snapshot.selected?.id, "structured-1");
  assert.equal(snapshot.selected?.statusLabel, "思考中");
  assert.equal(snapshot.selected?.inFlight, true);
  assert.equal(snapshot.sidebar.interactiveCount, 2);
  assert.equal(snapshot.sidebar.totalCount, 5);
  assert.equal(snapshot.sidebar.selectedCount, 3);
  assert.deepEqual(snapshot.sidebar.groups.map((group) => [
    group.kind,
    group.expanded,
    group.entries.map((entry) => entry.id),
  ]), [
    ["wand", true, ["structured-1", "pty-1"]],
    ["automation", true, ["automation-1"]],
    ["history", true, ["codex-1", "history-1"]],
  ]);
  assert.deepEqual(snapshot.sidebar.groups[0].entries[1].worktree, {
    enabled: true,
    branch: "wand/pty",
    path: "/worktrees/pty",
    mergeStatus: "ready",
  });
  assert.deepEqual(snapshot.topbar, {
    title: "Shell migration",
    description: "Move chrome to React",
    statusLabel: "思考中",
    statusTone: "running",
    cwd: "/migration",
    currentTask: "Live task",
    git: { branch: "codex/shell", modifiedCount: 2, clean: false },
  });
  assert.deepEqual(snapshot.legacyVisibility, {
    terminal: false,
    chat: true,
    blank: false,
    composer: true,
  });
  assert.equal("terminalOutput" in snapshot, false);
  assert.equal("currentMessages" in snapshot, false);
  assert.equal("drafts" in snapshot, false);
});

test("legacy snapshot derivation handles boot, anonymous, and empty desktop states", () => {
  const environment = { ...mobileEnvironment, width: 1200, embedTerminal: false, nativeInput: false };
  const boot = deriveLegacyUiSnapshot({}, environment);
  const anonymous = deriveLegacyUiSnapshot({
    loginChecked: true,
    sessionsDrawerOpen: true,
    sidebarPinned: false,
    workingDir: "/chosen",
  }, environment);

  assert.equal(boot.auth.phase, "booting");
  assert.equal(anonymous.auth.phase, "anonymous");
  assert.equal(anonymous.viewport.mobile, false);
  assert.equal(anonymous.layout.sidebarAnchored, true);
  assert.equal(anonymous.layout.sessionsBackdropVisible, true);
  assert.equal(anonymous.topbar.cwd, "/chosen");
  assert.equal(anonymous.selected, null);
  assert.deepEqual(anonymous.legacyVisibility, {
    terminal: false,
    chat: false,
    blank: true,
    composer: false,
  });
});

test("every UiAction maps through the narrow legacy command port", async () => {
  const calls: unknown[][] = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
  };
  const commands: LegacyUiCommands = {
    goHome: record("goHome"),
    refreshPage: record("refreshPage"),
    openNewSession: record("openNewSession"),
    quickStartClaudeTerminal: record("quickStartClaudeTerminal"),
    quickStartCodexTerminal: record("quickStartCodexTerminal"),
    quickStartOpenCodeTerminal: record("quickStartOpenCodeTerminal"),
    quickStartStructuredSession: record("quickStartStructuredSession"),
    selectSession: record("selectSession"),
    resumeSession: record("resumeSession"),
    resumeHistory: record("resumeHistory"),
    deleteItem: record("deleteItem"),
    mergeSession: record("mergeSession"),
    cleanupSession: record("cleanupSession"),
    toggleManageMode: record("toggleManageMode"),
    toggleManagedSelection: record("toggleManagedSelection"),
    selectAllManaged: record("selectAllManaged"),
    clearManagedSelection: record("clearManagedSelection"),
    deleteManagedSelection: record("deleteManagedSelection"),
    toggleSessionsDrawer: record("toggleSessionsDrawer"),
    closeSessionsDrawer: record("closeSessionsDrawer"),
    toggleSidebarPin: record("toggleSidebarPin"),
    toggleSidebarCollapsed: record("toggleSidebarCollapsed"),
    expandSidebarGroup: record("expandSidebarGroup"),
    setSidebarGroupExpanded: record("setSidebarGroupExpanded"),
    toggleFilePanel: record("toggleFilePanel"),
    closeFilePanel: record("closeFilePanel"),
    refreshFiles: record("refreshFiles"),
    navigateFiles: record("navigateFiles"),
    navigateFilesUp: record("navigateFilesUp"),
    searchFiles: record("searchFiles"),
    clearFileSearch: record("clearFileSearch"),
    openFolderPicker: record("openFolderPicker"),
    toggleTopbarMenu: record("toggleTopbarMenu"),
    copyTopbarField: record("copyTopbarField"),
    openGitCommit: record("openGitCommit"),
    openSettings: record("openSettings"),
    backToNative: record("backToNative"),
    switchServer: record("switchServer"),
    logout: record("logout"),
  };
  const actions: UiAction[] = [
    { type: "nav.home" },
    { type: "nav.refresh" },
    { type: "session.new" },
    { type: "session.quickStart.claude" },
    { type: "session.quickStart.codex" },
    { type: "session.quickStart.opencode" },
    { type: "session.quickStart.structured" },
    { type: "session.select", id: "s1" },
    { type: "session.resume", id: "s2" },
    { type: "session.resumeHistory", provider: "codex", id: "h1", cwd: "/history" },
    { type: "session.delete", target: "claude-history", id: "h2" },
    { type: "session.merge", id: "s3" },
    { type: "session.cleanup", id: "s4" },
    { type: "session.manage.toggle" },
    { type: "session.manage.select", target: "session", id: "s5" },
    { type: "session.manage.selectAll" },
    { type: "session.manage.clear" },
    { type: "session.manage.deleteSelected" },
    { type: "layout.drawer.toggle" },
    { type: "layout.drawer.close" },
    { type: "layout.drawer.pin" },
    { type: "layout.drawer.collapse" },
    { type: "layout.drawer.expandGroup", group: "automation" },
    { type: "layout.drawer.group.set", group: "history", expanded: false },
    { type: "layout.files.toggle" },
    { type: "layout.files.close" },
    { type: "layout.files.refresh" },
    { type: "layout.files.navigate", cwd: "/files" },
    { type: "layout.files.up" },
    { type: "layout.files.search", query: "README" },
    { type: "layout.files.search.clear" },
    { type: "folderPicker.open" },
    { type: "topbar.menu.toggle" },
    { type: "topbar.copy", field: "cwd" },
    { type: "topbar.gitCommit" },
    { type: "settings.open" },
    { type: "native.back" },
    { type: "native.switchServer" },
    { type: "auth.logout" },
  ];

  for (const action of actions) await applyLegacyUiAction(commands, action);

  assert.deepEqual(calls, [
    ["goHome"],
    ["refreshPage"],
    ["openNewSession"],
    ["quickStartClaudeTerminal"],
    ["quickStartCodexTerminal"],
    ["quickStartOpenCodeTerminal"],
    ["quickStartStructuredSession"],
    ["selectSession", "s1"],
    ["resumeSession", "s2"],
    ["resumeHistory", "codex", "h1", "/history"],
    ["deleteItem", "claude-history", "h2"],
    ["mergeSession", "s3"],
    ["cleanupSession", "s4"],
    ["toggleManageMode"],
    ["toggleManagedSelection", "session", "s5"],
    ["selectAllManaged"],
    ["clearManagedSelection"],
    ["deleteManagedSelection"],
    ["toggleSessionsDrawer"],
    ["closeSessionsDrawer"],
    ["toggleSidebarPin"],
    ["toggleSidebarCollapsed"],
    ["expandSidebarGroup", "automation"],
    ["setSidebarGroupExpanded", "history", false],
    ["toggleFilePanel"],
    ["closeFilePanel"],
    ["refreshFiles"],
    ["navigateFiles", "/files"],
    ["navigateFilesUp"],
    ["searchFiles", "README"],
    ["clearFileSearch"],
    ["openFolderPicker"],
    ["toggleTopbarMenu"],
    ["copyTopbarField", "cwd"],
    ["openGitCommit"],
    ["openSettings"],
    ["backToNative"],
    ["switchServer"],
    ["logout"],
  ]);
});
