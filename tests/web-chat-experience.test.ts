import assert from "node:assert/strict";
import test from "node:test";
import { currentToolActivity, isPlanTool, isToolActivityOnly, presentActivityBlock } from "../src/web-ui/browser/tool-activity.js";

test("plan receipts are execution records, not replies or description headings", () => {
  const block = { type: "tool_use", id: "plan-1", name: "Pi/todo", input: { action: "create", subject: "梳理界面", description: "很长的内部工作说明" }, semantic: { kind: "task_list", items: [{ content: "梳理界面", status: "pending" }] } };
  const projected = presentActivityBlock(block);
  assert.deepEqual(projected.activity, { kind: "other", label: "新增待办", occurredAt: undefined });
  assert.equal(projected.preview, "梳理界面");
  assert.equal(projected.input, block.input, "full parameters retain their source identity");
  assert.equal(projected.semantic, block.semantic, "the existing progress owner still receives its full snapshot");
  assert.equal((block as any).activity, undefined, "projection never rewrites stored history");
  assert.equal(isToolActivityOnly([block, { type: "tool_result" }]), true);
  assert.equal(isToolActivityOnly([block, { type: "text", text: "这是实际回复" }]), false);
});

test("Claude and Pi planning share readable labels without treating agent dispatch as planning", () => {
  for (const name of ["TodoWrite", "TodoRead", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "Pi/todo"]) {
    assert.equal(isPlanTool({ type: "tool_use", name }), true);
  }
  assert.equal(isPlanTool({ type: "tool_use", name: "Task" }), false);
  assert.equal(isPlanTool({ type: "tool_use", name: "Pi/subagent" }), false);
  assert.equal(isPlanTool({ type: "tool_result", name: "Pi/todo" }), false);
  assert.equal(presentActivityBlock({ type: "tool_use", name: "Pi/todo", input: { action: "update", id: 7, status: "in_progress" } }).preview, "待办 #7 · 进行中");
  assert.equal(presentActivityBlock({ type: "tool_use", name: "TaskUpdate", input: { taskId: "2", status: "completed" } }).preview, "待办 #2 · 已完成");
});

test("active reads and plan calls stay visibly running until their own receipt arrives", () => {
  for (const block of [
    { type: "tool_use", id: "call", name: "Read", activity: { kind: "read_file" } },
    { type: "tool_use", id: "call", name: "Pi/todo", input: { action: "update", id: 1 } },
  ]) {
    const messages = [{ role: "assistant", content: [block] }];
    assert.equal(currentToolActivity(messages, 0, {}).pendingCommandId, "call");
    assert.equal(currentToolActivity(messages, 0, { call: [{}] }).pendingCommandId, null);
    assert.equal(currentToolActivity(messages, 1, {}).pendingCommandId, null, "previous turns cannot become live again");
  }
});

test("decisions and questions retain their independent interaction contracts", () => {
  for (const block of [
    { type: "tool_use", name: "AskUserQuestion", semantic: { kind: "question_request" } },
    { type: "tool_use", name: "decision_evaluate", semantic: { kind: "decision" } },
  ]) {
    assert.equal(presentActivityBlock(block), block);
    assert.equal(isToolActivityOnly([block]), false);
  }
});
