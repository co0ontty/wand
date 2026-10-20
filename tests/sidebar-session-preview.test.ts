import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarSessionPreview } from "../src/web-ui/react/workspaces/sidebar-session-preview.js";
import { SidebarSessionArea } from "../src/web-ui/react/workspaces/sidebar-session-area.js";
import { fitSidebarSessionPreview } from "../src/web-ui/react/workspaces/sidebar-session-preview-layout.js";
import { filterSidebarTaskSessions } from "../src/web-ui/react/workspaces/sidebar-search.js";
import { indexPersonSessions, filterPersonSessions, personSessionSearchValues } from "../src/web-ui/react/conversations/sidebar-sessions.js";
import { filterConversationList, conversationListCounts } from "../src/web-ui/react/conversations/sidebar.js";
import { collectRecentEntries, recentConversationGroups } from "../src/web-ui/react/workspaces/sidebar-recent.js";
import type { TaskDirectoryGroup, WorkspaceSessionSummary } from "../src/web-ui/react/workspaces/types.js";

const session = (id: string, extra: Partial<WorkspaceSessionSummary> = {}): WorkspaceSessionSummary => ({
  id, title: id, employeeId: "employee-a", provider: "pi", status: "idle", startedAt: "2026-10-13T12:00:00Z", ...extra,
});
const group = (sessions: WorkspaceSessionSummary[]): TaskDirectoryGroup => ({
  workspaceId: "workspace", workspaceName: "产品工作区", workspaceCwd: "/work/product", standaloneSessions: [],
  tasks: [{ id: "task", workspaceId: "workspace", name: "界面调整", cwd: "/work/product", createdAt: "", lastOpenedAt: null,
    status: "active", archived: false, worktree: null, layout: null, sessions }],
});
const person = (employeeId = "employee-a") => ({ kind: "dm" as const, peerEmployeeId: employeeId, title: "同名员工", name: "" });

test("preview waits for measurement instead of eagerly mounting every session", () => {
  const html = renderToStaticMarkup(createElement(SidebarSessionPreview, {
    sessions: [session("a", { engine: "core", inFlight: true }), session("b", { status: "failed" }), session("c", { status: "permission-blocked" })],
    expanded: false, label: "会话预览", onActivate() {},
  }));
  assert.equal((html.match(/data-preview-session-id=/g) ?? []).length, 0);
  assert.match(html, /data-total-count="3" data-visible-count="0"/);
  assert.match(html, /还有 3 个匹配会话/);
  assert.equal((html.match(/data-provider-logo="pi"/g) ?? []).length, 1, "only the fixed icon-slot probe mounts before real width is known");
  assert.match(html, /sidebar-session-preview-measure-clip[^>]*aria-hidden="true"[^>]*inert/);
});

test("expanded preview is hidden and inert without discarding session identity", () => {
  const html = renderToStaticMarkup(createElement(SidebarSessionPreview, { sessions: [session("a")], expanded: true, label: "会话预览", onActivate() {} }));
  assert.match(html, /data-expanded="true"[^>]*inert[^>]*aria-hidden="true"/);
  assert.match(html, /data-total-count="1"/);
  assert.equal(renderToStaticMarkup(createElement(SidebarSessionPreview, { sessions: [], expanded: false, label: "会话预览", onActivate() {} })), "");
});

test("a thousand-session preview has constant initial DOM cost", () => {
  const render = (count: number): string => renderToStaticMarkup(createElement(SidebarSessionPreview, {
    sessions: Array.from({ length: count }, (_, i) => session(`session-${i}`)), expanded: false, label: "会话预览", onActivate() {},
  }));
  assert.equal((render(1000).match(/<button/g) ?? []).length, (render(10).match(/<button/g) ?? []).length);
  assert.equal((render(1000).match(/data-provider-logo=/g) ?? []).length, 1);
});

test("empty matched session areas render no disclosure control or vacant preview region", () => {
  assert.equal(renderToStaticMarkup(createElement(SidebarSessionArea, { id: "empty", label: "人物", open: false,
    hasSessions: false, onOpenChange() {}, children: "" })), "");
  const present = renderToStaticMarkup(createElement(SidebarSessionArea, { id: "one", label: "人物", open: false,
    hasSessions: true, onOpenChange() {}, children: "会话" }));
  assert.match(present, /sidebar-session-area-toggle/);
});

test("preview width layout shows full titles when they fit, then complete icons before overflowing", () => {
  assert.deepEqual(fitSidebarSessionPreview(350, [70, 80, 75], 36, 4, () => 28), { titles: true, count: 3 });
  assert.deepEqual(fitSidebarSessionPreview(118, [200, 220, 240], 36, 4, () => 28), { titles: false, count: 3 });
  assert.deepEqual(fitSidebarSessionPreview(200, Array(8).fill(100), 36, 4, () => 28), { titles: false, count: 4 });
});

test("overflow reserves its actual digit width and fills the last feasible icon slot", () => {
  const widths = Array(13).fill(120);
  const more = (count: number) => count >= 10 ? 35 : 28;
  const layout = fitSidebarSessionPreview(268, widths, 36, 4, more);
  assert.equal(layout.count, 6, "measuring +7 instead of assuming the wider +13 permits the sixth slot");
  const hidden = widths.length - layout.count;
  assert.ok(layout.count * (36 + 4) + more(hidden) <= 268);
  assert.ok((layout.count + 1) * (36 + 4) + more(hidden - 1) > 268);
  assert.deepEqual(fitSidebarSessionPreview(30, Array(4).fill(120), 36, 4, more), { titles: false, count: 0 });
  assert.deepEqual(fitSidebarSessionPreview(0, widths, 36, 4, more), { titles: false, count: 0 });
  assert.deepEqual(fitSidebarSessionPreview(300, [], 36, 4, more), { titles: false, count: 0 });
});

test("task display search filters children while preserving full mutation scope", () => {
  const source = group([session("设计"), session("验收"), session("工具", { provider: "codex" })]);
  const task = source.tasks[0];
  assert.deepEqual(filterSidebarTaskSessions(source, task, "验收").map(s => s.id), ["验收"]);
  assert.equal(task.sessions.length, 3);
  assert.equal(filterSidebarTaskSessions(source, task, "界面调整"), task.sessions);
  assert.equal(filterSidebarTaskSessions(source, task, "产品工作区"), task.sessions);
  assert.deepEqual(filterSidebarTaskSessions(source, task, "新标题", { "设计": "新标题" }).map(s => s.id), ["设计"]);
  assert.deepEqual(filterSidebarTaskSessions(source, task, "missing"), []);
});

test("including archive metadata never puts archived containers or sessions in the active recent view", () => {
  const source = group([session("live"), session("old", { archived: true })]);
  source.tasks.push({ ...source.tasks[0], id: "archived-task", archived: true, sessions: [session("hidden-archived-task")] });
  source.tasks.push({ ...source.tasks[0], id: "done-task", status: "done", sessions: [session("hidden-done-task")] });
  assert.deepEqual(collectRecentEntries([source]).map(e => e.session.id), ["live"]);
  assert.equal(filterPersonSessions(person(), indexPersonSessions([source]), "archived", "").length, 2);
});

test("person index uses exact employee IDs, deduplicates IDs, and excludes group relays", () => {
  const own = session("own", { employeeName: "同名员工" });
  const other = session("other", { employeeId: "employee-b", employeeName: "同名员工" });
  const blank = session("blank", { employeeId: undefined });
  const relay = session("relay", { teamChat: { teamId: "team", runId: "run", teamName: "群聊", memberCount: 2 } });
  const source = group([own, other, blank, relay]); source.standaloneSessions.push(own);
  const index = indexPersonSessions([source]);
  assert.deepEqual(filterPersonSessions(person(), index, "all", "").map(e => e.session.id), ["own"]);
  assert.deepEqual(filterPersonSessions(person("employee-b"), index, "all", "").map(e => e.session.id), ["other"]);
  assert.deepEqual(filterPersonSessions({ ...person(), kind: "group" }, index, "all", ""), []);
  assert.deepEqual(filterPersonSessions(person("missing"), index, "all", ""), []);
});

test("same filtered person projection respects archive scope and live child titles", () => {
  const source = group([session("live"), session("archived", { archived: true })]);
  source.archivedSessions = [session("older", { archived: true })];
  const index = indexPersonSessions([source]);
  assert.deepEqual(filterPersonSessions(person(), index, "active", "").map(e => e.session.id), ["live"]);
  assert.deepEqual(filterPersonSessions(person(), index, "archived", "").map(e => e.session.id), ["archived", "older"]);
  assert.deepEqual(filterPersonSessions(person(), index, "all", "new title", { live: "new title" }).map(e => e.session.id), ["live"]);
  assert.deepEqual(filterPersonSessions(person(), index, "active", "no match"), []);
  assert.equal(filterPersonSessions(person(), index, "all", "同名员工").length, 3, "person identity search retains matching own sessions");
});

test("parent search and displayed count can match the same session's title", () => {
  const index = indexPersonSessions([group([session("needle")])]);
  const item = { ...person(), preview: "", tasks: [] };
  const extra = () => personSessionSearchValues(item, index, "all");
  assert.equal(filterConversationList([item], "all", "needle", extra).length, 1);
  assert.equal(conversationListCounts([item], "all", "needle", extra).matches, 1);
  assert.equal(filterConversationList([item], "all", "unknown", extra).length, 0);
});

test("person second-level projection can contain all matching sessions, without a global eight-row truncation", () => {
  const source = group(Array.from({ length: 12 }, (_, i) => session(`s-${i}`, { startedAt: new Date(Date.UTC(2026, 9, 13, i)).toISOString() })));
  const entries = collectRecentEntries([source]);
  assert.equal(recentConversationGroups(entries)[0].entries.length, 8, "existing bounded API default stays compatible");
  const full = recentConversationGroups(entries, { limit: Number.POSITIVE_INFINITY });
  assert.equal(full[0].employeeId, "employee-a");
  assert.equal(full[0].entries.length, 12);
  assert.equal(full[0].entries[0].session.id, "s-11");
});
