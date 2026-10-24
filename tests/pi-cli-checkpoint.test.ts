import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { defaultConfig } from "../src/config.js";
import { PiTmuxHost } from "../src/pi-tmux-host.js";
import type { PiCliCheckpoint } from "../src/pi-cli-checkpoint.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { PiRunner } from "../src/structured-pi-adapter.js";
import type { StructuredStreamEvent, StructuredExitEvent } from "../src/structured-exec-host.js";
import type { StructuredExecHost } from "../src/structured-exec-host.js";
import type { SessionSnapshot } from "../src/types.js";

const line = (event: unknown) => JSON.stringify(event) + "\n";
const message = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }],
  stopReason, ...(stopReason === "error" ? { errorMessage: text } : {}) });

function fixture(t: TestContext, tail = "") {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pi-checkpoint-"));
  let storage = new WandStorage(path.join(root, "wand.db"));
  const id = "checkpoint-session";
  const runId = `structured:${id}`;
  const requestId = "original-request";
  const incarnationId = "original-incarnation";
  const session = { id, sessionKind: "structured", sessionSource: "interactive", provider: "pi", runner: "pi-cli-json",
    command: "pi", cwd: root, mode: "managed", status: "running", exitCode: null,
    startedAt: new Date().toISOString(), endedAt: null, output: "", archived: false, archivedAt: null,
    messages: [{ role: "user", content: [{ type: "text", text: "fixture only" }] }], queuedMessages: [],
    structuredState: { provider: "pi", runner: "pi-cli-json", engine: "cli", inFlight: true, activeRequestId: requestId, lastError: null },
  } as SessionSnapshot;
  storage.saveSession(session);
  const slot = path.join(root, "pi-native", createHash("sha256").update(runId).digest("hex").slice(0, 24));
  const turn = path.join(slot, "turn-fixture"); mkdirSync(turn, { recursive: true });
  const events = path.join(turn, "events.jsonl");
  const prefix = line({ type: "turn_end", context: { unused: "x".repeat(9 * 1024 * 1024) }, message: message("数据库中的历史🙂") });
  writeFileSync(events, prefix + tail);
  const stat = statSync(events);
  const checkpoint: PiCliCheckpoint = { version: 1, incarnationId, requestId,
    source: { file: events, dev: stat.dev, ino: stat.ino }, offset: Buffer.byteLength(prefix),
    state: { blocks: [{ type: "text", text: "数据库中的历史🙂" }], result: "数据库中的历史🙂", sessionId: "native-id", phase: "responding" },
    primaryError: null };
  const job = { runId, requestId, incarnationId, tmux: "unused-fixture", events, stderr: path.join(turn, "stderr.log"),
    state: path.join(turn, "state.json"), ready: path.join(turn, "ready.json"), ack: path.join(turn, "ack") };
  writeFileSync(job.stderr, "");
  writeFileSync(job.state, JSON.stringify({ status: "exited", pid: 0, exitCode: 0, signal: null }));
  writeFileSync(path.join(slot, "current.json"), JSON.stringify(job));
  let starts = 0;
  const legacy: StructuredExecHost = { persistent: true,
    async spawnStructured() { starts++; throw new Error("never repeat user input"); },
    async attachRun() { return null; }, async adoptRun() { return null; }, async listRuns() { return []; }, forgetRun() {} };
  const host = new PiTmuxHost(root, legacy);
  const attachedFrom: Array<number | undefined> = [];
  const attach = host.attachRun.bind(host);
  host.attachRun = async (id, checkpoint) => { const state = await attach(id, checkpoint); attachedFrom.push(state?.stdoutFrom); return state; };
  const managers: StructuredSessionManager[] = [];
  t.after(() => { for (const manager of managers) manager.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, id, runId, session, checkpoint, events, host, attachedFrom, starts: () => starts,
    track(manager: StructuredSessionManager) { managers.push(manager); },
    get storage() { return storage; }, reopen() { storage.close(); storage = new WandStorage(path.join(root, "wand.db")); } };
}

test("Pi parsed state and cursor commit atomically, survive reopening, and reject delayed/stale writes", (t) => {
  const f = fixture(t);
  assert.throws(() => f.storage.transaction(() => { f.storage.savePiCliCheckpoint(f.id, f.checkpoint); throw new Error("crash before commit"); }));
  assert.equal(f.storage.getPiCliCheckpoint(f.id), null);
  assert.equal(f.storage.savePiCliCheckpoint(f.id, f.checkpoint), true);
  f.reopen();
  assert.deepEqual(f.storage.getPiCliCheckpoint(f.id), f.checkpoint);
  assert.equal(f.storage.savePiCliCheckpoint(f.id, { ...f.checkpoint, offset: 1, state: { ...f.checkpoint.state, result: "late old state" } }), false);
  assert.equal(f.storage.getPiCliCheckpoint(f.id)?.state.result, "数据库中的历史🙂");
  f.storage.saveSession({ ...f.session, structuredState: { ...f.session.structuredState!, activeRequestId: "next-input" } });
  assert.equal(f.storage.getPiCliCheckpoint(f.id), null);
  assert.equal(f.storage.savePiCliCheckpoint(f.id, f.checkpoint), false);
  f.storage.deleteSession(f.id);
  assert.equal(f.storage.getPiCliCheckpoint(f.id), null);
});

test("native replay reads only bytes after the database checkpoint and validates file identity/boundaries", async (t) => {
  const tail = line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "新增" } });
  const f = fixture(t, tail);
  const state = await f.host.attachRun(f.runId, f.checkpoint);
  assert.equal(state?.stdoutFrom, f.checkpoint.offset);
  assert.equal(state?.stdoutLog, tail);
  assert.equal(state?.stdoutTruncated, false);
  assert.equal((await f.host.attachRun(f.runId, { ...f.checkpoint, incarnationId: "different-turn" }))?.stdoutFrom, undefined);
  assert.equal((await f.host.attachRun(f.runId, { ...f.checkpoint, offset: f.checkpoint.offset - 2 }))?.stdoutFrom, undefined);
  writeFileSync(f.events, tail);
  assert.equal((await f.host.attachRun(f.runId, f.checkpoint))?.stdoutFrom, undefined, "in-place truncation cannot use a cursor beyond EOF");
  renameSync(f.events, f.events + ".old");
  writeFileSync(f.events, tail);
  assert.equal((await f.host.attachRun(f.runId, f.checkpoint))?.stdoutFrom, undefined);
});

test("service recovery restores parsed database history and applies only the subsequent native delta", async (t) => {
  const f = fixture(t, line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " + 增量" } }));
  f.storage.savePiCliCheckpoint(f.id, f.checkpoint);
  f.reopen();
  const manager = new StructuredSessionManager(f.storage, { ...defaultConfig(), defaultCwd: f.root }, null, {}, f.host);
  f.track(manager);
  await manager.recoverDetachedRuns();
  assert.deepEqual(f.attachedFrom, [f.checkpoint.offset]);
  assert.equal(manager.get(f.id)?.output, "数据库中的历史🙂 + 增量");
  assert.equal(manager.get(f.id)?.status, "idle");
  assert.equal(manager.get(f.id)?.structuredState?.lastError, null);
  assert.equal(f.starts(), 0);
});

test("terminal errors stored before restart remain failures even with an empty native tail and exit zero", async (t) => {
  const f = fixture(t);
  f.storage.savePiCliCheckpoint(f.id, { ...f.checkpoint, primaryError: "stored provider error" });
  const manager = new StructuredSessionManager(f.storage, { ...defaultConfig(), defaultCwd: f.root }, null, {}, f.host);
  f.track(manager);
  await manager.recoverDetachedRuns();
  assert.deepEqual(f.attachedFrom, [f.checkpoint.offset]);
  assert.equal(manager.get(f.id)?.status, "failed");
  assert.match(manager.get(f.id)?.structuredState?.lastError ?? "", /stored provider error/);
  assert.equal(f.starts(), 0);
});

test("native checkpoint never advances through a partially received next record", async (t) => {
  const f = fixture(t);
  let stream: ((event: StructuredStreamEvent) => void) | undefined;
  let exit: ((event: StructuredExitEvent) => void) | undefined;
  const host: StructuredExecHost = { persistent: true, piNativeTui: true,
    async spawnStructured() { return { runId: f.runId, incarnationId: f.checkpoint.incarnationId,
      protocolSource: f.checkpoint.source, pid: 42, interrupt() {},
      onStream(listener) { stream = listener; return { dispose() {} }; },
      onExit(listener) { exit = listener; return { dispose() {} }; } }; },
    async attachRun() { return null; }, async adoptRun() { return null; }, async listRuns() { return []; }, forgetRun() {} };
  const checkpoints: PiCliCheckpoint[] = [];
  const run = new PiRunner(undefined, host).start({ session: f.session, prompt: "fixture only", env: {} }, {
    isActive: () => true, onUpdate() {}, onPiCheckpoint: (checkpoint) => checkpoints.push(JSON.parse(JSON.stringify(checkpoint))),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  let offset = 0;
  const send = (data: string) => { offset += Buffer.byteLength(data); stream!({ stream: "stdout", seq: offset, data }); };
  const first = line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "中文🙂" } });
  send(first.slice(0, 20));
  assert.equal(checkpoints.length, 0);
  send(first.slice(20) + '{"type":"agent_');
  assert.equal(checkpoints.length, 0, "state includes a full first event, but its source chunk also contains a partial next event");
  send('end","messages":[]}\n');
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].offset, offset);
  assert.equal(checkpoints[0].state.result, "中文🙂");
  exit!({ exitCode: 0, signal: null });
  assert.equal((await run.completion).primaryError, null);
});

test("a complete legacy native replay is materialized even if the running CLI stays silent afterward", async (t) => {
  const f = fixture(t);
  const log = line({ type: "message_end", message: message("imported once") });
  writeFileSync(f.events, log);
  const state = { runId: f.runId, incarnationId: f.checkpoint.incarnationId, pid: 42, status: "running" as const,
    exitCode: null, signal: null, stdoutSeq: Buffer.byteLength(log), stderrSeq: 0, stdoutLog: log, stderrLog: "",
    stdoutTruncated: false, stderrTruncated: false, nativeFile: f.events };
  const host: StructuredExecHost = { persistent: true,
    async spawnStructured() { throw new Error("must not start"); }, async listRuns() { return [state]; },
    async attachRun() { return state; }, async adoptRun() { return { runId: f.runId, incarnationId: state.incarnationId,
      pid: 42, protocolSource: f.checkpoint.source, interrupt() {},
      onStream() { return { dispose() {} }; }, onExit() { return { dispose() {} }; } }; }, forgetRun() {} };
  const manager = new StructuredSessionManager(f.storage, { ...defaultConfig(), defaultCwd: f.root }, null, {}, host);
  f.track(manager);
  await manager.recoverDetachedRuns();
  assert.equal(f.storage.getPiCliCheckpoint(f.id)?.offset, state.stdoutSeq);
  assert.equal(f.storage.getPiCliCheckpoint(f.id)?.state.result, "imported once");
});

test("a truncated replay cannot replace the database history with a checkpoint of only its tail", async (t) => {
  const f = fixture(t);
  let stream: ((event: StructuredStreamEvent) => void) | undefined;
  const log = line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "tail only" } });
  const state = { runId: f.runId, incarnationId: f.checkpoint.incarnationId, pid: 42, status: "running" as const,
    exitCode: null, signal: null, stdoutSeq: 100, stderrSeq: 0, stdoutLog: log, stderrLog: "",
    stdoutTruncated: true, stderrTruncated: false, nativeFile: f.events };
  const host: StructuredExecHost = { persistent: true,
    async spawnStructured() { throw new Error("must not start"); }, async listRuns() { return [state]; },
    async attachRun() { return state; }, async adoptRun() { return { runId: f.runId, incarnationId: state.incarnationId,
      pid: 42, protocolSource: f.checkpoint.source, interrupt() {},
      onStream(listener) { stream = listener; return { dispose() {} }; }, onExit() { return { dispose() {} }; } }; }, forgetRun() {} };
  const manager = new StructuredSessionManager(f.storage, { ...defaultConfig(), defaultCwd: f.root }, null, {}, host);
  f.track(manager);
  await manager.recoverDetachedRuns();
  stream!({ stream: "stdout", seq: 101, data: log });
  assert.equal(f.storage.getPiCliCheckpoint(f.id), null, "a cursor cannot certify an incomplete materialized prefix");
});

test("legacy history without a checkpoint still imports once through the validated recovery path", async (t) => {
  const f = fixture(t, line({ type: "agent_end", messages: [message("legacy final answer")] }));
  const manager = new StructuredSessionManager(f.storage, { ...defaultConfig(), defaultCwd: f.root }, null, {}, f.host);
  f.track(manager);
  await manager.recoverDetachedRuns();
  assert.deepEqual(f.attachedFrom, [undefined]);
  assert.equal(manager.get(f.id)?.status, "idle");
  assert.equal(manager.get(f.id)?.structuredState?.lastError, null);
  assert.equal(f.starts(), 0);
});
