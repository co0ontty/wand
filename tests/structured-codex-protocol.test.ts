import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexRunner } from "../src/structured-codex-adapter.js";
import { CodexProtocolReducer } from "../src/structured-codex-protocol.js";
import type { SessionSnapshot } from "../src/types.js";

function session(): SessionSnapshot {
  return {
    id: "session",
    cwd: process.cwd(),
    mode: "assist",
    status: "running",
    output: "",
    startedAt: new Date(0).toISOString(),
    endedAt: null,
    exitCode: null,
    sessionKind: "structured",
    provider: "codex",
    runner: "codex-cli-exec",
  } as SessionSnapshot;
}

test("CodexProtocolReducer reduces thread, item updates, and authoritative usage", () => {
  const reducer = new CodexProtocolReducer(session());

  assert.equal(reducer.apply({ type: "thread.started", thread_id: "thread-1" }), true);
  assert.equal(reducer.apply({
    type: "item.started",
    item: { id: "message-1", type: "agent_message", text: "draft" },
  }), true);
  assert.equal(reducer.apply({
    type: "item.completed",
    item: { id: "message-1", type: "agent_message", text: "final answer" },
  }), true);
  assert.equal(reducer.apply({
    type: "turn.completed",
    usage: { input_tokens: 11, output_tokens: 7, cached_input_tokens: 3 },
  }), true);

  assert.equal(reducer.state.sessionId, "thread-1");
  assert.equal(reducer.state.result, "final answer");
  assert.deepEqual(reducer.state.blocks, [{ type: "text", text: "final answer" }]);
  assert.deepEqual(reducer.state.usage, {
    inputTokens: 11,
    outputTokens: 7,
    cacheReadInputTokens: 3,
    reasoningOutputTokens: undefined,
  });
});

test("CodexProtocolReducer preserves retry errors and the terminal failure", () => {
  const reducer = new CodexProtocolReducer(session());

  assert.equal(reducer.apply({ type: "error", message: "retrying connection" }), false);
  assert.equal(reducer.apply({ type: "turn.failed", error: { message: "network unavailable" } }), false);

  assert.deepEqual(reducer.errors, ["retrying connection"]);
  assert.equal(reducer.primaryError, "network unavailable");
});

test("CodexRunner owns process IO and exposes only the structured execution port", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-codex-adapter-"));
  const binDir = path.join(root, "bin");
  const executable = path.join(binDir, "codex");
  mkdirSync(binDir);
  writeFileSync(executable, `#!/bin/sh
cat >/dev/null
printf '%s\n' \
'{"type":"thread.started","thread_id":"thread-from-cli"}' \
'{"type":"item.completed","item":{"id":"message","type":"agent_message","text":"from cli"}}' \
'{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":3}}'
`, "utf8");
  chmodSync(executable, 0o755);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  let updates = 0;
  const execution = new CodexRunner().start({
    session: { ...session(), cwd: root },
    prompt: "hello",
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
  }, {
    isActive: () => true,
    onUpdate: () => { updates++; },
  });
  const result = await execution.completion;

  assert.equal(execution.pid === null, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.state.sessionId, "thread-from-cli");
  assert.equal(result.state.result, "from cli");
  assert.equal(result.state.usage?.outputTokens, 3);
  assert.ok(updates >= 3);
});
