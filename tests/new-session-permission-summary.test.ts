import assert from "node:assert/strict";
import test from "node:test";
import { hasAutomaticPermissions, modeHint } from "../src/web-ui/react/new-session/permission-summary.js";
import type { NewSessionForm } from "../src/web-ui/react/new-session/types.js";

const form = (patch: Partial<NewSessionForm> = {}): NewSessionForm => ({
  provider: "claude", kind: "structured", mode: "default", cwd: "/project",
  worktreeEnabled: false, model: "default", ...patch,
});

test("permission summary follows actual provider behavior instead of treating every default as a sandbox", () => {
  assert.equal(hasAutomaticPermissions(form()), false);
  assert.equal(hasAutomaticPermissions(form({ mode: "full-access" })), true);
  assert.equal(hasAutomaticPermissions(form({ mode: "managed" })), true);
  assert.equal(hasAutomaticPermissions(form({ provider: "codex", mode: "default" })), true);
  assert.match(modeHint(form({ provider: "codex" })), /自动批准.*关闭.*沙盒/);
  assert.equal(hasAutomaticPermissions(form({ provider: "qoder" })), true);
  assert.match(modeHint(form({ provider: "qoder" })), /所有模式.*跳过/);
  assert.equal(hasAutomaticPermissions(form({ kind: "shell", mode: "full-access" })), false);
  assert.equal(hasAutomaticPermissions(form({ provider: "gemini", kind: "pty", mode: "auto-edit" })), true);
  assert.equal(hasAutomaticPermissions(form({ provider: "gemini", mode: "auto-edit" })), false);
});

test("Pi CLI and Wand Agent descriptions retain different execution and permission boundaries", () => {
  assert.match(modeHint(form({ provider: "pi", engine: "cli" })), /Pi CLI.*自身.*不会增加逐项权限确认/);
  assert.match(modeHint(form({ provider: "pi", engine: "sdk" })), /Wand Agent.*Wand 内执行/);
  assert.match(modeHint(form({ provider: "opencode" })), /未批准.*拒绝/);
  assert.match(modeHint(form({ provider: "opencode", kind: "pty" })), /终端.*确认/);
  assert.match(modeHint(form({ provider: "opencode", mode: "full-access" })), /自动批准/);
});
