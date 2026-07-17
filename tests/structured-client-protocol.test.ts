import assert from "node:assert/strict";
import test from "node:test";

import { enrichStructuredMessages, WAND_PROTOCOL_VERSION } from "../src/structured-client-protocol.js";
import type { ConversationTurn, ToolUseBlock } from "../src/types.js";

test("protocol v2 normalizes stringified AskUserQuestion input", () => {
  const messages: ConversationTurn[] = [{
    role: "assistant",
    content: [{
      type: "tool_use",
      id: "ask-1",
      name: "AskUserQuestion",
      input: {
        questions: JSON.stringify([{
          question: "继续吗？",
          header: "确认",
          multiSelect: false,
          options: [{ label: "继续", description: "执行下一步" }],
        }]),
      },
    }],
  }];

  const block = enrichStructuredMessages(messages)[0].content[0] as ToolUseBlock;
  assert.equal(WAND_PROTOCOL_VERSION, 2);
  assert.deepEqual(block.semantic, {
    kind: "question_request",
    questions: [{
      question: "继续吗？",
      header: "确认",
      multiSelect: false,
      options: [{ label: "继续", description: "执行下一步" }],
    }],
  });
  assert.equal(messages[0].content[0].type, "tool_use");
  assert.equal((messages[0].content[0] as ToolUseBlock).semantic, undefined, "does not mutate persisted blocks");
});

test("protocol v2 reconstructs provider Task tools into one task_list", () => {
  const messages: ConversationTurn[] = [
    { role: "user", content: [{ type: "text", text: "开始" }] },
    { role: "assistant", content: [
      { type: "tool_use", id: "create-1", name: "TaskCreate", input: { subject: "检查依赖", activeForm: "正在检查" } },
      { type: "tool_result", tool_use_id: "create-1", content: "Task #7 created successfully: 检查依赖" },
      { type: "tool_use", id: "update-1", name: "TaskUpdate", input: { taskId: "7", status: "in_progress" } },
      { type: "tool_use", id: "update-2", name: "TaskUpdate", input: { taskId: "7", status: "completed" } },
    ] },
  ];

  const enriched = enrichStructuredMessages(messages);
  const last = enriched[1].content[3] as ToolUseBlock;
  assert.deepEqual(last.semantic, {
    kind: "task_list",
    items: [{ id: "7", content: "检查依赖", status: "completed", activeForm: "正在检查" }],
  });
});

test("protocol v2 prefers the latest TodoWrite snapshot", () => {
  const messages: ConversationTurn[] = [{
    role: "assistant",
    content: [{
      type: "tool_use",
      id: "todo-1",
      name: "TodoWrite",
      input: { todos: [{ content: "旧任务", status: "pending" }] },
    }, {
      type: "tool_use",
      id: "todo-2",
      name: "TodoWrite",
      input: { todos: [{ content: "新任务", status: "in_progress", activeForm: "正在执行" }] },
    }],
  }];

  const enriched = enrichStructuredMessages(messages);
  const last = enriched[0].content[1] as ToolUseBlock;
  assert.deepEqual(last.semantic, {
    kind: "task_list",
    items: [{ id: "1", content: "新任务", status: "in_progress", activeForm: "正在执行" }],
  });
});
