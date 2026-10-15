import assert from "node:assert/strict";
import test from "node:test";
import { activityLabel } from "../src/web-ui/react/chat/activity-label.js";

test("commands show supplied intent and actual command, rather than identical Bash labels", () => {
  assert.deepEqual(activityLabel({ name: "Bash", activity: { kind: "run_command", label: "运行命令 · Bash" },
    input: { description: "运行会话回归", command: "npm test -- tests/chat.test.ts" } }), {
    title: "运行会话回归", detail: "npm test -- tests/chat.test.ts", context: "Bash", icon: "terminal",
  });
  assert.equal(activityLabel({ name: "Bash", activity: { kind: "run_command", label: "运行命令 · Bash" }, input: { command: "git diff --check" } }).title, "git diff --check");
  assert.equal(activityLabel({ name: "Bash", input: {} }).title, "Bash");
});

test("files and task updates have distinct targets and semantic icons", () => {
  assert.equal(activityLabel({ name: "Read", activity: { kind: "read_file" }, input: { file_path: "src/main.ts" } }).icon, "file");
  assert.equal(activityLabel({ name: "Edit", activity: { kind: "edit_file" }, input: { file_path: "src/main.ts" } }).icon, "edit");
  assert.equal(activityLabel({ name: "Pi/todo", input: { action: "update", id: 7, status: "completed" } }).title, "完成 · 待办 #7");
  assert.equal(activityLabel({ name: "Pi/todo", input: { action: "create", subject: "核对浏览器" } }).title, "新增待办 · 核对浏览器");
});

test("labels are bounded literal projections and never classify results or invoke tools", () => {
  const row = activityLabel({ name: "Bash", input: { description: "失败也只是原始说明", command: "a".repeat(5000) } });
  assert.equal(row.title, "失败也只是原始说明");
  assert.equal(row.detail.length, 140);
  assert.equal("status" in row, false);
});
