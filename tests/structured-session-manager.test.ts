import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexPatchApplyBlocks,
  thinkingEffortToCodexReasoningEffort,
} from "../src/structured-session-manager.js";

test("codex off thinking effort does not force minimal", () => {
  assert.equal(thinkingEffortToCodexReasoningEffort("off"), null);
  assert.equal(thinkingEffortToCodexReasoningEffort(null), null);
  assert.equal(thinkingEffortToCodexReasoningEffort("standard"), "low");
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
