import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationTurn, ContentBlock } from "../src/types.js";
import { composerAvatarActivity } from "../src/web-ui/composer-avatar-activity.js";

const running = { structuredState: { inFlight: true } };
const call = (id: string, kind: "read_file" | "edit_file" | "run_command" = "read_file"): ContentBlock => ({ type: "tool_use", id, name: "provider-specific", input: {}, activity: { kind, label: "file" } });
const result = (id: string, error = false): ContentBlock => ({ type: "tool_result", tool_use_id: id, content: "", is_error: error });
const assistant = (...content: ContentBlock[]): ConversationTurn => ({ role: "assistant", content });

test("file action uses unfinished canonical file facts, not general execution or tool names", () => {
  assert.equal(composerAvatarActivity(running), "idle");
  assert.equal(composerAvatarActivity(running, [assistant(call("cmd", "run_command"))]), "idle");
  assert.equal(composerAvatarActivity(running, [assistant(call("r"))]), "reading");
  assert.equal(composerAvatarActivity(running, [assistant(call("w", "edit_file"))]), "writing");
  assert.equal(composerAvatarActivity(running, [assistant({ type: "tool_use", id: "r", name: "Read", input: {} })]), "idle");
});

test("concurrent calls, duplicate snapshots and out-of-order/error results retire only their invocation", () => {
  const messages = [assistant(call("r"), call("w", "edit_file"), call("r"))];
  assert.equal(composerAvatarActivity(running, messages), "writing");
  assert.equal(composerAvatarActivity(running, [...messages, assistant(result("w", true))]), "reading");
  assert.equal(composerAvatarActivity(running, [assistant(result("r")), ...messages]), "writing");
  assert.equal(composerAvatarActivity(running, [...messages, assistant(result("r"), result("w"))]), "idle");
});

test("finished/cancelled/blocked/archived turns, next turn and subagents never leave stale props", () => {
  const messages = [assistant(call("r"))];
  for (const activity of [{ structuredState: { inFlight: false } }, { ...running, permissionBlocked: true }, { ...running, archived: true }]) {
    assert.equal(composerAvatarActivity(activity, messages), "idle");
  }
  assert.equal(composerAvatarActivity(running, [...messages, { role: "user", content: [] }, assistant(call("cmd", "run_command"))]), "idle");
  assert.equal(composerAvatarActivity(running, [{ ...messages[0], completedAt: "2026-10-10T12:00:00Z" }]), "idle");
  assert.equal(composerAvatarActivity(running, [assistant({ ...call("r"), __subagent: { taskId: "child" } })]), "idle");
});
