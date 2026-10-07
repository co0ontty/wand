import assert from "node:assert/strict";
import test from "node:test";
import { activityDetailText, activityFilePath, activityOpensFile } from "../src/web-ui/browser/tool-activity-detail.js";

test("file previews resolve only real parameters relative to the server session", () => {
  assert.equal(activityFilePath({ path: "src/main.ts" }, "/repo"), "/repo/src/main.ts");
  assert.equal(activityFilePath({ path: "../main.ts" }, "/repo/src"), "/repo/main.ts");
  assert.equal(activityFilePath({ path: "/repo/src/../main.ts" }), "/repo/main.ts");
  assert.equal(activityFilePath({ file_path: {}, path: "a.ts", move_path: "b.ts" }, "/repo"), "/repo/b.ts");
  for (const input of [{ path: "~/a.ts" }, { path: "\0" }, { fileKey: "opaque", preview: "/repo/a.ts" }]) {
    assert.equal(activityFilePath(input, "/repo"), null);
  }
  assert.equal(activityFilePath({ path: "src/main.ts" }), null);
  assert.equal(activityFilePath({ path: "src/main.ts" }, "relative"), null);
});

test("only file activity uses the explicit current-file action", () => {
  assert.equal(activityOpensFile({ activity: { kind: "read_file" } }), true);
  assert.equal(activityOpensFile({ activity: { kind: "edit_file" } }), true);
  assert.equal(activityOpensFile({ activity: { kind: "run_command" } }), false);
  assert.equal(activityOpensFile({}), false);
});

test("detail text keeps full short data and explicitly bounds large output", () => {
  assert.equal(activityDetailText({ count: 0 }), '{\n  "count": 0\n}');
  assert.equal(activityDetailText("<script>"), "<script>"); // HTML escaping belongs to the renderer.
  assert.equal(activityDetailText("abcdef", 3), "abc\n…（仅展示前 3 字）");
  assert.equal(activityDetailText(""), "");
});
