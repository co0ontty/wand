import assert from "node:assert/strict";
import test from "node:test";
import { chatReplyDuration, chatUsageMetrics } from "../src/web-ui/chat-message-meta.js";

test("reply usage keeps labels, compact values and the exact count available", () => {
  const metrics = chatUsageMetrics({ inputTokens: 12_345, outputTokens: 678, cacheReadInputTokens: 4_096, totalCostUsd: .01231 });
  assert.deepEqual(metrics.map(({ label, value }) => [label, value]), [["输入", "12.3k"], ["缓存命中", "4.1k"], ["输出", "678"], ["费用", "$0.0123"]]);
  assert.equal(metrics[0]!.title, "输入 12345 Token");
  assert.equal(metrics.at(-1)!.title, "费用 $0.01231");
  assert.deepEqual(chatUsageMetrics({ inputTokens: 999, outputTokens: 1_000, reasoningOutputTokens: 1_000_000 }).map(item => item.value), ["999", "1k", "1M"]);
});

test("estimated output settles to final counts without treating input as estimated", () => {
  const usage = { inputTokens: 10, outputTokens: 20, reasoningOutputTokens: 3, estimated: true };
  const estimated = chatUsageMetrics(usage);
  assert.deepEqual(estimated.map(item => item.value), ["10", "≈20", "≈3"]);
  assert.match(estimated[1]!.title, /（估算）/);
  assert.deepEqual(chatUsageMetrics({ ...usage, estimated: false }).map(item => item.value), ["10", "20", "3"]);
});

test("absent, zero and invalid usage never invent counts or a bill", () => {
  assert.deepEqual(chatUsageMetrics(undefined), []);
  assert.deepEqual(chatUsageMetrics({ inputTokens: 0, outputTokens: -1, reasoningOutputTokens: NaN, totalCostUsd: Infinity }), []);
  const pending = chatUsageMetrics({ estimated: true });
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.value, "统计中…");
  assert.deepEqual(chatUsageMetrics({ estimated: false }), []);
});

test("all supported reported token categories remain distinct", () => {
  const metrics = chatUsageMetrics({ inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, reasoningOutputTokens: 5 });
  assert.deepEqual(metrics.map(item => item.key), ["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "outputTokens", "reasoningOutputTokens"]);
  assert.equal(new Set(metrics.map(item => item.key)).size, 5);
});

test("reply duration uses finished recorded anchors, never the clock or a user message", () => {
  const turn = { role: "assistant" as const, createdAt: "2026-10-07T09:00:00.000Z", completedAt: "2026-10-07T09:00:39.000Z" };
  assert.equal(chatReplyDuration(turn), "39 秒");
  assert.equal(chatReplyDuration({ ...turn, completedAt: "2026-10-07T09:00:00.500Z" }), "不足 1 秒");
  assert.equal(chatReplyDuration({ ...turn, completedAt: "2026-10-07T10:04:00.000Z" }), "1 小时 4 分钟");
  for (const invalid of [{ ...turn, role: "user" as const }, { ...turn, createdAt: undefined },
    { ...turn, completedAt: undefined }, { ...turn, createdAt: "invalid" },
    { ...turn, completedAt: turn.createdAt }, { ...turn, completedAt: "2026-10-07T08:00:00.000Z" }]) {
    assert.equal(chatReplyDuration(invalid), null);
  }
});
