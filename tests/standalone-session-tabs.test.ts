import assert from "node:assert/strict";
import test from "node:test";
import { deriveLegacyUiSnapshot } from "../src/web-ui/react/shell/legacy-snapshot.js";
import { standaloneSessionTabScope } from "../src/web-ui/react/workspaces/standalone-session-tabs.js";
import type { TaskDirectoryGroup } from "../src/web-ui/react/workspaces/types.js";

function selected(id = "active", extra: Record<string, unknown> = {}) {
  return deriveLegacyUiSnapshot({ config: {}, selectedId: id, sessions: [{ id, command: "Shell", cwd: "/repo/worktree", ...extra }] }, {
    width: 1200, online: true, embedTerminal: false, nativeInput: false, backToNative: false, switchServer: false,
  }).selected;
}

function directory(extra: Partial<TaskDirectoryGroup> = {}): TaskDirectoryGroup {
  return { workspaceId: "cwd:/repo", workspaceName: "repo", workspaceCwd: "/repo", synthetic: true,
    tasks: [], standaloneSessions: [], ...extra };
}

test("standalone tabs use server directory membership, stable creation order and exclude task/archive/relay peers", () => {
  const group = directory({ standaloneSessions: [
    { id: "newer", cwd: "/repo", startedAt: "2026-10-09T02:00:00Z" },
    { id: "active", cwd: "/repo/worktree", startedAt: "2026-10-09T01:00:00Z" },
    { id: "archived", archived: true },
    { id: "bound", workspaceTaskId: "task" },
    { id: "relay", teamChat: { runId: "run", teamId: "team", teamName: "team", memberCount: 2 } },
  ] });
  const scope = standaloneSessionTabScope([directory({ workspaceId: "other", standaloneSessions: [{ id: "foreign" }] }), group], selected());
  assert.equal(scope?.group, group);
  assert.deepEqual(scope?.sessions.map(session => session.id), ["active", "newer"]);
  assert.equal(standaloneSessionTabScope([group], selected("relay")), null);
});

test("a newly selected unbound session projects only itself until its directory read arrives", () => {
  const scope = standaloneSessionTabScope([directory({ standaloneSessions: [{ id: "same-cwd", cwd: "/repo/worktree" }] })], selected());
  assert.equal(scope?.group, null);
  assert.deepEqual(scope?.sessions.map(session => session.id), ["active"]);
  assert.equal(scope?.sessions[0]?.cwd, "/repo/worktree");
});

test("fresh live ownership removes moved and archived peers even when the directory refresh fails", () => {
  const group = directory({ standaloneSessions: [{ id: "active" }, { id: "moved" }, { id: "archived" }, { id: "peer" }] });
  const moved = selected("moved", { workspaceTaskId: "task" });
  const archived = selected("archived", { archived: true });
  assert.ok(moved);
  assert.ok(archived);
  const active = selected();
  const peer = selected("peer");
  assert.ok(active);
  assert.ok(peer);
  const scope = standaloneSessionTabScope([group], active, new Map([["active", active], ["peer", peer], ["moved", moved], ["archived", archived]]));
  assert.deepEqual(scope?.sessions.map(session => session.id), ["active", "peer"]);
  assert.equal(scope?.group, group);
});

test("cached directory ids absent from the current selection owner are not offered as clickable tabs", () => {
  const active = selected();
  assert.ok(active);
  const scope = standaloneSessionTabScope([directory({ standaloneSessions: [{ id: "active" }, { id: "unavailable" }] })], active,
    new Map([["active", active]]));
  assert.deepEqual(scope?.sessions.map(session => session.id), ["active"]);
});

test("archived and task-owned selected sessions cannot fall back into unbound tabs", () => {
  assert.equal(standaloneSessionTabScope([], selected("active", { archived: true })), null);
  assert.equal(standaloneSessionTabScope([], selected("active", { workspaceTaskId: "task" })), null);
  assert.equal(standaloneSessionTabScope([], null), null);
  assert.equal(standaloneSessionTabScope([directory({ archivedSessions: [{ id: "active" }] })], selected()), null);
  assert.equal(standaloneSessionTabScope([directory({ tasks: [{ id: "task", workspaceId: "project", name: "task", cwd: "/repo",
    status: "active", sessions: [{ id: "active" }], createdAt: "", updatedAt: "" }] })], selected()), null);
});
