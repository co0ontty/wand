import assert from "node:assert/strict";
import test from "node:test";

import {
  collectSessionTopicBlocklist,
  collectSessionTopicMessages,
  provisionalSessionTopic,
  SessionTopicCoordinator,
  shouldAcceptGeneratedSessionTitle,
  shouldGenerateSessionTopicFromPtyInput,
  summarizeSessionTitleFromInput,
  type SessionTopic,
} from "../src/session-topic.js";
import type { ConversationTurn } from "../src/types.js";

function turn(role: "user" | "assistant", text: string): ConversationTurn {
  return { role, content: [{ type: "text", text }] };
}

test("collectSessionTopicMessages keeps all user turns and the new repeated input", () => {
  assert.deepEqual(
    collectSessionTopicMessages([
      turn("user", "实现标题总结"),
      turn("assistant", "处理中"),
      turn("user", "加入兜底"),
    ], "加入兜底"),
    ["实现标题总结", "加入兜底", "加入兜底"],
  );
});

test("SessionTopicCoordinator coalesces new turns and discards stale titles", async () => {
  const pending: Array<{
    messages: readonly string[];
    resolve: (topic: SessionTopic) => void;
  }> = [];
  const coordinator = new SessionTopicCoordinator((messages) => new Promise((resolve) => {
    pending.push({ messages, resolve });
  }));
  const topics: SessionTopic[] = [];
  const generating: boolean[] = [];
  const request = (input: string) => coordinator.request("session-1", {
    input,
    onGenerating: (value) => generating.push(value),
    onTopic: (topic) => topics.push(topic),
    onError: assert.fail,
  });

  request("第一轮");
  assert.deepEqual(pending[0].messages, ["第一轮"]);
  request("第二轮");
  pending[0].resolve({ title: "旧标题", description: "旧描述" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pending.length, 2);
  assert.deepEqual(pending[1].messages, ["第一轮", "第二轮"]);
  assert.deepEqual(topics, []);
  pending[1].resolve({ title: "共同标题", description: "共同描述" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(topics, [{ title: "共同标题", description: "共同描述" }]);
  assert.deepEqual(generating, [true, false]);
  coordinator.clear();
});

test("PTY terminal keystrokes do not request a title unless the composer submitted", () => {
  assert.equal(shouldGenerateSessionTopicFromPtyInput("chat"), true);
  assert.equal(shouldGenerateSessionTopicFromPtyInput(undefined), true);
  assert.equal(shouldGenerateSessionTopicFromPtyInput("terminal"), false);
  assert.equal(shouldGenerateSessionTopicFromPtyInput("terminal", "enter_text"), true);
  assert.equal(shouldGenerateSessionTopicFromPtyInput("terminal", "ctrl_c"), false);
});

test("command titles skip the parent task name and keep the specific ask", () => {
  const blocked = collectSessionTopicBlocklist({
    taskName: "重构会话恢复流程",
    workspaceName: "wand",
    cwd: "/Users/me/wand",
  });
  assert.deepEqual(blocked, ["重构会话恢复流程", "wand"]);
  assert.equal(
    summarizeSessionTitleFromInput("重构会话恢复流程\n先把 resume-policy 的时间窗收紧", { blockedTitles: blocked }),
    "先把 resume-policy 的时间窗收紧",
  );
  const clipped = summarizeSessionTitleFromInput("请把侧栏每个终端按我这条命令总结成短标题，不要再显示整个任务名");
  assert.ok(clipped.startsWith("请把侧栏每个终端"));
  assert.ok(clipped.length <= 24);
  assert.notEqual(clipped, "请把侧栏每个终端按我这条命令总结成短标题，不要再显示整个任务名");
  const topic = provisionalSessionTopic("修权限弹窗的文案", blocked);
  assert.deepEqual(topic, {
    title: "修权限弹窗的文案",
    description: "修权限弹窗的文案",
  });
  assert.equal(shouldAcceptGeneratedSessionTitle("重构会话恢复流程", blocked), false);
  assert.equal(shouldAcceptGeneratedSessionTitle("收紧 resume 时间窗", blocked), true);
});
