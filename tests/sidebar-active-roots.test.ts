import assert from "node:assert/strict";
import test from "node:test";
import { filterActiveGroups } from "../src/web-ui/react/workspaces/sidebar-display-mode.js";
import { filterSidebarGroups } from "../src/web-ui/react/workspaces/sidebar-search.js";
import { collectRecentEntries, filterRecentEntries, recentConversationGroups } from "../src/web-ui/react/workspaces/sidebar-recent.js";
import type { TaskDirectoryGroup, WorkspaceSessionSummary } from "../src/web-ui/react/workspaces/types.js";

function directory(id: string, sessions: WorkspaceSessionSummary[] = []): TaskDirectoryGroup {
  return { workspaceId: id, workspaceName: id, workspaceCwd: `/repo/${id}`,
    tasks: [], standaloneSessions: sessions };
}
function entry(id: string, extra: Partial<WorkspaceSessionSummary> = {}): WorkspaceSessionSummary {
  return { id, status: "idle", provider: "pi", sessionKind: "structured",
    startedAt: "2026-10-10T08:00:00Z", ...extra };
}

test("activity prunes empty roots without modifying source directories", () => {
  const groups: TaskDirectoryGroup[] = [
    directory("busy", [entry("busy", { inFlight: true }), entry("idle")]),
    { ...directory("synthetic", [entry("old")]), synthetic: true },
    { ...directory("global"), global: true },
    { ...directory("archive-only"), archivedSessions: [entry("archived", { archived: true })] },
    directory("empty"),
  ];
  const before = structuredClone(groups);
  const result = filterActiveGroups(groups);
  assert.deepEqual(result.map(group => group.workspaceId), ["busy"]);
  assert.deepEqual(result[0].standaloneSessions.map(session => session.id), ["busy"]);
  for (const group of result.slice(1)) {
    assert.deepEqual(group.tasks, []);
    assert.deepEqual(group.standaloneSessions, []);
    assert.deepEqual(group.archivedSessions, []);
  }
  assert.deepEqual(groups, before, "filtering never modifies source sessions or archive data");
});

test("search narrows roots and activity prunes idle results", () => {
  const groups = [directory("wand", [entry("wand-idle")]), directory("other", [entry("other-busy", { inFlight: true })])];
  const searched = filterSidebarGroups(groups, "wand");
  assert.deepEqual(filterActiveGroups(searched), []);
  assert.deepEqual(filterActiveGroups(filterSidebarGroups(groups, "missing")), []);
});

test("recent activity retains employee, team, CLI and terminal heads with their source identity and order", () => {
  const groups = [directory("wand", [
    entry("employee-idle", { employeeId: "e1", employeeName: "旧员工名", employeeAvatar: "cat:2" }),
    entry("employee-busy", { employeeId: "e2", employeeName: "另一个员工", inFlight: true }),
    entry("team-idle", { teamChat: { teamId: "team", runId: "run", teamName: "团队", memberCount: 2 } }),
    entry("cli-idle", { provider: "codex" }),
    entry("pty-idle", { sessionKind: "pty" }),
    entry("shell-idle", { sessionKind: "pty", provider: undefined }),
  ])];
  const entries = collectRecentEntries(groups);
  const before = structuredClone(entries);
  const employees = [{ id: "e1", name: "当前员工名" }];
  const full = recentConversationGroups(entries, { employees });
  const active = recentConversationGroups(entries, { employees, activeOnly: true });
  assert.deepEqual(active.map(group => group.key), ["employee:e2"]);
  for (const group of active) {
    const source = full.find(candidate => candidate.key === group.key)!;
    assert.equal(group.title, source.title);
    assert.deepEqual(group.latestSession, source.latestSession);
    assert.equal(group.latestStartedAt, source.latestStartedAt);
    assert.equal(group.totalCount, source.totalCount);
    assert.equal(group.showsHeader, true);
    assert.equal(group.entries.length, group.key === "employee:e2" ? 1 : 0);
  }
  assert.equal(full.find(group => group.key === "employee:e1")?.title, "当前员工名");
  assert.equal(full.find(group => group.key === "employee:e1")?.latestSession.employeeAvatar, "cat:2");
  assert.deepEqual(entries, before);
});

test("recent selection respects activity but survives the full-list recent limit", () => {
  const groups = [directory("wand", [
    entry("new-idle", { employeeId: "e1", startedAt: "2026-10-10T10:00:00Z" }),
    entry("older-busy", { employeeId: "e2", inFlight: true, startedAt: "2026-10-10T09:00:00Z" }),
    entry("selected-idle", { employeeId: "e3", startedAt: "2026-10-10T08:00:00Z" }),
  ])];
  const entries = collectRecentEntries(groups);
  const active = recentConversationGroups(entries, { limit: 1, activeOnly: true, selectedSessionId: "selected-idle" });
  assert.deepEqual(active.map(group => group.key), ["employee:e2"]);
  assert.deepEqual(active.map(group => group.entries.map(entry => entry.session.id)), [["older-busy"]]);
  const full = recentConversationGroups(entries, { limit: 1, selectedSessionId: "selected-idle" });
  assert.deepEqual(full.flatMap(group => group.entries.map(entry => entry.session.id)), ["new-idle", "selected-idle"]);
});

test("recent counts describe the source dataset even when the recent window or activity hides children", () => {
  const entries = collectRecentEntries([directory("wand", [
    entry("s1", { employeeId: "e1" }), entry("s2", { employeeId: "e1", inFlight: true }),
    entry("s3", { employeeId: "e1" }),
  ])]);
  const limited = recentConversationGroups(entries, { limit: 1 })[0];
  assert.equal(limited.entries.length, 1);
  assert.equal(limited.totalCount, 3);
  const active = recentConversationGroups(entries, { activeOnly: true })[0];
  assert.equal(active.entries.length, 1);
  assert.equal(active.totalCount, 3);
  assert.equal(active.activeCount, 1);
  const searched = filterRecentEntries(entries, { query: "s3" });
  assert.equal(searched.length, 0, "session IDs are not search titles");
  const byEmployee = filterRecentEntries(entries, { query: "员工", employees: [{ id: "e1", name: "员工" }] });
  assert.equal(recentConversationGroups(byEmployee, { activeOnly: true })[0].totalCount, 3);
});
