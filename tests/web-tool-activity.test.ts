import assert from "node:assert/strict";
import test from "node:test";
import {
  commandOccurredAt, currentToolActivity, formatActivityElapsed, groupToolActivities,
  isToolActivityOnly, latestCommandOccurredAt, toolActivityTimeline,
} from "../src/web-ui/browser/tool-activity.js";

test("tool activity counts distinct files and groups their calls for on-demand detail", () => {
  const blocks = [
    { type: "tool_use", id: "edit-1", activity: { kind: "edit_file", fileKey: "opaque-a" } },
    { type: "tool_use", id: "edit-2", activity: { kind: "edit_file", fileKey: "opaque-a" } },
    { type: "tool_use", id: "edit-2", activity: { kind: "edit_file", fileKey: "opaque-a" } },
    { type: "tool_use", id: "read-1", activity: { kind: "read_file", fileKey: "opaque-a" } },
    { type: "tool_use", id: "cmd-1", activity: { kind: "run_command" } },
    { type: "tool_use", id: "cmd-2", activity: { kind: "run_command" } },
    { type: "tool_use", id: "question", semantic: { kind: "question_request" } },
  ];
  const groups = groupToolActivities(blocks.map((block, index) => ({ block, index })));

  assert.equal(groups.edit_file.length, 1);
  assert.deepEqual(groups.edit_file[0]?.calls.map((call) => call.block.id), ["edit-1", "edit-2"]);
  assert.equal(groups.read_file.length, 1);
  assert.equal(groups.run_command.length, 2);
  assert.equal(groups.other.length, 0);
});

test("timeline preserves mixed invocation order and separate calls to the same file", () => {
  const blocks = [
    { type: "tool_use", id: "read", activity: { kind: "read_file", fileKey: "same" } },
    { type: "thinking", thinking: "reasoning" },
    { type: "tool_use", id: "edit", activity: { kind: "edit_file", fileKey: "same" } },
    { type: "tool_use", id: "run", activity: { kind: "run_command" } },
    { type: "tool_use", id: "edit-again", activity: { kind: "edit_file", fileKey: "same" } },
    { type: "tool_use", id: "edit", activity: { kind: "edit_file", fileKey: "same" } },
  ];
  const calls = toolActivityTimeline(blocks.map((block, index) => ({ block, index })));
  assert.deepEqual(calls.map(call => call.index), [0, 1, 2, 3, 4]);
  assert.equal(groupToolActivities(calls).edit_file.length, 1, "summary still counts distinct files");
  // 没有产出正文的轮次不是条目；只有段尾那一块留着当进行中的占位。
  const withBlank = [
    { type: "tool_use", id: "read", activity: { kind: "read_file", fileKey: "same" } },
    { type: "thinking", thinking: "" },
    { type: "thinking", thinking: "有正文" },
  ];
  assert.deepEqual(toolActivityTimeline(withBlank.map((block, index) => ({ block, index })))
    .map(call => call.index), [0, 2]);
});

test("only ordinary activity turns bypass the outer reply disclosure", () => {
  const tool = { type: "tool_use", activity: { kind: "read_file" } };
  assert.equal(isToolActivityOnly([tool, { type: "tool_result" }]), true);
  assert.equal(isToolActivityOnly([{ type: "thinking" }, tool]), true);
  assert.equal(isToolActivityOnly([{ type: "text", text: "  " }, tool]), true);
  assert.equal(isToolActivityOnly([{ type: "text", text: "正文" }, tool]), false);
  assert.equal(isToolActivityOnly([{ type: "tool_use", name: "AskUserQuestion" }]), false);
  assert.equal(isToolActivityOnly([]), false);
  assert.equal(isToolActivityOnly([{ type: "tool_result" }]), false);
});

test("latest command time uses the newest real event and elapsed text is stable", () => {
  const blocks = [
    { type: "tool_use", id: "old", activity: { kind: "run_command", occurredAt: "2026-09-30T12:00:00Z" } },
    { type: "tool_use", id: "invalid", activity: { kind: "run_command", occurredAt: "not-a-time" } },
    { type: "tool_use", id: "new", activity: { kind: "run_command", occurredAt: "2026-09-30T12:03:10Z" } },
  ];
  const groups = groupToolActivities(blocks.map((block, index) => ({ block, index })));
  assert.equal(latestCommandOccurredAt(groups.run_command), "2026-09-30T12:03:10Z");
  assert.equal(commandOccurredAt(groups.run_command, "old"), "2026-09-30T12:00:00Z");
  assert.equal(commandOccurredAt(groups.run_command, "invalid"), null);
  assert.equal(latestCommandOccurredAt(groupToolActivities([
    { block: { type: "tool_use", id: "legacy", activity: { kind: "run_command" } }, index: 0 },
  ]).run_command), null);
  assert.equal(formatActivityElapsed(12_800), "00:12");
  assert.equal(formatActivityElapsed(3_723_000), "1:02:03");
});

test("only the latest unfinished command stays live across later thinking", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "old",
      activity: { kind: "run_command" } }] },
    { role: "user", content: [{ type: "text", text: "second" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "current",
      activity: { kind: "run_command" } }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "checking output" }] },
  ];
  assert.deepEqual(currentToolActivity(messages, 2, {}), {
    latestAssistantIndex: 4, pendingCommandId: "current",
  });
  assert.deepEqual(currentToolActivity(messages, 2, { current: [{ type: "tool_result" }] }), {
    latestAssistantIndex: 4, pendingCommandId: null,
  });
});
