import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";

test("Qoder structured runner consumes stream-json and resumes the session", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-qoder-"));
  const binDir = path.join(root, "bin");
  const argsFile = path.join(root, "args.txt");
  const qoder = path.join(binDir, "qodercli");
  const originalPath = process.env.PATH;
  const originalArgsFile = process.env.WAND_TEST_QODER_ARGS;
  mkdirSync(binDir);
  writeFileSync(qoder, `#!/bin/sh
printf '%s\n' "$@" > "$WAND_TEST_QODER_ARGS"
printf '%s\n' \\
'{"type":"system","subtype":"init","session_id":"qoder_test","model":"performance"}' \\
'{"type":"assistant","uuid":"assistant-1","session_id":"qoder_test","parent_tool_use_id":null,"message":{"role":"assistant","content":[{"type":"thinking","thinking":"checking"},{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"pwd"}},{"type":"text","text":"done"}]}}' \\
'{"type":"user","uuid":"user-1","session_id":"qoder_test","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"/tmp","is_error":false}]}}' \\
'{"type":"result","subtype":"success","uuid":"result-1","session_id":"qoder_test","is_error":false,"result":"done"}'
`, "utf8");
  chmodSync(qoder, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.WAND_TEST_QODER_ARGS = argsFile;
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => {
    storage.close();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalArgsFile === undefined) delete process.env.WAND_TEST_QODER_ARGS;
    else process.env.WAND_TEST_QODER_ARGS = originalArgsFile;
    rmSync(root, { recursive: true, force: true });
  });

  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root });
  const created = manager.createSession({ cwd: root, mode: "managed", provider: "qoder", model: "performance" });
  manager.setSessionTopic(created.id, "test", "test");
  const first = await manager.sendMessage(created.id, "hello");
  assert.equal(first.status, "idle");
  assert.equal(first.runner, "qoder-cli-print");
  assert.equal(first.claudeSessionId, "qoder_test");
  assert.equal(first.output, "done");
  assert.ok(first.messages?.at(-1)?.content.some((block) => block.type === "thinking" && block.thinking === "checking"));
  assert.ok(first.messages?.at(-1)?.content.some((block) => block.type === "tool_use" && block.name === "Bash"));
  assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), [
    "-p", "hello", "--output-format", "stream-json",
    "--model", "performance", "--permission-mode", "bypass_permissions",
  ]);

  await manager.sendMessage(created.id, "again");
  assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n").slice(-2), ["-r", "qoder_test"]);
});
