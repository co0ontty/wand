import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";

test("Grok structured runner consumes streaming-json and resumes the session", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-grok-"));
  const binDir = path.join(root, "bin");
  const argsFile = path.join(root, "args.txt");
  const grok = path.join(binDir, "grok");
  const originalPath = process.env.PATH;
  const originalArgsFile = process.env.WAND_TEST_GROK_ARGS;
  mkdirSync(binDir);
  writeFileSync(grok, `#!/bin/sh
printf '%s\n' "$@" > "$WAND_TEST_GROK_ARGS"
printf '%s\n' \\
'{"type":"thought","data":"checking"}' \\
'{"type":"text","data":"WAND"}' \\
'{"type":"text","data":"_OK"}' \\
'{"type":"end","stopReason":"EndTurn","sessionId":"grok_test","usage":{"input_tokens":10,"output_tokens":4,"reasoning_tokens":2,"cache_read_input_tokens":3},"total_cost_usd":0.25}'
`, "utf8");
  chmodSync(grok, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.WAND_TEST_GROK_ARGS = argsFile;
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => {
    storage.close();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalArgsFile === undefined) delete process.env.WAND_TEST_GROK_ARGS;
    else process.env.WAND_TEST_GROK_ARGS = originalArgsFile;
    rmSync(root, { recursive: true, force: true });
  });

  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root });
  const created = manager.createSession({ cwd: root, mode: "managed", provider: "grok", thinkingEffort: "deep" });
  manager.setSessionTopic(created.id, "test", "test");
  const first = await manager.sendMessage(created.id, "hello");
  assert.equal(first.status, "idle");
  assert.equal(first.runner, "grok-cli-headless");
  assert.equal(first.claudeSessionId, "grok_test");
  assert.equal(first.output, "WAND_OK");
  assert.ok(first.messages?.at(-1)?.content.some((block) => block.type === "thinking" && block.thinking === "checking"));
  assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), [
    "--no-auto-update", "-p", "hello", "--output-format", "streaming-json",
    "--effort", "high", "--always-approve",
  ]);

  await manager.sendMessage(created.id, "again");
  assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n").slice(-2), ["--resume", "grok_test"]);
});
