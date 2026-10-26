import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { PiRunner } from "../src/structured-pi-adapter.js";
import { defaultConfig } from "../src/config.js";
import { buildChildEnv } from "../src/env-utils.js";
import { SessionLogger } from "../src/session-logger.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { structuredRunId, type StructuredExecHost, type StructuredRunState, type StructuredStreamEvent, type StructuredExitEvent } from "../src/structured-exec-host.js";
import { startStructuredCli } from "../src/structured-exec-pump.js";
import type { StructuredRunnerTurnState } from "../src/structured-runner.js";
import type { SessionSnapshot } from "../src/types.js";

const delta = (text: string): string => JSON.stringify({
  type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text },
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("file reader did not publish in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fixture(t: TestContext, fileOptions: { directory?: string; maxBytes?: number } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pi-output-test-"));
  const files: string[] = [];
  const updates: string[] = [];
  let active = true;
  let kills = 0;
  let starts = 0;
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 42,
    kill() { kills++; return true; },
  });
  const runner = new PiRunner((() => {
    starts++;
    return child as unknown as ChildProcess;
  }) as typeof spawn, undefined, undefined, undefined, () => ({
    directory: root, ...fileOptions, onCreated: (file) => files.push(file),
  }));
  const session = { id: "pi-file-fixture", cwd: root, provider: "pi", command: "pi",
    mode: "managed", claudeSessionId: null } as SessionSnapshot;
  const run = runner.start({ session, prompt: "fixture only", env: {} }, {
    isActive: () => active, onUpdate: (state) => updates.push(state.result),
  });
  // A real child/daemon transport keeps the event loop alive. EventEmitter has
  // no handle; unref-ed watch/poll hints alone need not fire before Node exits.
  const childHandle = setInterval(() => {}, 1000);
  const closeHandle = () => clearInterval(childHandle);
  void run.completion.then(closeHandle, closeHandle);
  t.after(async () => {
    active = false;
    child.emit("close", 0, null);
    await run.completion;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, child, run, files, updates, starts: () => starts, kills: () => kills,
    deactivate: () => { active = false; } };
}

test("Pi updates come from an incremental file reader, including file-only appended events", async (t) => {
  const f = fixture(t);
  f.child.stdout.emit("data", Buffer.from(delta("first") + "\n"));
  assert.deepEqual(f.updates, [], "stdout capture must not call the Pi parser directly");
  assert.equal(f.files.length, 1);
  assert.equal(statSync(f.files[0]).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(f.files[0])).mode & 0o777, 0o700);
  assert.equal(readFileSync(f.files[0], "utf8"), delta("first") + "\n");
  await waitFor(() => f.updates.at(-1) === "first");
  appendFileSync(f.files[0], delta(" from file only") + "\n");
  await waitFor(() => f.updates.at(-1) === "first from file only");
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(f.updates.filter((text) => text === "first from file only").length, 1, "offset prevents duplicate polling");
  f.child.emit("close", 0, null);
  assert.equal((await f.run.completion).state.result, "first from file only");
});

test("Pi file reader holds partial lines and UTF-8 bytes, and drains a final line without newline", async (t) => {
  const f = fixture(t);
  assert.equal(f.files.length, 1);
  const bytes = Buffer.from(delta("中文🙂"));
  const split = bytes.indexOf(Buffer.from("中")) + 1;
  appendFileSync(f.files[0], bytes.subarray(0, split));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(f.updates, []);
  appendFileSync(f.files[0], bytes.subarray(split));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(f.updates, [], "complete JSON without newline waits for the process boundary");
  f.child.emit("close", 0, null);
  const result = await f.run.completion;
  assert.equal(result.state.result, "中文🙂");
  assert.ok(!JSON.stringify(result).includes("\uFFFD"));
});

test("Pi close flushes bytes captured immediately before exit and keeps stderr diagnostic-only", async (t) => {
  const f = fixture(t);
  const bytes = Buffer.from(delta("最后🙂") + "\n");
  const split = bytes.indexOf(Buffer.from("🙂")) + 2;
  f.child.stdout.emit("data", bytes.subarray(0, split));
  f.child.stdout.emit("data", bytes.subarray(split));
  f.child.stderr.emit("data", Buffer.from(delta("not an answer") + "\n"));
  f.child.emit("close", 0, null);
  const result = await f.run.completion;
  assert.equal(result.state.result, "最后🙂");
  assert.match(result.stderr, /not an answer/);
  assert.equal(readFileSync(f.files[0], "utf8"), bytes.toString("utf8"));
  const size = statSync(f.files[0]).size;
  f.child.stdout.emit("data", Buffer.from(delta("late") + "\n"));
  f.run.interrupt();
  assert.equal(statSync(f.files[0]).size, size);
  assert.equal(f.kills(), 0);
});

test("a failed Pi output-file preflight never launches the CLI or bypasses file mode", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pi-file-preflight-"));
  const blocked = path.join(root, "not-a-directory");
  writeFileSync(blocked, "fixture");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = fixture(t, { directory: blocked });
  assert.equal(f.starts(), 0);
  const result = await f.run.completion;
  assert.equal(result.inputAccepted, false);
  assert.equal(result.retryForbidden, true);
  assert.equal(result.failure?.delivery, "rejected");
  assert.match(result.primaryError ?? "", /文件/);
});

test("Pi output-file capacity errors have unknown delivery and cannot fall back or replay", async (t) => {
  const f = fixture(t, { maxBytes: 8 });
  assert.equal(f.files.length, 1);
  f.child.stdout.emit("data", Buffer.from(delta("already executed") + "\n"));
  const result = await f.run.completion;
  assert.equal(result.failure?.delivery, "unknown");
  assert.equal(result.retryForbidden, true);
  assert.notEqual(result.inputAccepted, false);
  assert.equal(result.state.result, "");
  assert.equal(f.kills(), 1);
});

test("Pi file truncation fails closed instead of repeating an already consumed prefix", async (t) => {
  const f = fixture(t);
  f.child.stdout.emit("data", Buffer.from(delta("once") + "\n"));
  await waitFor(() => f.updates.at(-1) === "once");
  truncateSync(f.files[0], 0);
  const result = await f.run.completion;
  assert.equal(result.failure?.delivery, "unknown");
  assert.equal(result.state.result, "once");
  assert.equal(result.retryForbidden, true);
  assert.equal(f.kills(), 1);
});

test("an inactive Pi observer stops file capture without stopping a daemon-owned execution", async (t) => {
  const f = fixture(t);
  f.child.stdout.emit("data", Buffer.from(delta("before") + "\n"));
  await waitFor(() => f.updates.at(-1) === "before");
  const size = statSync(f.files[0]).size;
  f.deactivate();
  f.child.stdout.emit("data", Buffer.from(delta("late for old UI") + "\n"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(statSync(f.files[0]).size, size);
  assert.equal(f.kills(), 0, "display teardown must not kill the independent owner");
});

test("other structured CLI pumps retain direct pipe parsing unless explicitly opted in", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 42,
    kill() { return true; },
  });
  const run = startStructuredCli({
    sessionId: "not-pi", file: "fake", args: [], cwd: os.tmpdir(), env: {},
    spawnProcess: (() => child as unknown as ChildProcess) as typeof spawn,
    observer: { isActive: () => true, onUpdate() {} },
    createState: (): StructuredRunnerTurnState => ({ blocks: [], result: "", sessionId: null }),
    processLine: (line, ctx) => { ctx.state.result += line; },
    finalize: (ctx, exitCode, signal) => ({ state: ctx.state, stderr: ctx.stderr, exitCode, signal, primaryError: null }),
  });
  child.stdout.emit("data", Buffer.from("pipe\n"));
  child.emit("close", 0, null);
  assert.equal((await run.completion).state.result, "pipe");
});

test("Pi file replacement fails closed instead of reading a different incarnation", async (t) => {
  const f = fixture(t);
  f.child.stdout.emit("data", Buffer.from(delta("original") + "\n"));
  await waitFor(() => f.updates.at(-1) === "original");
  renameSync(f.files[0], f.files[0] + ".original");
  writeFileSync(f.files[0], delta("replacement must not be read") + "\n");
  const result = await f.run.completion;
  assert.equal(result.state.result, "original");
  assert.equal(result.failure?.delivery, "unknown");
  assert.equal(f.kills(), 1);
});

test("Pi turns sharing a session artifact root use independent files and cursors", async (t) => {
  const first = fixture(t);
  const next = fixture(t, { directory: first.root });
  assert.notEqual(first.files[0], next.files[0]);
  first.child.stdout.emit("data", Buffer.from(delta("old turn") + "\n"));
  next.child.stdout.emit("data", Buffer.from(delta("new turn") + "\n"));
  first.child.emit("close", 0, null);
  next.child.emit("close", 0, null);
  assert.equal((await first.run.completion).state.result, "old turn");
  assert.equal((await next.run.completion).state.result, "new turn");
  first.child.stdout.emit("data", Buffer.from(delta("late") + "\n"));
  assert.equal(readFileSync(next.files[0], "utf8"), delta("new turn") + "\n");
});

test("recovered Pi replay, live output and file-only events all use the file source before finalization", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pi-file-recovery-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const logger = new SessionLogger(root);
  const id = "recover-pi-file";
  storage.saveSession({
    id, sessionKind: "structured", sessionSource: "interactive", provider: "pi", runner: "pi-cli-json",
    command: "pi --mode json --print", cwd: root, mode: "managed", status: "running",
    exitCode: null, startedAt: new Date().toISOString(), endedAt: null, output: "",
    archived: false, archivedAt: null, messages: [{ role: "user", content: [{ type: "text", text: "fixture" }] }],
    title: "file recovery fixture", queuedMessages: [],
    structuredState: { provider: "pi", runner: "pi-cli-json", engine: "cli", inFlight: true,
      activeRequestId: "old-request", lastError: null },
  });
  const continuation = delta(" after");
  const split = 20;
  const state: StructuredRunState = { runId: structuredRunId(id), incarnationId: "same-running-cli", pid: 42,
    status: "running", exitCode: null, signal: null, stdoutSeq: 1, stderrSeq: 0,
    stdoutLog: delta("before") + "\n" + continuation.slice(0, split), stderrLog: "",
    stdoutTruncated: false, stderrTruncated: false };
  let onStream: ((event: StructuredStreamEvent) => void) | undefined;
  let onExit: ((event: StructuredExitEvent) => void) | undefined;
  let starts = 0;
  const host: StructuredExecHost = {
    persistent: true,
    async spawnStructured() { starts++; throw new Error("recovery must not launch a replacement CLI"); },
    async listRuns() { return [state]; },
    async attachRun() { return state; },
    async adoptRun() { return {
      runId: state.runId, incarnationId: state.incarnationId, pid: state.pid,
      interrupt() {}, onStream(listener) { onStream = listener; return { dispose() {} }; },
      onExit(listener) { onExit = listener; return { dispose() {} }; },
    }; },
    forgetRun() {},
  };
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root }, logger, {}, host);
  t.after(() => { manager.dispose(); logger.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  await manager.recoverDetachedRuns();
  const dir = path.join(root, "sessions", id);
  const files = readdirSync(dir, { recursive: true }).filter((name) => typeof name === "string" && name.endsWith("stdout.jsonl"));
  assert.equal(files.length, 1);
  const file = path.join(dir, String(files[0]));
  assert.equal(readFileSync(file, "utf8"), delta("before") + "\n", "only complete validated projections enter the journal; the source reader holds the partial tail");
  assert.equal(manager.get(id)?.output, "before");
  onStream?.({ stream: "stdout", seq: 2, data: continuation.slice(split) + "\n" });
  onStream?.({ stream: "stdout", seq: 2, data: continuation.slice(split) + "\n" });
  assert.equal(manager.get(id)?.output, "before after", "replayed stream sequence is appended only once");
  appendFileSync(file, delta(" file-only") + "\n");
  await waitFor(() => manager.get(id)?.output === "before after file-only");
  appendFileSync(file, delta(" tail"));
  onExit?.({ exitCode: 0, signal: null });
  assert.equal(manager.get(id)?.output, "before after file-only tail");
  assert.equal(manager.get(id)?.structuredState?.inFlight, false);
  assert.equal(starts, 0);
});

test("real Pi CLI streams through files against a local zero-cost model, without changing its execution mode", { timeout: 30000 }, async (t) => {
  const env = buildChildEnv(true, { PI_OFFLINE: "1" });
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  const available = spawnSync("pi", ["--version"], { env, timeout: 10000, encoding: "utf8" });
  if (available.status !== 0) { t.skip("Pi CLI not installed"); return; }
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pi-file-real-cli-"));
  const agentDir = path.join(root, "agent");
  mkdirSync(agentDir);
  let requests = 0;
  let markVisible!: () => void;
  const visible = new Promise<void>((resolve) => { markVisible = resolve; });
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Only consume the local fixture request; never log its payload. */ }
    requests++;
    res.setHeader("Content-Type", "text/event-stream");
    const part = (content: string | undefined, finish: string | null = null) => `data: ${JSON.stringify({
      id: "file-probe", object: "chat.completion.chunk", created: 1, model: "file-probe",
      choices: [{ index: 0, delta: content === undefined ? {} : { role: "assistant", content }, finish_reason: finish }],
    })}\n\n`;
    res.write(part("file driven "));
    void visible.then(() => { res.write(part("verified")); res.end(part(undefined, "stop") + "data: [DONE]\n\n"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fileProbe: {
    api: "openai-completions", baseUrl: `${origin}/model`, apiKey: "SYNTHETIC_TEST_KEY",
    models: [{ id: "file-probe", name: "File probe", contextWindow: 200000, maxTokens: 1000,
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const files: string[] = [];
  const updates: string[] = [];
  const runner = new PiRunner(undefined, undefined, agentDir, undefined,
    () => ({ directory: root, onCreated: (file) => files.push(file) }));
  const session = { id: "real-pi-file-probe", cwd: root, mode: "managed", provider: "pi",
    command: "pi", selectedModel: "fileProbe/file-probe", thinkingEffort: "off", claudeSessionId: null } as SessionSnapshot;
  const run = runner.start({ session, prompt: "Reply without running tools.", env }, {
    isActive: () => true, onUpdate: (state) => {
      updates.push(state.result);
      if (state.result === "file driven ") markVisible();
    },
  });
  t.after(async () => {
    run.interrupt(); await run.completion;
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const result = await run.completion;
  assert.equal(result.exitCode, 0, result.primaryError ?? result.stderr);
  assert.equal(result.state.result, "file driven verified");
  assert.ok(updates.includes("file driven "), "the UI observes a partial answer before the CLI exits");
  assert.equal(files.length, 1);
  assert.match(readFileSync(files[0], "utf8"), /"type":"message_update"/);
  assert.deepEqual(run.args.slice(0, 3), ["--mode", "json", "--print"]);
  assert.equal(requests, 1, "one local request; no cloud model or repeated submission");
});
