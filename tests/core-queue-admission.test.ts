import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { AUTO_ASSIGN_SELECTOR } from "../src/model-groups.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { WandStorage } from "../src/storage.js";
import type { StructuredRunnerAdapter, StructuredRunnerResult } from "../src/structured-runner.js";
import type { SessionSnapshot } from "../src/types.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const success = (): StructuredRunnerResult => ({
  state: { blocks: [{ type: "text", text: "offline done" }], result: "offline done", sessionId: null },
  exitCode: 0, signal: null, stderr: "", primaryError: null,
});
function snapshot(id: string, cwd: string): SessionSnapshot {
  return {
    id, sessionKind: "structured", provider: "pi", runner: "pi-cli-json", command: "pi", cwd,
    mode: "managed", status: "idle", exitCode: null, startedAt: new Date(0).toISOString(), endedAt: null,
    output: "", archived: false, archivedAt: null, claudeSessionId: null, messages: [], queuedMessages: [],
    structuredState: { provider: "pi", runner: "pi-cli-json", engine: "core", inFlight: false, activeRequestId: null, lastError: null },
  } as SessionSnapshot;
}
function harness(t: { after(callback: () => void): void }, runner: StructuredRunnerAdapter, customize?: (s: SessionSnapshot) => SessionSnapshot) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-core-admission-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  storage.saveSession(customize?.(snapshot("admission", root)) ?? snapshot("admission", root));
  const manager = new StructuredSessionManager(storage, defaultConfig(), null, {
    core: runner, pi: { start() { throw new Error("never switch to CLI"); } },
  });
  if (customize) {
    // Employee candidate projections are enriched in memory, not standalone DB columns.
    const sessions = (manager as unknown as { sessions: Map<string, SessionSnapshot> }).sessions;
    sessions.set("admission", customize(sessions.get("admission")!));
  }
  t.after(() => { manager.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  return { manager, storage };
}
async function eventually(check: () => boolean) {
  for (let i = 0; i < 50; i++) { if (check()) return; await tick(); }
  assert.ok(check(), "offline queue settles");
}

for (const legacy of [false, true]) {
  test(`Core drain queues new admission, preserves FIFO and resumes once (legacy=${legacy})`, async t => {
    const prompts: string[] = [];
    const { manager, storage } = harness(t, { start({ prompt }) {
      prompts.push(prompt);
      return { args: [], spawnedAt: "", pid: null, interrupt() {}, completion: Promise.resolve(success()) };
    } }, s => legacy ? { ...s, structuredState: { ...s.structuredState!, engine: undefined },
      employeeCandidates: [{ provider: "pi", engine: "sdk", model: "default" }] as SessionSnapshot["employeeCandidates"] } : s);
    const release = manager.beginCoreRestartDrain();
    t.after(release);
    await manager.sendMessage("admission", "first");
    await manager.sendMessage("admission", "second");
    assert.equal(prompts.length, 0);
    assert.equal(manager.getCoreTurnStatus().activeTurnCount, 0);
    assert.equal(manager.get("admission")?.messages?.length, 0, "no phantom user turn before execution");
    assert.deepEqual(storage.getSession("admission")?.queuedMessages, ["first", "second"]);
    await (manager as unknown as { flushNextQueuedMessage(id: string): Promise<void> }).flushNextQueuedMessage("admission");
    await assert.rejects(manager.promoteQueuedMessage("admission", 1, "second"), /排空 Wand Agent/);
    assert.deepEqual(manager.get("admission")?.queuedMessages, ["first", "second"], "flush/promote must not rotate or remove while drained");
    release();
    await eventually(() => prompts.length === 2 && !manager.get("admission")?.structuredState?.inFlight);
    assert.deepEqual(prompts, ["first", "second"]);
    assert.deepEqual(storage.getSession("admission")?.queuedMessages, []);
  });
}

test("an already admitted Core turn remains owned; its continuation waits for drain release", async t => {
  const prompts: string[] = [];
  let complete!: (value: StructuredRunnerResult) => void;
  let interrupted = false;
  const { manager } = harness(t, { start({ prompt }) {
    prompts.push(prompt);
    return { args: [], spawnedAt: "", pid: null, interrupt() { interrupted = true; },
      completion: prompts.length === 1 ? new Promise(resolve => { complete = resolve; }) : Promise.resolve(success()) };
  } });
  const first = manager.sendMessage("admission", "already running");
  assert.equal(prompts.length, 1, "registration occurs synchronously before yielding");
  const release = manager.beginCoreRestartDrain();
  t.after(release);
  assert.equal(manager.getCoreTurnStatus().activeTurnCount, 1);
  await manager.sendMessage("admission", "next");
  complete(success()); await first; await tick(); await tick();
  assert.equal(interrupted, false);
  assert.deepEqual(prompts, ["already running"]);
  assert.deepEqual(manager.get("admission")?.queuedMessages, ["next"]);
  release();
  await eventually(() => prompts.length === 2 && !manager.get("admission")?.structuredState?.inFlight);
  assert.deepEqual(prompts, ["already running", "next"]);
});

test("drain begun during async selection rechecks admission and preserves the earlier input first", async t => {
  const prompts: string[] = [];
  const { manager, storage } = harness(t, { start({ prompt }) {
    prompts.push(prompt);
    return { args: [], spawnedAt: "", pid: null, interrupt() {}, completion: Promise.resolve(success()) };
  } }, s => ({ ...s, selectedModel: AUTO_ASSIGN_SELECTOR }));
  let resolveSelection!: () => void;
  const gate = new Promise<void>(resolve => { resolveSelection = resolve; });
  (manager as unknown as { settleAutoAssignForSend(id: string, session: SessionSnapshot): Promise<{ session: SessionSnapshot }> })
    .settleAutoAssignForSend = async (_id, session) => { await gate; return { session }; };
  const first = manager.sendMessage("admission", "earlier request");
  await tick();
  const release = manager.beginCoreRestartDrain();
  t.after(release);
  await manager.sendMessage("admission", "later request");
  resolveSelection(); await first;
  assert.deepEqual(prompts, []);
  assert.deepEqual(storage.getSession("admission")?.queuedMessages, ["earlier request", "later request"]);
  release();
  await eventually(() => prompts.length === 2 && !manager.get("admission")?.structuredState?.inFlight);
  assert.deepEqual(prompts, ["earlier request", "later request"]);
});
