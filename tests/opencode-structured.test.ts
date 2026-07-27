import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";

test("OpenCode structured runner maps JSON events and resumes the CLI session", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-opencode-"));
  const binDir = path.join(root, "bin");
  const argsFile = path.join(root, "args.txt");
  const opencode = path.join(binDir, "opencode");
  const originalPath = process.env.PATH;
  const originalArgsFile = process.env.WAND_TEST_OPENCODE_ARGS;
  mkdirSync(binDir);
  writeFileSync(opencode, `#!/bin/sh
printf '%s\n' "$@" > "$WAND_TEST_OPENCODE_ARGS"
cat >/dev/null
printf '%s\n' \
'{"type":"step_start","sessionID":"ses_test","part":{"type":"step-start","id":"step_1"}}' \
'{"type":"reasoning","sessionID":"ses_test","part":{"type":"reasoning","id":"reason_1","text":"checking"}}' \
'{"type":"tool_use","sessionID":"ses_test","part":{"type":"tool","id":"tool_1","callID":"call_1","tool":"bash","state":{"status":"completed","input":{"command":"pwd"},"output":"/tmp","title":"pwd"}}}' \
'{"type":"text","sessionID":"ses_test","part":{"type":"text","id":"text_1","text":"done"}}' \
'{"type":"step_finish","sessionID":"ses_test","part":{"type":"step-finish","id":"finish_1","cost":0.25,"tokens":{"input":10,"output":4,"reasoning":2,"cache":{"read":3,"write":1}}}}'
`, "utf8");
  chmodSync(opencode, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.WAND_TEST_OPENCODE_ARGS = argsFile;

  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => {
    storage.close();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalArgsFile === undefined) delete process.env.WAND_TEST_OPENCODE_ARGS;
    else process.env.WAND_TEST_OPENCODE_ARGS = originalArgsFile;
    rmSync(root, { recursive: true, force: true });
  });

  const config = { ...defaultConfig(), defaultCwd: root, inheritEnv: true };
  const manager = new StructuredSessionManager(storage, config);
  const created = manager.createSession({
    cwd: root,
    mode: "managed",
    provider: "opencode",
    model: "anthropic/claude-sonnet-4-6",
    thinkingEffort: "deep",
  });
  manager.setSessionTopic(created.id, "test", "test");

  const first = await manager.sendMessage(created.id, "hello");
  assert.equal(first.status, "idle");
  assert.equal(first.runner, "opencode-cli-run");
  assert.equal(first.claudeSessionId, "ses_test");
  const assistant = first.messages?.at(-1);
  assert.equal(assistant?.role, "assistant");
  assert.deepEqual(assistant?.usage, {
    inputTokens: 10,
    outputTokens: 4,
    reasoningOutputTokens: 2,
    cacheReadInputTokens: 3,
    cacheCreationInputTokens: 1,
    totalCostUsd: 0.25,
  });
  assert.ok(assistant?.content.some((block) => block.type === "thinking" && block.thinking === "checking"));
  assert.ok(assistant?.content.some((block) => block.type === "tool_use" && block.name === "Bash"));
  assert.ok(assistant?.content.some((block) => block.type === "text" && block.text === "done"));

  const firstArgs = readFileSync(argsFile, "utf8").trim().split("\n");
  assert.deepEqual(firstArgs, [
    "run", "--format", "json", "--thinking",
    "--model", "anthropic/claude-sonnet-4-6",
    "--variant", "high",
    "--dangerously-skip-permissions",
  ]);

  await manager.sendMessage(created.id, "again");
  const resumedArgs = readFileSync(argsFile, "utf8").trim().split("\n");
  assert.deepEqual(resumedArgs.slice(-2), ["--session", "ses_test"]);
});
