import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexFileChangeBlocks,
  buildCodexPatchApplyBlocks,
  estimateCodexOutputTokens,
  normalizeStructuredToolResultContent,
  thinkingEffortToCodexReasoningEffort,
} from "../src/structured-session-manager.js";

test("codex off thinking effort does not force minimal", () => {
  assert.equal(thinkingEffortToCodexReasoningEffort("off"), null);
  assert.equal(thinkingEffortToCodexReasoningEffort(null), null);
  assert.equal(thinkingEffortToCodexReasoningEffort("standard"), "low");
});

test("codex live output usage estimate grows with streamed content", () => {
  const short = estimateCodexOutputTokens([{ type: "text", text: "hello" }]);
  const longer = estimateCodexOutputTokens([
    { type: "text", text: "hello world, this is a longer streamed answer" },
    { type: "tool_use", id: "tool_1", name: "Bash", input: { command: "npm test" } },
  ]);
  assert.equal(short, 2);
  assert.ok(longer > short);
  assert.equal(estimateCodexOutputTokens([]), 0);
});

test("structured tool arrays without content-part types remain inspectable", () => {
  const tools = [
    { name: "mcp__figma__get_file", description: "Read a Figma file" },
    { name: "web_search", description: "Search the web" },
  ];

  assert.equal(
    normalizeStructuredToolResultContent(tools),
    JSON.stringify(tools, null, 2),
  );

  const contentParts = [{ type: "output_text", text: "done" }];
  assert.deepEqual(normalizeStructuredToolResultContent(contentParts), contentParts);
});

test("codex patch_apply_end maps changed files to diff cards", () => {
  const blocks = buildCodexPatchApplyBlocks({
    type: "patch_apply_end",
    call_id: "call_patch",
    success: true,
    status: "completed",
    changes: {
      "/repo/src/app.ts": {
        type: "update",
        unified_diff: "@@ -1 +1 @@\n-old\n+new\n",
        move_path: null,
      },
    },
  });

  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], {
    type: "tool_use",
    id: "call_patch#0",
    name: "Edit",
    description: "update",
    input: {
      file_path: "/repo/src/app.ts",
      kind: "update",
      status: "completed",
      unified_diff: "@@ -1 +1 @@\n-old\n+new\n",
    },
  });
  assert.deepEqual(blocks[1], {
    type: "tool_result",
    tool_use_id: "call_patch#0",
    content: "",
    is_error: false,
  });
});

test("codex file_change restores the diff body from start and completion snapshots", () => {
  const item = {
    id: "change_1",
    type: "file_change",
    status: "completed",
    changes: [{ path: "/repo/src/app.ts", kind: "update" }],
  };
  const before = new Map([
    ["change_1#0", { exists: true, text: "const answer = 41;\nexport default answer;\n" }],
  ]);
  const after = new Map([
    ["change_1#0", { exists: true, text: "const answer = 42;\nexport default answer;\n" }],
  ]);

  const blocks = buildCodexFileChangeBlocks(item, true, before, after);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.type, "tool_use");
  if (blocks[0]?.type !== "tool_use") return;
  assert.equal(blocks[0].name, "Edit");
  assert.equal(blocks[0].input.file_path, "/repo/src/app.ts");
  assert.match(String(blocks[0].input.unified_diff), /-const answer = 41;/);
  assert.match(String(blocks[0].input.unified_diff), /\+const answer = 42;/);
  assert.doesNotMatch(String(blocks[0].input.unified_diff), /^[-+]$/m);
  assert.equal("old_string" in blocks[0].input, false);
  assert.equal("new_string" in blocks[0].input, false);
});

test("codex file_change does not fabricate empty diff fields without snapshots", () => {
  const blocks = buildCodexFileChangeBlocks({
    id: "change_2",
    type: "file_change",
    status: "completed",
    changes: [{ path: "/repo/new.txt", kind: "add" }],
  }, true);

  assert.equal(blocks[0]?.type, "tool_use");
  if (blocks[0]?.type !== "tool_use") return;
  assert.deepEqual(blocks[0].input, {
    file_path: "/repo/new.txt",
    kind: "add",
    status: "completed",
  });
});
