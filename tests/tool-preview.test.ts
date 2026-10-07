import assert from "node:assert/strict";
import test from "node:test";
import { toolInputPreview, toolResultPreview, TOOL_PREVIEW_LIMIT } from "../src/tool-preview.js";
import { enrichStructuredMessages } from "../src/structured-client-protocol.js";
import { compactToolMessagesForTransport } from "../src/message-truncator.js";
import type { ConversationTurn, ToolUseBlock, ToolResultBlock } from "../src/types.js";

const use = (name: string, input: Record<string, unknown>): ToolUseBlock => ({ type: "tool_use", id: name, name, input });

test("collapsed previews expose actual command, search scope, read range and edit size", () => {
  assert.equal(toolInputPreview(use("Bash", { command: "npm run check" })), "npm run check");
  assert.equal(toolInputPreview(use("functions/read", { path: "/repo/src/app.ts", offset: 20, limit: 30 })), "src/app.ts · 起始行 20 · 最多 30 行");
  assert.equal(toolInputPreview(use("Grep", { pattern: "SessionRegistry", path: "src", glob: "*.ts" })), "SessionRegistry · 范围 src · *.ts");
  assert.equal(toolInputPreview(use("Edit", { file_path: "/repo/src/app.ts", old_string: "a\nb\n", new_string: "c\n" })), "src/app.ts · 替换 2 行 → 1 行");
  assert.equal(toolInputPreview(use("Write", { path: "notes.md", content: "# Title\nbody" })), "notes.md · 写入 2 行");
  assert.match(toolInputPreview(use("Pi/todo", { action: "create", subject: "检查工具缩略信息" })), /create.*检查工具缩略信息/);
  assert.match(toolInputPreview(use("Task", { agent: "reviewer", task: "验证更新端点" })), /reviewer.*验证更新端点/);
  assert.equal(toolInputPreview(use("WebFetch", { url: "https://user:password@example.com/docs?token=abc" })), "example.com/docs");
});

test("result previews surface explicit facts and errors without inventing success", () => {
  assert.equal(toolResultPreview({ content: JSON.stringify({ exit_code: 1, output: "FAIL tests/ui.test.ts\nTypeError: missing element" }), is_error: true }), "退出码 1 · FAIL tests/ui.test.ts · TypeError: missing element");
  // 图片结果只报数量，绝不回显 base64 内容。
  assert.equal(toolResultPreview({ content: [{ type: "image", source: { data: "PRIVATE_BASE64" } }] }), "返回 1 张图片");
  assert.doesNotMatch(toolResultPreview({ content: [{ type: "image", source: { data: "PRIVATE_BASE64" } }] }), /PRIVATE_BASE64/);
  assert.equal(toolResultPreview({ content: "" }), "");
  assert.equal(toolResultPreview({ content: JSON.stringify({ matches: ["a.ts", "b.ts"] }) }), "返回 2 项");
  assert.equal(toolResultPreview({ content: "Bearer very-secret-token\npassword=hidden" }), "Bearer [隐藏] · password=[隐藏]");
  assert.ok(toolResultPreview({ content: "x".repeat(100_000) }).length <= TOOL_PREVIEW_LIMIT);
});

test("previews survive compacting, late results and repeated projection without fetching full bodies", () => {
  const raw: ConversationTurn[] = [{ role: "assistant", content: [use("Bash", { command: "npm test" })] },
    { role: "assistant", content: [{ type: "tool_result", tool_use_id: "Bash", content: "tests 18\npass 18\nfail 0" }] }];
  const original = JSON.stringify(raw);
  const compact = compactToolMessagesForTransport(enrichStructuredMessages(raw));
  const call = compact[0].content[0] as ToolUseBlock;
  const result = compact[1].content[0] as ToolResultBlock;
  assert.equal(call.preview, "npm test");
  assert.deepEqual(call.input, {});
  assert.equal(result.preview, "pass 18 · fail 0");
  assert.equal(result.content, "");
  assert.equal(result._truncated, true);
  assert.deepEqual(compactToolMessagesForTransport(enrichStructuredMessages(compact)), compact);
  assert.equal(JSON.stringify(raw), original);
});
