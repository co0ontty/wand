import assert from "node:assert/strict";
import test from "node:test";
import { isSessionJustCompleted } from "../src/session-completion-state.js";
import { computeRunningSignal } from "../src/web-ui/session-activity.js";
import { deriveLegacyUiSnapshot } from "../src/web-ui/react/shell/legacy-snapshot.js";
import { filterActiveGroups, isSessionRunning } from "../src/web-ui/react/workspaces/sidebar-display-mode.js";
import { filterRecentEntries } from "../src/web-ui/react/workspaces/sidebar-recent.js";
import { sidebarAggregateState, sidebarSessionState, sessionGlowStatus } from "../src/web-ui/react/workspaces/sidebar-session-state.js";
import type { TaskDirectoryGroup, WorkspaceSessionSummary } from "../src/web-ui/react/workspaces/types.js";

const terminal: WorkspaceSessionSummary = {
  id: "manual-cli-in-shell", sessionKind: "pty", runner: "pty", command: "/bin/zsh",
  status: "running", providerCliActive: false, ptyBusy: false, inFlight: false,
  ptyCommandRunning: true,
};
const idle: WorkspaceSessionSummary = { ...terminal, id: "shell-prompt", ptyCommandRunning: false };
const group: TaskDirectoryGroup = {
  workspaceId: "workspace", workspaceName: "Workspace", workspaceCwd: "/tmp", tasks: [{
    id: "task", workspaceId: "workspace", name: "Foreground work", worktree: null,
    layout: null, status: "active", createdAt: "2026-10-08T00:00:00Z", lastOpenedAt: null,
    cwd: "/tmp", isolated: false, sessions: [terminal, idle],
  }], standaloneSessions: [{ ...terminal, id: "standalone" }, idle],
};

test("activity filter keeps a manual CLI in a blank terminal, not the idle shell beside it", () => {
  assert.equal(isSessionRunning(terminal), true);
  const filtered = filterActiveGroups([group]);
  assert.deepEqual(filtered[0].tasks[0].sessions.map((s) => s.id), [terminal.id]);
  assert.deepEqual(filtered[0].standaloneSessions.map((s) => s.id), ["standalone"]);
  assert.equal(group.tasks[0].sessions.length, 2, "filter is a read-only projection");
  const entries = [terminal, idle].map((session) => ({ session, group, taskName: null }));
  assert.deepEqual(filterRecentEntries(entries, { activeOnly: true }).map((e) => e.session.id), [terminal.id]);
  assert.deepEqual(filterActiveGroups([{ ...group, tasks: [], standaloneSessions: [idle] }]), []);
  assert.equal(filterActiveGroups([{ ...group, tasks: [], standaloneSessions: [idle] }], idle.id).length, 1);
});

test("foreground commands share sidebar badge, counts and shell activity without inventing an AI turn", () => {
  assert.equal(sidebarSessionState(terminal).label, "运行中");
  assert.equal(sessionGlowStatus(terminal), "running");
  assert.match(sidebarAggregateState([terminal, idle]).description, /1 个运行中/);
  assert.equal(computeRunningSignal(terminal).ptyRunning, true, "providerCliActive=false belongs to the launch marker, not a manual command");
  const environment = { width: 1440, online: true, embedTerminal: false, nativeInput: false, backToNative: false, switchServer: false };
  for (const [session, expected] of [[terminal, true], [idle, false]] as const) {
    const vm = deriveLegacyUiSnapshot({ sessions: [session], selectedId: session.id }, environment);
    assert.equal(vm.selected?.turnActive, expected);
    assert.equal(vm.selected?.statusLabel, expected ? "运行中" : "空闲");
    assert.equal(vm.selected?.turnStartedAt, undefined, "foreground sampling does not time an AI reply");
  }
  assert.equal(isSessionJustCompleted({ ...terminal, completionRevision: 2, viewedCompletionRevision: 1 }), false);
});

test("activity filter does not turn terminal liveness, stopped commands or an idle provider prompt into work", () => {
  for (const session of [
    idle, { ...idle, ptyCommandRunning: undefined },
    { ...terminal, status: "exited" }, { ...terminal, status: "stopped" },
    { ...terminal, archived: true },
    { ...terminal, sessionKind: "structured", runner: "claude-cli-print" },
    { ...idle, provider: "pi" as const, providerCliActive: true },
  ]) {
    assert.equal(isSessionRunning(session), false, JSON.stringify(session));
    assert.equal(computeRunningSignal(session).ptyRunning, false, JSON.stringify(session));
  }
  assert.equal(isSessionRunning({ ...idle, provider: "pi", ptyBusy: true }), true);
  assert.equal(isSessionRunning({ id: "structured", sessionKind: "structured", inFlight: true }), true);
});
