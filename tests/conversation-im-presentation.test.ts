import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatConversationListTime, conversationListFilterLabel, filterConversationList, isConversationArchived } from "../src/web-ui/react/conversations/sidebar.js";

const now = new Date(2026, 9, 7, 16, 30);
test("conversation list clock projects real timestamps and omits missing/invalid values", () => {
  assert.equal(formatConversationListTime("", now), "");
  assert.equal(formatConversationListTime("not-a-date", now), "");
  assert.equal(formatConversationListTime(new Date(2026, 9, 7, 9, 5).toISOString(), now), "09:05");
  assert.equal(formatConversationListTime(new Date(2026, 9, 6).toISOString(), now), "10/06");
  assert.equal(formatConversationListTime(new Date(2025, 9, 6).toISOString(), now), new Date(2025, 9, 6).toLocaleDateString([], { year: "numeric", month: "2-digit", day: "2-digit" }));
});

test("conversation IM density stays scoped and keeps the bounded feedback and fixed action frame", () => {
  const css = readFileSync(new URL("../src/web-ui/content/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.conversation-feedback \{ min-height:44px;/);
  assert.match(css, /\.conversation-feedback\[hidden\] \{ display:none; \}/);
  assert.match(css, /\.conversation-action-row \{ height:44px;/);
  // IM 层两侧都是气泡：按聊天气泡收口，不铺满整页。
  assert.match(css, /\.conversation-root \.team-chat-stream \.team-chat-msg\[data-shape="bubble"\] \.team-chat-msg-content \{ max-width:min\(calc\(100% - 42px\),600px\); \}/);
  assert.match(css, /\.conversation-root \.ant-bubble-content/);
  assert.match(css, /\.conversation-row-topline \.conversation-row-title[^}]*text-overflow:ellipsis/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  // 消息流贴底：内容比视口短时从底部往上长（首个 flex item 吸收空余），内容超出后 auto margin 归零。
  assert.match(css, /\.conversation-message-scroll \{ display:flex; flex-direction:column;/);
  assert.match(css, /\.conversation-message-scroll > :first-child \{ margin-block-start:auto; \}/);
  // 输入面板一体：正文与操作行同属一张发送器面板，不再在面板外再摆一条工具栏。
  assert.match(css, /\.conversation-sender \.ant-sender-footer \{ padding:0 12px 10px; \}/);
  // 一次连续发言的首/尾各自压平对应的角（首条在头像侧）。
  assert.match(css, /\.conversation-root \.conversation-message\[data-lead="true"\]\[data-side="start"\] \.ant-bubble-content \{ border-top-left-radius:4px; \}/);
  assert.match(css, /\.conversation-root \.conversation-message\[data-tail="true"\]\[data-side="end"\] \.ant-bubble-content \{ border-bottom-right-radius:4px; \}/);
});

import { appendedConversationKeys, conversationClock, conversationDay, conversationInitials, conversationTaskStateLabel, joinsConversationBubble } from "../src/web-ui/react/conversations/presentation.js";
import type { ConversationTurn } from "../src/types.js";
const turn = (overrides: Partial<ConversationTurn> = {}): ConversationTurn => ({ role: "assistant", content: [], createdAt: "2026-10-07T08:00:00Z", author: { id: "alice", name: "Alice" }, ...overrides });
test("IM grouping respects author, five-minute, day, notice and run boundaries", () => {
  const first = turn();
  assert.equal(joinsConversationBubble(first, turn({ createdAt: "2026-10-07T08:04:59Z" })), true);
  for (const next of [turn({ createdAt: "2026-10-07T08:05:00Z" }), turn({ createdAt: "invalid" }), turn({ createdAt: "2026-10-07T07:59:59Z" }),
    turn({ role: "user" }), turn({ author: { id: "bob", name: "Alice" } }), turn({ notice: true }), turn({ conversationTarget: { taskId: "t", runId: "r" } })]) {
    assert.equal(joinsConversationBubble(first, next), false);
  }
  assert.equal(joinsConversationBubble(turn({ author: undefined }), turn({ author: undefined })), false);
  assert.equal(joinsConversationBubble(turn({ role: "user", author: undefined }), turn({ role: "user", author: undefined })), true);
  assert.equal(joinsConversationBubble(turn({ createdAt: new Date(2026, 9, 6, 23, 59).toISOString() }), turn({ createdAt: new Date(2026, 9, 7, 0, 0).toISOString() })), false);
});
test("IM arrivals suppress initial history, repeats, prepends and replaced windows", () => {
  assert.deepEqual(appendedConversationKeys(null, ["a", "b"]), []);
  assert.deepEqual(appendedConversationKeys([], ["a"]), ["a"]);
  assert.deepEqual(appendedConversationKeys(["a", "b"], ["a", "b"]), []);
  assert.deepEqual(appendedConversationKeys(["a", "b"], ["b", "c"]), ["c"]);
  assert.deepEqual(appendedConversationKeys(["a", "b"], ["older", "a", "b"]), []);
  assert.deepEqual(appendedConversationKeys(["a", "b"], ["a", "other", "b", "c"]), []);
  assert.deepEqual(appendedConversationKeys(["a", "b"], ["x", "y"]), []);
});
test("IM clocks and group monograms do not invent timestamps or split Unicode code points", () => {
  assert.equal(conversationClock("invalid"), ""); assert.equal(conversationDay(), "");
  assert.equal(conversationInitials("设计协作群"), "设计");
  assert.equal(conversationInitials(" Product Design "), "PD");
  assert.equal(conversationInitials("🐯协作"), "🐯协"); assert.equal(conversationInitials(" "), "群");
});
const listItem = (overrides: { title?: string; preview?: string; dissolvedAt?: string | null; tasks?: Array<{ title: string; status: string }> } = {}) => ({
  title: overrides.title ?? "对话", preview: overrides.preview ?? "预览", dissolvedAt: overrides.dissolvedAt ?? null,
  tasks: (overrides.tasks ?? []).map((task, index) => ({ task: { id: `t${index}`, ...task } })),
});
test("IM list archive tiers split archived tasks from unarchived ones instead of showing them alike", () => {
  const dissolved = listItem({ title: "已解散的群", dissolvedAt: "2026-10-06T02:00:00.000Z", tasks: [{ title: "旧任务", status: "archived" }] });
  const archivedTaskOnly = listItem({ title: "任务被归档的群", tasks: [{ title: "别处的归档任务", status: "archived" }] });
  const live = listItem({ title: "还在聊的群", tasks: [{ title: "进行中的任务", status: "doing" }] });
  const items = [dissolved, archivedTaskOnly, live];
  // 归档判定同时覆盖「群聊解散」和「任务已归档」，两者都不能算未归档。
  assert.equal(isConversationArchived(dissolved), true);
  assert.equal(isConversationArchived(archivedTaskOnly), true);
  assert.equal(isConversationArchived(live), false);
  assert.deepEqual(filterConversationList(items, "all", ""), items);
  assert.deepEqual(filterConversationList(items, "active", ""), [live]);
  assert.deepEqual(filterConversationList(items, "archived", ""), [dissolved, archivedTaskOnly]);
  // 搜索词仍能命中归档任务名，档位与查询是同一入口而不是互斥的两套过滤。
  assert.deepEqual(filterConversationList(items, "archived", "旧任务"), [dissolved]);
  assert.deepEqual(filterConversationList(items, "active", "旧任务"), []);
  assert.equal(conversationListFilterLabel("all"), "最近聊天");
  assert.equal(conversationListFilterLabel("active"), "未归档");
  assert.equal(conversationListFilterLabel("archived"), "已归档");
});
test("IM task rows report archived tasks as archived, never as a live run status", () => {
  assert.equal(conversationTaskStateLabel({ task: { status: "archived" }, runs: [{ status: "waiting_user" }] }), "已归档");
  assert.equal(conversationTaskStateLabel({ task: { status: "doing" }, runs: [{ status: "waiting_user" }] }), "等你回复");
  assert.equal(conversationTaskStateLabel({ task: { status: "doing" }, runs: [] }), "待开工");
  assert.equal(conversationTaskStateLabel({ task: { status: "doing" }, runs: [], startup: { state: "failed" } }), "启动失败");
});
