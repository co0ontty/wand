import assert from "node:assert/strict";
import test from "node:test";

import {
  blockWindowMessagesForTransport,
  compactToolMessagesForTransport,
  truncateMessagesForTransport,
} from "../src/message-truncator.js";
import { enrichStructuredMessages } from "../src/structured-client-protocol.js";
import type { ConversationTurn, ToolResultBlock, ToolUseBlock } from "../src/types.js";

const large = "private output".repeat(20_000);

test("compact projection omits ordinary tool input/results, including live, errors and cross-turn results", () => {
  const raw: ConversationTurn[] = [
    { role: "assistant", content: [
      { type: "tool_use", id: "edit-1", name: "Edit", description: "private patch",
        input: { file_path: "/repo/a.ts", old_string: large, new_string: large } },
      { type: "tool_use", id: "edit-2", name: "Edit", input: { file_path: "/repo/a.ts" } },
      { type: "tool_use", id: "bash-1", name: "Bash", input: { command: `secret-${large}` } },
    ] },
    { role: "assistant", content: [
      { type: "tool_result", tool_use_id: "edit-1", content: large },
      { type: "tool_result", tool_use_id: "bash-1", content: "secret failure", is_error: true },
    ] },
  ];
  const compact = compactToolMessagesForTransport(raw);
  const uses = compact[0].content as ToolUseBlock[];
  const results = compact[1].content as ToolResultBlock[];
  assert.deepEqual(uses.map((use) => use.input), [{}, {}, {}]);
  assert.deepEqual(uses.map((use) => use.activity?.kind), ["edit_file", "edit_file", "run_command"]);
  assert.equal(uses[0].activity?.label, "修改文件");
  assert.equal(uses[0].activity?.fileKey, uses[1].activity?.fileKey);
  assert.ok(uses[0].activity?.fileKey);
  assert.equal(uses[2].activity?.fileKey, undefined);
  assert.deepEqual(results.map((result) => result.content), ["", ""]);
  assert.ok(results.every((result) => result._truncated === true));
  assert.equal(results[1].is_error, true);
  assert.doesNotMatch(JSON.stringify(compact), /secret|private|\/repo\/a\.ts/);
  assert.equal((raw[0].content[0] as ToolUseBlock).input.old_string, large, "persisted source remains intact");
});

test("file activity only counts tools with one identifiable file", () => {
  const specs: Array<[string, string, Record<string, unknown>, string]> = [
    ["read", "Read", { file_path: "/repo/a.ts" }, "read_file"],
    ["edit", "Edit", { file_path: "/repo/a.ts" }, "edit_file"],
    ["write", "Write", { file_path: "/repo/b.ts" }, "edit_file"],
    ["multi-edit", "MultiEdit", { file_path: "/repo/b.ts", edits: [{}, {}] }, "edit_file"],
    ["file-change", "file_change", { file_path: "/repo/c.ts" }, "edit_file"],
    ["read-many", "Read", { paths: ["/repo/a.ts", "/repo/b.ts"] }, "other"],
    ["edit-no-path", "Edit", { old_string: "a", new_string: "b" }, "other"],
    ["grep", "Grep", { path: "/repo", pattern: "x" }, "other"],
    ["glob", "Glob", { path: "/repo", pattern: "*.ts" }, "other"],
    ["web-search", "WebSearch", { query: "x" }, "other"],
    ["web-fetch", "WebFetch", { url: "https://example.com" }, "other"],
    ["todo-read", "TodoRead", {}, "other"],
    ["patch", "apply_patch", { file_path: "/repo/a.ts", patch: "multi-file patch" }, "other"],
    ["bash", "Bash", { command: "pwd" }, "run_command"],
  ];
  const raw: ConversationTurn[] = [{ role: "assistant", content: specs.map(([id, name, input]) => ({
    type: "tool_use", id, name, input,
  })) }];
  const compact = compactToolMessagesForTransport(raw);
  const uses = compact[0].content as ToolUseBlock[];
  assert.deepEqual(uses.map((use) => use.activity?.kind), specs.map(([, , , kind]) => kind));
  for (const use of uses) {
    const isFile = use.activity?.kind === "edit_file" || use.activity?.kind === "read_file";
    assert.equal(Boolean(use.activity?.fileKey), isFile, use.id);
    assert.deepEqual(use.input, {});
  }
  assert.equal(uses[0].activity?.fileKey, uses[1].activity?.fileKey);
  assert.deepEqual(compactToolMessagesForTransport(compact), compact);
});

test("interactive, task, subagent and image tools keep their independent visible contract", () => {
  const raw: ConversationTurn[] = [{ role: "assistant", content: [
    { type: "tool_use", id: "ask", name: "AskUserQuestion", input: { questions: [{
      question: "Pick", options: [{ label: "A" }],
    }] } },
    { type: "tool_result", tool_use_id: "ask", content: "A" },
    { type: "tool_use", id: "todo", name: "TodoWrite", input: { todos: [
      { content: "Build", status: "in_progress" },
    ] } },
    { type: "tool_use", id: "sub", name: "Task", input: { description: "Research" } },
    { type: "tool_use", id: "image", name: "Read", input: { file_path: "/tmp/shot.png" } },
    { type: "tool_result", tool_use_id: "image", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ] },
  ] }];
  const enriched = enrichStructuredMessages(raw, "session-1");
  const compact = compactToolMessagesForTransport(enriched);
  assert.deepEqual(compact, enriched);
  const ask = compact[0].content[0] as ToolUseBlock;
  const todo = compact[0].content[2] as ToolUseBlock;
  assert.equal(ask.semantic?.kind, "question_request");
  assert.equal(todo.semantic?.kind, "task_list");
});

test("opted-in projection runs before the block-window byte budget; legacy streaming remains intact", () => {
  const raw: ConversationTurn[] = [{ role: "assistant", content: [
    { type: "text", text: "Visible response" },
    { type: "tool_use", id: "read", name: "Read", input: { file_path: "/repo/b.txt" } },
    { type: "tool_result", tool_use_id: "read", content: large },
    { type: "text", text: "Done" },
  ] }];
  const legacyLive = truncateMessagesForTransport(raw, {}, 0);
  assert.deepEqual(legacyLive, raw);
  const compact = compactToolMessagesForTransport(raw);
  const windowed = blockWindowMessagesForTransport(compact, {}, 60, 1_000);
  assert.equal(windowed.leadingBlockOffset, 0);
  assert.equal(windowed.messages[0].content.length, 4);
  assert.equal((windowed.messages[0].content[2] as ToolResultBlock).content, "");
});
