import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationSummary } from "../src/conversation-types.js";
import type { WorkspaceSessionSummary } from "../src/web-ui/react/workspaces/types.js";
import { isConversationActive } from "../src/web-ui/react/conversations/activity-filter.js";
import { filterConversationList, conversationListCounts } from "../src/web-ui/react/conversations/sidebar.js";
import { filterPersonSessions, type PersonSessionIndex } from "../src/web-ui/react/conversations/sidebar-sessions.js";
import { SidebarActivityFilter } from "../src/web-ui/react/workspaces/sidebar-activity-filter.js";

const item = (id: string, patch: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id, kind: "dm", peerEmployeeId: id, title: id, name: id, tasks: [], preview: "", ...patch,
} as ConversationSummary);
const session = (id: string, patch: Partial<WorkspaceSessionSummary> = {}): WorkspaceSessionSummary => ({
  id, employeeId: id, status: "idle", startedAt: "", ...patch,
});

test("conversation activity uses workspace facts, not provider liveness or message recency", () => {
  for (const patch of [{ inFlight: true }, { ptyBusy: true }, { status: "waiting-input" }, { status: "failed" },
    { completionRevision: 2, viewedCompletionRevision: 1 }]) {
    assert.equal(isConversationActive(item("a"), [session("a", patch)], null, null), true);
  }
  assert.equal(isConversationActive(item("a"), [session("a", { status: "running", providerCliActive: true, provider: "pi" })], null, null), false);
  assert.equal(isConversationActive(item("a"), [session("a", { completionRevision: 2, viewedCompletionRevision: 2 })], null, null), false);
  assert.equal(isConversationActive(item("a"), [session("a")], null, "a"), false, "selection is navigation, not activity");
  assert.equal(isConversationActive(item("a"), [], "a", null), false);
  assert.equal(isConversationActive(item("a"), [session("b", { employeeName: "a", inFlight: true })], null, null), false);
  assert.equal(isConversationActive(item("a"), [session("a", { teamChat: { runId: "r" } as never, inFlight: true })], null, null), false);
});

test("group activity uses its channel and latest run; historical failure does not resurrect activity", () => {
  const task = (statuses: string[]) => ({ task: { title: "任务", status: "active" }, runs: statuses.map(status => ({ status })) }) as never;
  const group = item("g", { kind: "group", sessionId: "channel", tasks: [task(["done", "failed"])] });
  assert.equal(isConversationActive(group, [], null, null), false);
  assert.equal(isConversationActive(group, [session("channel", { completionRevision: 2, viewedCompletionRevision: 1 })], null, null), true);
  for (const status of ["running", "failed", "waiting_user", "awaiting_approval"]) {
    assert.equal(isConversationActive({ ...group, tasks: [task([status])] }, [], null, null), true);
  }
  assert.equal(isConversationActive({ ...group, tasks: [{ task: { status: "archived" }, runs: [{ status: "running" }] } as never] }, [], null, null), false);
});

test("activity intersects all three archive tiers and search; counts describe filtered rows", () => {
  const items = [item("a"), item("b"), item("c", { dissolvedAt: "2026-10-01" })];
  const active = (entry: ConversationSummary) => entry.id !== "b";
  assert.deepEqual(filterConversationList(items, "all", "", undefined, active).map(i => i.id), ["a", "c"]);
  assert.deepEqual(filterConversationList(items, "active", "", undefined, active).map(i => i.id), ["a"]);
  assert.deepEqual(filterConversationList(items, "archived", "", undefined, active).map(i => i.id), ["c"]);
  assert.deepEqual(filterConversationList(items, "all", "b", undefined, active), []);
  assert.deepEqual(conversationListCounts(items, "all", "c", undefined, active), { total: 3, active: 2, archived: 1, scope: 2, matches: 1 });
});

test("person session previews and expanded children obey the independent activity toggle", () => {
  const sessions = [session("live", { inFlight: true }), session("idle"), session("selected")];
  const index = new Map([["a", sessions.map(s => ({ session: s, archived: false, group: { workspaceName: "项目" } }))]]) as unknown as PersonSessionIndex;
  assert.deepEqual(filterPersonSessions(item("a"), index, "all", "", {}, true, "selected").map(e => e.session.id), ["live"]);
  assert.equal(filterPersonSessions(item("a"), index, "all", "", {}, false).length, 3);
});

test("shared activity button is text-only and keeps one pressed-state instance", () => {
  for (const active of [false, true]) {
    const html = renderToStaticMarkup(createElement(SidebarActivityFilter, { active, onChange() {} }));
    assert.match(html, /sidebar-activity-filter/);
    assert.match(html, new RegExp(`aria-pressed="${active}"`));
    assert.match(html, /活动/);
    assert.doesNotMatch(html, /<svg|zap|bolt/);
  }
});
