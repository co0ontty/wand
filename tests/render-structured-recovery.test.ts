import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { RenderStructuredClient } from "../src/render-structured-client.js";
import { structuredRenderPaths } from "../src/render-structured-protocol.js";
import { WandStorage } from "../src/storage.js";
import { structuredRunId } from "../src/structured-exec-host.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";

const RUST_BIN = process.env.WAND_STRUCTURED_RENDER_BIN
  || path.resolve("render/target/debug/wand-structured-renderd");

test("S1 v2 metadata inventory replays authoritative pages into recovery after Web restart", {
  skip: existsSync(RUST_BIN) ? false : "Rust v2 binary is not built",
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-v2-recovery-"));
  const configPath = path.join(root, "config.json");
  writeFileSync(configPath, "{}", { mode: 0o600 });
  const paths = structuredRenderPaths(configPath);
  const daemon = spawn(RUST_BIN, ["--config", configPath], { stdio: "ignore" });
  t.after(async () => {
    await stopDaemon(daemon);
    rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !existsSync(paths.tokenPath); i++) await delay(30);
  assert.ok(existsSync(paths.tokenPath));
  const sessionId = "fixture-v2-recovery";
  const start = new RenderStructuredClient(configPath);
  await start.connect();
  const script = [
    "process.stdout.write(JSON.stringify({type:'assistant',session_id:'fixture-id',message:{id:'answer',content:[{type:'text',text:'hello'}]}})+'\\n');",
    "setTimeout(()=>process.stdout.write(JSON.stringify({type:'result',session_id:'fixture-id',result:'hello world',is_error:false})+'\\n'),800);",
  ].join("");
  const run = await start.spawnStructured({ runId: structuredRunId(sessionId), file: process.execPath,
    args: ["-e", script], cwd: root, env: { PATH: process.env.PATH ?? "" } });
  const pid = run.pid;
  const inventory = await start.listRuns();
  assert.equal(inventory[0]?.stdoutLog, "", "inventory must not carry replay bytes");
  let storage = new WandStorage(path.join(root, "wand.db"));
  storage.saveSession({
    id: sessionId, sessionSource: "interactive", sessionKind: "structured", provider: "claude",
    runner: "claude-cli-print", command: "fixture", cwd: root, mode: "assist", status: "running",
    exitCode: null, startedAt: new Date().toISOString(), endedAt: null, output: "",
    archived: false, archivedAt: null, messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
    queuedMessages: [], title: "recovery", structuredState: {
      provider: "claude", runner: "claude-cli-print", inFlight: true, lastError: null, activeRequestId: "old",
    },
  });
  // Simulate Web disappearing while the daemon-owned child continues.
  start.disconnect();
  storage.close();
  storage = new WandStorage(path.join(root, "wand.db"));
  const reconnect = new RenderStructuredClient(configPath);
  await reconnect.connect();
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root },
    null, undefined, {}, reconnect);
  t.after(() => { manager.dispose(); reconnect.disconnect(); storage.close(); });
  await manager.recoverDetachedRuns();
  assert.equal((await reconnect.attachRun(structuredRunId(sessionId)))?.pid, pid);
  for (let i = 0; i < 120 && manager.get(sessionId)?.structuredState?.inFlight; i++) await delay(30);
  const recovered = manager.get(sessionId);
  assert.equal(recovered?.structuredState?.inFlight, false);
  assert.equal(recovered?.output, "hello world");
  assert.equal(recovered?.claudeSessionId, "fixture-id");
});

async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(2_000).then(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }),
  ]);
}
