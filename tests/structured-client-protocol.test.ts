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

test("protocol v2 reconstructs pi's incremental Pi/todo calls into one task_list", () => {
  const messages: ConversationTurn[] = [
    { role: "user", content: [{ type: "text", text: "开始" }] },
    { role: "assistant", content: [
      { type: "tool_use", id: "pi-1", name: "Pi/todo", input: { action: "create", subject: "梳理结构", activeForm: "正在梳理" } },
      { type: "tool_result", tool_use_id: "pi-1", content: "Created #1: 梳理结构 (pending)" },
      { type: "tool_use", id: "pi-2", name: "Pi/todo", input: { action: "create", subject: "跑测试" } },
      { type: "tool_result", tool_use_id: "pi-2", content: "Created #2: 跑测试 (pending)" },
      { type: "tool_use", id: "pi-3", name: "Pi/todo", input: { action: "update", id: 1, status: "in_progress" } },
      { type: "tool_result", tool_use_id: "pi-3", content: "Updated #1 (pending → in_progress)" },
      { type: "tool_use", id: "pi-4", name: "Pi/todo", input: { action: "delete", id: 2 } },
    ] },
  ];

  const enriched = enrichStructuredMessages(messages);
  const last = enriched[1].content[6] as ToolUseBlock;
  assert.deepEqual(last.semantic, {
    kind: "task_list",
    items: [{ id: "1", content: "梳理结构", status: "in_progress", activeForm: "正在梳理" }],
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

test("protocol v2 reads Qoder TodoWrite description fields", () => {
  const messages: ConversationTurn[] = [{
    role: "assistant",
    content: [{
      type: "tool_use",
      id: "qoder-todo",
      name: "TodoWrite",
      input: {
        todos: [
          { description: "统一时间格式化", status: "in_progress" },
          { description: "运行测试", status: "pending" },
        ],
      },
    }],
  }];

  const block = enrichStructuredMessages(messages)[0].content[0] as ToolUseBlock;
  assert.deepEqual(block.semantic, {
    kind: "task_list",
    items: [
      { id: "1", content: "统一时间格式化", status: "in_progress" },
      { id: "2", content: "运行测试", status: "pending" },
    ],
  });
});

test("protocol v2 stamps legacy Task tool calls as subagent activities", () => {
  const messages: ConversationTurn[] = [
    { role: "user", content: [{ type: "text", text: "查一下依赖" }] },
    { role: "assistant", content: [
      { type: "text", text: "我先派一只猫去看看。" },
      { type: "tool_use", id: "task-1", name: "Task", input: { subagent_type: "explore", description: "查看依赖" } },
      { type: "tool_result", tool_use_id: "task-1", content: "依赖只有 express。" },
    ] },
  ];

  const enriched = enrichStructuredMessages(messages);
  const dispatch = enriched[1].content[1];
  const result = enriched[1].content[2];
  assert.deepEqual(dispatch.__subagent, { taskId: "task-1", agentType: "explore", taskDescription: "查看依赖" });
  assert.deepEqual(result.__subagent, { taskId: "task-1", agentType: "explore", taskDescription: "查看依赖" });
  assert.equal(enriched[1].content[0].__subagent, undefined);
  assert.equal(messages[1].content[1].__subagent, undefined, "does not mutate persisted blocks");
});

test("protocol v2 stamps pi subagent dispatches but not management calls", () => {
  const messages: ConversationTurn[] = [
    { role: "assistant", content: [
      { type: "tool_use", id: "pi-1", name: "Pi/subagent", input: { agent: "repo-inventory", task: "列出所有路由文件" } },
      { type: "tool_result", tool_use_id: "pi-1", content: "找到 12 个文件。" },
      { type: "tool_use", id: "pi-2", name: "Pi/subagent", input: { action: "list" } },
      { type: "tool_result", tool_use_id: "pi-2", content: "无运行中的子 Agent。" },
    ] },
  ];

  const enriched = enrichStructuredMessages(messages);
  assert.deepEqual(enriched[0].content[0].__subagent, {
    taskId: "pi-1",
    agentType: "repo-inventory",
    taskDescription: "列出所有路由文件",
  });
  assert.equal(enriched[0].content[1].__subagent?.taskId, "pi-1");
  assert.equal(enriched[0].content[2].__subagent, undefined, "management calls stay in the transcript");
  assert.equal(enriched[0].content[3].__subagent, undefined);
});

test("protocol v2 keeps existing subagent stamps and unrelated tools untouched", () => {
  const existing = { taskId: "task-9", agentType: "general-purpose" };
  const messages: ConversationTurn[] = [
    { role: "assistant", content: [
      { type: "tool_use", id: "task-9", name: "Task", input: { subagent_type: "changed-later" }, __subagent: existing },
      { type: "tool_result", tool_use_id: "task-9", content: "完成" },
      { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", tool_use_id: "bash-1", content: "src" },
    ] },
  ];

  const enriched = enrichStructuredMessages(messages);
  assert.deepEqual(enriched[0].content[0].__subagent, existing);
  assert.deepEqual(enriched[0].content[1].__subagent, existing, "missing result stamp reuses the dispatch meta");
  assert.equal(enriched[0].content[2].__subagent, undefined);
  assert.equal(enriched[0].content[3].__subagent, undefined);
});
