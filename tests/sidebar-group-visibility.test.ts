import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationSummary } from "../src/conversation-types.js";
import { GROUP_CHAT_VISIBLE, isSidebarSessionVisible } from "../src/web-ui/group-chat-visibility.js";
import { loadReactModule } from "./helpers/react-startup-harness.js";

function conversation(id: string, kind: "dm" | "group", archived = false): ConversationSummary {
  return {
    id, kind, owner: "local-owner", peerEmployeeId: null, name: id, nameSource: "custom", sourceTemplateId: null,
    team: null, memberVersion: 1, joinedVersions: {}, sessionId: null, communicationSessionId: null,
    createdAt: "", updatedAt: "", title: id, unavailableReason: null, memberUnavailableReasons: {},
    tasks: [], preview: `${id} preview`, messageAt: "", dissolvedAt: archived ? "2026-10-25T00:00:00Z" : null,
  };
}

function sidebarHarness(items = [conversation("direct", "dm"), conversation("archived-direct", "dm", true),
  conversation("hidden-group", "group"), conversation("hidden-archived-group", "group", true)]) {
  const state = { mode: "chats", filters: { "list-query": "" }, listFilter: "all", activityOnly: false, selectedId: "", active: true };
  const { api } = loadReactModule("src/web-ui/react/conversations/sidebar.tsx", {
    "./repository": { useConversations: () => ({ items, systemSessions: [], error: "", loaded: true, refresh() {} }) },
    "./state": { useConversationUi: () => state, conversationUi: {} },
    "../workspaces/task-groups-store": { useTaskGroupsAfterIdle: () => ({ groups: [] }) },
    "../agents/employee-repository": { useSiliconEmployees: () => ({ employees: [] }), cachedSiliconEmployee: () => null },
    "../user-profile-repository": { useUserProfile: () => ({ name: "我" }) },
  });
  return { state, items, render: (component: string, props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(api[component], props)) };
}

test("sidebar hides group navigation and creation without hiding workspace creation", () => {
  assert.equal(GROUP_CHAT_VISIBLE, false);
  const h = sidebarHarness();
  const navigation = h.render("ConversationNavigation", { activePage: "chats", teamAttention: 4, onNavigate() {} });
  assert.doesNotMatch(navigation, /ai-teams-button|aria-label="团队"/);
  for (const label of ["对话", "工作区", "任务看板", "定时"]) assert.ok(navigation.includes(`aria-label="${label}"`));
  assert.equal(h.render("ConversationSidebarTools", { enabled: true, onNavigate() {} }), "");
  h.state.mode = "tasks";
  const workspaceTools = h.render("ConversationSidebarTools", { enabled: true, onNavigate() {}, onCreateSession() {} });
  assert.match(workspaceTools, /aria-label="新建会话"/);
  assert.doesNotMatch(workspaceTools, /发起群聊/);
});

test("sidebar archive, search and compact projections count only visible direct conversations", () => {
  const h = sidebarHarness();
  const before = JSON.stringify(h.items);
  const props = { compact: false, enabled: true, onNavigate() {} };
  const all = h.render("ConversationSidebarList", props);
  assert.match(all, /data-conversation-id="direct"/);
  assert.match(all, /data-conversation-id="archived-direct"/);
  assert.match(all, /2 个对话/);
  assert.doesNotMatch(all, /hidden-group|hidden-archived-group/);
  h.state.filters["list-query"] = "hidden-group";
  const search = h.render("ConversationSidebarList", props);
  assert.match(search, /匹配 0 \/ 2/);
  assert.doesNotMatch(search, /data-conversation-id=/);
  h.state.filters["list-query"] = "";
  h.state.listFilter = "archived";
  const archived = h.render("ConversationSidebarList", props);
  assert.match(archived, /1 个对话/);
  assert.match(archived, /data-conversation-id="archived-direct"/);
  assert.doesNotMatch(archived, /data-conversation-id="direct"|hidden-archived-group/);
  h.state.listFilter = "all";
  const compact = h.render("ConversationSidebarList", { ...props, compact: true });
  assert.match(compact, /data-conversation-id="direct"/);
  assert.doesNotMatch(compact, /hidden-group|hidden-archived-group/);
  assert.equal(JSON.stringify(h.items), before, "visibility projections must preserve every stored conversation");
});

test("group-only archive projects a truthful empty state without inviting group actions", () => {
  const h = sidebarHarness([conversation("hidden-group", "group", true)]);
  h.state.listFilter = "archived";
  const html = h.render("ConversationSidebarList", { compact: false, onNavigate() {} });
  assert.match(html, /0 个对话/);
  assert.match(html, /还没有已归档的对话/);
  assert.doesNotMatch(html, /data-conversation-id=|解散群聊/);
});

test("workspace visibility hides only explicit group chat sessions and retains dispatched work", () => {
  const sessions = [
    { id: "normal", teamChat: undefined },
    { id: "dispatch", teamChat: undefined, teamStep: { runId: "run", title: "执行记录" } },
    { id: "group", teamChat: { teamId: "team", runId: "run" } },
  ];
  assert.deepEqual(sessions.filter(isSidebarSessionVisible).map(session => session.id), ["normal", "dispatch"]);
  assert.equal(sessions.length, 3);
});

test("directory keeps employee and team management while hiding every group-create entry", () => {
  let tab = "employees";
  const { api } = loadReactModule("src/web-ui/react/conversations/directory.tsx", {
    "../use-page-route": { usePageRouteState: (key: string) => [key === "directoryTab" ? tab : "", () => {}], routeEnum: () => {} },
    "../agents/employee-repository": { useSiliconEmployees: () => ({ employees: [], error: "", loading: false, reload() {} }) },
    "../user-profile-repository": { useUserProfile: () => ({ name: "我" }) },
    "../ai-teams/repository": { useAiTeamListState: () => ({ teams: [{ id: "template", name: "保留的模板", description: "团队任务", members: [] }], error: "", loading: false, reload() {} }) },
  });
  for (tab of ["employees", "presets"]) {
    const html = renderToStaticMarkup(createElement(api.ConversationDirectory, { onSelect() {} }));
    assert.match(html, /管理员工与团队模板/);
    assert.match(html, /data-stretch-value="presets"/);
    assert.doesNotMatch(html, /发起群聊|关闭建群|directory-group-panel/);
    if (tab === "presets") assert.match(html, /保留的模板/);
  }
});
