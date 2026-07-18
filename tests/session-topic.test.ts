import assert from "node:assert/strict";
import test from "node:test";

import {
  collectSessionTopicMessages,
  SessionTopicCoordinator,
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
