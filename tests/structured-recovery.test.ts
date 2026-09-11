import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { structuredRunId, type StructuredExecHost, type StructuredRunState } from "../src/structured-exec-host.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";

function fakeHost(runs: StructuredRunState[]): StructuredExecHost {
  return {
    persistent: true,
    async spawnStructured() { throw new Error("not used"); },
    async attachRun(runId) { return runs.find((run) => run.runId === runId) ?? null; },
    async adoptRun(runId) {
      const run = runs.find((item) => item.runId === runId);
      if (!run || run.status !== "running") return null;
      return {
        runId: run.runId,
        incarnationId: run.incarnationId,
        pid: run.pid,
        interrupt() {},
        onStream() { return { dispose() {} }; },
        onExit() { return { dispose() {} }; },
      };
    },
    async listRuns() { return runs; },
    forgetRun() {},
  };
}

test("recoverDetachedRuns restores inFlight and clears the restart interruption note", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-recover-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const sessionId = "recover-session";
  storage.saveSession({
    id: sessionId,
    sessionSource: "interactive",
    sessionKind: "structured",
    provider: "claude",
    runner: "claude-cli-print",
    command: "claude -p",
    cwd: root,
    mode: "assist",
    status: "running",
    exitCode: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    output: "",
    archived: false,
    archivedAt: null,
    messages: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
    queuedMessages: [],
    title: "recover",
    structuredState: {
      provider: "claude",
      runner: "claude-cli-print",
      inFlight: true,
      lastError: null,
      activeRequestId: "old",
    },
  });
  const run: StructuredRunState = {
    runId: structuredRunId(sessionId),
    incarnationId: "inc-1",
    pid: 42,
    status: "running",
    exitCode: null,
    signal: null,
    stdoutSeq: 1,
    stderrSeq: 0,
    stdoutLog: '{"type":"result","result":"ok"}\\n',
    stderrLog: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root },
    null,
    undefined,
    {},
    fakeHost([run]),
  );
  const before = manager.get(sessionId);
  assert.equal(before?.status, "idle");
  assert.match(before?.structuredState?.lastError ?? "", /中断/);
  await manager.recoverDetachedRuns();
  const after = manager.get(sessionId);
  assert.equal(after?.structuredState?.inFlight, true);
  assert.equal(after?.structuredState?.lastError, null);
  manager.dispose();
});

test("recoverDetachedRuns skips SDK sessions and missing daemon runs", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-recover-skip-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  storage.saveSession({
    id: "sdk-session",
    sessionSource: "interactive",
    sessionKind: "structured",
    provider: "claude",
    runner: "claude-sdk",
    command: "claude",
    cwd: root,
    mode: "assist",
    status: "running",
    exitCode: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    output: "",
    archived: false,
    archivedAt: null,
    messages: [],
    queuedMessages: [],
    title: "sdk",
    structuredState: { provider: "claude", runner: "claude-sdk", inFlight: true, lastError: null, activeRequestId: "x" },
  });
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root, structuredRunner: "sdk" },
    null,
    undefined,
    {},
    fakeHost([]),
  );
  await manager.recoverDetachedRuns();
  const sdk = manager.get("sdk-session");
  assert.equal(sdk?.structuredState?.inFlight, false);
  assert.match(sdk?.structuredState?.lastError ?? "", /中断/);
  manager.dispose();
});
