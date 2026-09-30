import assert from "node:assert/strict";
import test from "node:test";
import { groupToolActivities } from "../src/web-ui/browser/tool-activity.js";

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
