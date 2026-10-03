import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ProcessManager } from "../src/process-manager.js";
import { SessionRegistry } from "../src/session-registry.js";
import { registerSessionRoutes } from "../src/server-session-routes.js";
import type { StructuredRunnerAdapter, StructuredRunnerResult } from "../src/structured-runner.js";

import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { structuredRunId, type StructuredExecHost, type StructuredExitEvent, type StructuredRunState, type StructuredStreamEvent } from "../src/structured-exec-host.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";

interface ScriptedStructuredHost extends StructuredExecHost {
  interrupts: string[];
  forgotten: string[];
  /** 模拟 attach 之后 daemon 继续吐出的 stdout。 */
  push(runId: string, data: string): void;
  /** 模拟运行进程退出。 */
  finish(runId: string, exitCode: number | null, signal?: number | null): void;
}

function fakeHost(runs: StructuredRunState[]): ScriptedStructuredHost {
  const streamHandlers = new Map<string, Array<(event: StructuredStreamEvent) => void>>();
  const exitHandlers = new Map<string, Array<(event: StructuredExitEvent) => void>>();
  let nextSeq = 100;
  const interrupts: string[] = [];
  const forgotten: string[] = [];
  return {
    interrupts,
    forgotten,
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
        interrupt() { interrupts.push(runId); },
        onStream(cb) {
          const list = streamHandlers.get(runId) ?? [];
          list.push(cb);
          streamHandlers.set(runId, list);
          return { dispose() {} };
        },
        onExit(cb) {
          const list = exitHandlers.get(runId) ?? [];
          list.push(cb);
          exitHandlers.set(runId, list);
          return { dispose() {} };
        },
      };
    },
    async listRuns() { return runs; },
    forgetRun(runId) { forgotten.push(runId); },
    push(runId, data) {
      const seq = nextSeq += 1;
      for (const cb of streamHandlers.get(runId) ?? []) cb({ stream: "stdout", data, seq });
    },
    finish(runId, exitCode, signal = null) {
      for (const cb of exitHandlers.get(runId) ?? []) cb({ exitCode, signal });
    },
  };
}

function recoveredInputHarness(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-recovered-input-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const sessionId = "recovered-input";
  storage.saveSession(piInterruptedSession(root, sessionId));
  const run = { ...truncatedPiRun(sessionId, 0), status: "running" as const, exitCode: null };
  const host = fakeHost([run]);
  const starts: string[] = [];
  const releases: Array<() => void> = [];
  const runner: StructuredRunnerAdapter = {
    start({ prompt }) {
      starts.push(prompt);
      return {
        args: [], pid: 45, spawnedAt: new Date().toISOString(), interrupt() {},
        completion: new Promise<StructuredRunnerResult>((resolve) => {
          releases.push(() => resolve({
            state: { blocks: [], result: "done", sessionId: "native-pi" },
            exitCode: 0, signal: null, stderr: "", primaryError: null,
          }));
        }),
      };
    },
  };
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root }, null, { pi: runner }, host);
  t.after(() => {
    manager.dispose();
    for (const release of releases) release();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { manager, host, starts, releases, sessionId, runId: run.runId, storage, root };
}

const nextLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("recovered Pi input queues until the original run exits and then drains once in order", async (t) => {
  const { manager, host, starts, releases, sessionId, runId } = recoveredInputHarness(t);
  await manager.recoverDetachedRuns();
  const requestId = manager.get(sessionId)?.structuredState?.activeRequestId;
  await manager.sendMessage(sessionId, "second");
  await manager.sendMessage(sessionId, "third");
  assert.deepEqual(starts, [], "queue submission must not start another CLI");
  assert.deepEqual(host.interrupts, []);
  assert.deepEqual(manager.get(sessionId)?.queuedMessages, ["second", "third"]);
  assert.equal(manager.get(sessionId)?.structuredState?.activeRequestId, requestId);
  assert.equal(manager.get(sessionId)?.messages?.filter((turn) => turn.role === "user").length, 1);
  host.finish(runId, 0);
  await nextLoop();
  assert.deepEqual(starts, ["second"]);
  assert.deepEqual(manager.get(sessionId)?.queuedMessages, ["third"]);
  releases[0]();
  await nextLoop();
  await nextLoop();
  assert.deepEqual(starts, ["second", "third"]);
});

test("inputs remain queued before inventory and while daemon adoption is pending", async (t) => {
  const { manager, host, starts, sessionId } = recoveredInputHarness(t);
  await manager.sendMessage(sessionId, "before recovery");
  assert.deepEqual(starts, []);
  await assert.rejects(manager.promoteQueuedMessage(sessionId, 0), /正在恢复/);
  assert.deepEqual(manager.get(sessionId)?.queuedMessages, ["before recovery"]);
  assert.throws(() => manager.stop(sessionId), /正在恢复/);
  assert.throws(() => manager.delete(sessionId), /正在恢复/);
  const adopt = host.adoptRun.bind(host);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  host.adoptRun = async (id) => { await gate; return adopt(id); };
  const recovery = manager.recoverDetachedRuns();
  await nextLoop();
  await manager.sendMessage(sessionId, "during adoption");
  assert.deepEqual(starts, []);
  release();
  await recovery;
  assert.deepEqual(manager.get(sessionId)?.queuedMessages, ["before recovery", "during adoption"]);
});

test("explicit promotion interrupts an adopted run, preserves the remainder and sends exactly once", async (t) => {
  const { manager, host, starts, sessionId, runId } = recoveredInputHarness(t);
  await manager.recoverDetachedRuns();
  await manager.sendMessage(sessionId, "second");
  await manager.sendMessage(sessionId, "third");
  await manager.promoteQueuedMessage(sessionId, 1, "third");
  assert.deepEqual(host.interrupts, [runId]);
  assert.deepEqual(starts, []);
  host.finish(runId, null, 15);
  await nextLoop();
  assert.deepEqual(starts, ["third"]);
  assert.deepEqual(manager.get(sessionId)?.queuedMessages, ["second"]);
  assert.equal(manager.get(sessionId)?.structuredState?.lastError, null);
});

test("stopping an adopted run signals it and a late old exit cannot forget or overwrite its replacement", async (t) => {
  const { manager, host, starts, sessionId, runId } = recoveredInputHarness(t);
  await manager.recoverDetachedRuns();
  manager.stop(sessionId);
  assert.deepEqual(host.interrupts, [runId]);
  const replacement = manager.sendMessage(sessionId, "replacement");
  const requestId = manager.get(sessionId)?.structuredState?.activeRequestId;
  const forgottenBeforeOldExit = [...host.forgotten];
  host.finish(runId, null, 15);
  assert.deepEqual(host.forgotten, forgottenBeforeOldExit);
  assert.equal(manager.get(sessionId)?.structuredState?.activeRequestId, requestId);
  await manager.sendMessage(sessionId, "wait for replacement");
  assert.deepEqual(starts, ["replacement"]);
  assert.deepEqual(manager.get(sessionId)?.queuedMessages, ["wait for replacement"]);
  manager.stop(sessionId);
  // The harness settles the replacement only after disposing the manager.
  void replacement;
});

test("stop during adoption interrupts the late handle without reviving the stopped session", async (t) => {
  const { manager, host, sessionId, runId } = recoveredInputHarness(t);
  const adopt = host.adoptRun.bind(host);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  host.adoptRun = async (id) => { await gate; return adopt(id); };
  const recovery = manager.recoverDetachedRuns();
  await nextLoop();
  manager.stop(sessionId);
  release();
  await recovery;
  assert.deepEqual(host.interrupts, [runId]);
  assert.equal(manager.get(sessionId)?.status, "idle");
  assert.equal(manager.get(sessionId)?.structuredState?.inFlight, false);
});

test("server shutdown during adoption leaves the persistent CLI running", async (t) => {
  const { manager, host } = recoveredInputHarness(t);
  const adopt = host.adoptRun.bind(host);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  host.adoptRun = async (id) => { await gate; return adopt(id); };
  const recovery = manager.recoverDetachedRuns();
  await nextLoop();
  manager.dispose();
  release();
  await recovery;
  assert.deepEqual(host.interrupts, []);
  assert.deepEqual(host.forgotten, []);
});

test("Android acknowledgement on a recovered session returns its queue without starting another runner", async (t) => {
  const { manager, starts, sessionId, storage, root } = recoveredInputHarness(t);
  await manager.recoverDetachedRuns();
  const config = { ...defaultConfig(), defaultCwd: root, startupCommands: [] };
  const processes = new ProcessManager(config, storage, root);
  const sessions = new SessionRegistry(processes, manager, storage);
  assert.equal(sessions.ownerOf(sessionId), "structured");
  const app = express();
  app.use(express.json());
  registerSessionRoutes(app, processes, manager, storage, config.defaultMode, config, sessions);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/${sessionId}/input`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "Android queued input", respondImmediately: true }),
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 202);
    const accepted = await response.json() as { queuedMessages: string[]; structuredState: { inFlight: boolean } };
    assert.deepEqual(accepted.queuedMessages, ["Android queued input"]);
    assert.equal(accepted.structuredState.inFlight, true);
    assert.deepEqual(starts, []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    processes.dispose();
  }
});

test("failed adoption retains daemon ownership intent and queued input for retry", async (t) => {
  const { manager, host, starts, sessionId } = recoveredInputHarness(t);
  const adopt = host.adoptRun.bind(host);
  host.adoptRun = async () => { throw new Error("temporary attach failure"); };
  await manager.recoverDetachedRuns();
  assert.deepEqual(host.forgotten, []);
  await manager.sendMessage(sessionId, "wait for recovery retry");
  assert.deepEqual(starts, []);
  host.adoptRun = adopt;
  await manager.recoverDetachedRuns();
  assert.deepEqual(manager.get(sessionId)?.queuedMessages, ["wait for recovery retry"]);
  assert.equal(manager.get(sessionId)?.structuredState?.inFlight, true);
});

test("recoverDetachedRuns preserves the running marker and reattaches the daemon run", async (t) => {
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
    {},
    fakeHost([run]),
  );
  const before = manager.get(sessionId);
  assert.equal(before?.status, "running");
  assert.equal(before?.structuredState?.inFlight, true);
  assert.equal(before?.structuredState?.lastError, null);
  assert.equal(storage.getSession(sessionId)?.status, "running");
  assert.equal(storage.getSession(sessionId)?.structuredState?.inFlight, true);
  await manager.recoverDetachedRuns();
  const after = manager.get(sessionId);
  assert.equal(after?.structuredState?.inFlight, true);
  assert.equal(after?.structuredState?.lastError, null);
  assert.equal(storage.getSession(sessionId)?.status, "running");
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
    id: "missing-cli-session",
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
    messages: [],
    queuedMessages: [],
    title: "missing cli",
    structuredState: {
      provider: "claude",
      runner: "claude-cli-print",
      inFlight: true,
      lastError: null,
      activeRequestId: "cli-x",
    },
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
    { ...defaultConfig(), defaultCwd: root },
    null,
    {},
    fakeHost([]),
  );
  await manager.recoverDetachedRuns();
  const sdk = manager.get("sdk-session");
  assert.equal(sdk?.structuredState?.inFlight, false);
  assert.match(sdk?.structuredState?.lastError ?? "", /中断/);
  const missingCli = manager.get("missing-cli-session");
  assert.equal(missingCli?.structuredState?.inFlight, false);
  assert.match(missingCli?.structuredState?.lastError ?? "", /中断/);
  assert.equal(storage.getSession("missing-cli-session")?.status, "idle");
  manager.dispose();
});

test("recoverDetachedRuns retains durable recovery intent after a transient daemon failure", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-recover-retry-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const sessionId = "retry-session";
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
    messages: [],
    queuedMessages: [],
    title: "retry",
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
    incarnationId: "inc-retry",
    pid: 43,
    status: "running",
    exitCode: null,
    signal: null,
    stdoutSeq: 0,
    stderrSeq: 0,
    stdoutLog: "",
    stderrLog: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
  let listAttempts = 0;
  const host = fakeHost([run]);
  host.listRuns = async () => {
    listAttempts += 1;
    if (listAttempts === 1) throw new Error("temporary disconnect");
    return [run];
  };
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root },
    null,
    {},
    host,
  );

  await manager.recoverDetachedRuns();
  assert.equal(storage.getSession(sessionId)?.status, "running");
  assert.equal(storage.getSession(sessionId)?.structuredState?.inFlight, true);
  await manager.recoverDetachedRuns();
  assert.equal(listAttempts, 2);
  assert.equal(manager.get(sessionId)?.status, "running");
  assert.equal(manager.get(sessionId)?.structuredState?.inFlight, true);
  manager.dispose();
});

/** Minimal pi NDJSON tail: starts mid-line because the daemon caps its replay log. */
function truncatedPiLog(): string {
  return [
    '{"type":"tool_execution_start","toolCa',
    '{"type":"tool_execution_end","toolCallId":"t1","result":"ok"}',
    '{"type":"tool_execution_start","toolCallId":"t2","toolName":"bash","args":{"command":"echo hi"}}',
    '{"type":"tool_execution_end","toolCallId":"t2","result":"hi"}',
    '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"final answer after restart"}}',
    '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"final answer after restart"}],"usage":{"input":10,"output":5}}}',
    "",
  ].join("\n");
}

function piInterruptedSession(root: string, sessionId: string): Parameters<WandStorage["saveSession"]>[0] {
  return {
    id: sessionId,
    sessionSource: "interactive",
    sessionKind: "structured",
    provider: "pi",
    runner: "pi-cli-json",
    command: "pi --mode json --print",
    cwd: root,
    mode: "assist",
    status: "running",
    exitCode: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    output: "narration before restart",
    archived: false,
    archivedAt: null,
    messages: [
      { role: "user", content: [{ type: "text", text: "优化任务面板" }] },
      {
        role: "assistant",
        createdAt: new Date().toISOString(),
        content: [
          { type: "thinking", thinking: "thinking before restart" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
          { type: "text", text: "narration before restart" },
        ],
      },
    ],
    queuedMessages: [],
    title: "truncated replay",
    structuredState: {
      provider: "pi",
      runner: "pi-cli-json",
      inFlight: true,
      lastError: null,
      activeRequestId: "old",
    },
  };
}

function truncatedPiRun(sessionId: string, exitCode: number): StructuredRunState {
  return {
    runId: structuredRunId(sessionId),
    incarnationId: "inc-truncated",
    pid: 44,
    status: "exited",
    exitCode,
    signal: null,
    stdoutSeq: 6,
    stderrSeq: 0,
    stdoutLog: truncatedPiLog(),
    stderrLog: "",
    stdoutTruncated: true,
    stderrTruncated: false,
  };
}

test("recoverDetachedRuns reports a clean exit as success when the replay log was truncated", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-recover-truncated-ok-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const sessionId = "truncated-ok";
  storage.saveSession(piInterruptedSession(root, sessionId));
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root },
    null,
    {},
    fakeHost([truncatedPiRun(sessionId, 0)]),
  );

  await manager.recoverDetachedRuns();

  const after = manager.get(sessionId);
  assert.equal(after?.status, "idle");
  assert.equal(after?.exitCode, 0);
  assert.equal(after?.structuredState?.inFlight, false);
  assert.equal(after?.structuredState?.lastError, null);
  assert.equal(storage.getSession(sessionId)?.status, "idle");

  const messages = after?.messages ?? [];
  assert.equal(messages.length, 2);
  assert.equal(messages[1].content.some((block) => JSON.stringify(block).includes("结构化会话执行失败")), false);
  const turn = JSON.stringify(messages[1].content);
  // 重启前已存的输出必须保留，replay 只补上后半段，且不能重复。
  assert.ok(turn.includes("thinking before restart"));
  assert.ok(turn.includes("final answer after restart"));
  assert.equal(turn.split("narration before restart").length - 1, 1);
  assert.equal(turn.split('"t1"').length - 1, 2);
  assert.equal(turn.split('"t2"').length - 1, 2);
  assert.equal(after?.messages?.[1].completedAt !== undefined, true);
  manager.dispose();
});

test("recoverDetachedRuns keeps the stored transcript when a truncated replay fails", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-recover-truncated-fail-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const sessionId = "truncated-fail";
  storage.saveSession(piInterruptedSession(root, sessionId));
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root },
    null,
    {},
    fakeHost([truncatedPiRun(sessionId, 1)]),
  );

  await manager.recoverDetachedRuns();

  const after = manager.get(sessionId);
  assert.equal(after?.status, "failed");
  const messages = after?.messages ?? [];
  assert.equal(messages.length, 3);
  const kept = JSON.stringify(messages[1].content);
  assert.ok(kept.includes("thinking before restart"));
  assert.ok(kept.includes("narration before restart"));
  assert.match(JSON.stringify(messages[2].content), /结构化会话执行失败/);
  assert.match(after?.structuredState?.lastError ?? "", /exited with code 1/);
  manager.dispose();
});

test("recoverDetachedRuns streams a truncated replay instead of freezing the view", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-recover-truncated-stream-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const sessionId = "truncated-stream";
  const runId = structuredRunId(sessionId);
  storage.saveSession(piInterruptedSession(root, sessionId));
  const host = fakeHost([{ ...truncatedPiRun(sessionId, 0), status: "running", exitCode: null }]);
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root },
    null,
    {},
    host,
  );
  const emitted: Array<{ type: string; data?: { lastMessage?: unknown } }> = [];
  manager.setEventEmitter((event) => { emitted.push(event as unknown as { type: string }); });

  await manager.recoverDetachedRuns();

  // attach 之后前端看到的仍是「重启前的完整 turn」，不是 replay 的半截尾巴。
  const reattached = manager.get(sessionId);
  assert.equal(reattached?.status, "running");
  const base = JSON.stringify(reattached?.messages ?? []);
  assert.ok(base.includes("thinking before restart"), base);
  assert.ok(base.includes("narration before restart"), base);

  // daemon 继续吐出的新块必须同步进入 snapshot 和 emitted payload（流式），且底不丢。
  emitted.length = 0;
  host.push(runId, '{"type":"tool_execution_start","toolCallId":"t3","toolName":"bash","args":{"command":"echo live"}}\n');
  host.push(runId, '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"live answer"}}\n');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const streamed = manager.get(sessionId);
  assert.equal(streamed?.status, "running");
  const streamedJson = JSON.stringify(streamed?.messages ?? []);
  assert.ok(streamedJson.includes("t3"), streamedJson);
  assert.ok(streamedJson.includes("live answer"), streamedJson);
  assert.ok(streamedJson.includes("narration before restart"), streamedJson);
  const payload = emitted.filter((event) => event.type === "output").pop();
  assert.ok(payload, "recovered run must keep emitting incremental output");
  const payloadJson = JSON.stringify(payload?.data?.lastMessage ?? {});
  assert.ok(payloadJson.includes("t3"), payloadJson);
  assert.ok(payloadJson.includes("narration before restart"), payloadJson);

  host.finish(runId, 0, null);
  const finished = manager.get(sessionId);
  assert.equal(finished?.status, "idle");
  assert.equal(finished?.exitCode, 0);
  assert.equal(finished?.structuredState?.lastError, null);
  const finalJson = JSON.stringify(finished?.messages ?? []);
  assert.equal((finalJson.match(/t3/g) ?? []).length, 1, `duplicated transcript=${finalJson}`);
  assert.equal((finalJson.match(/narration before restart/g) ?? []).length, 1, `duplicated transcript=${finalJson}`);
  assert.ok(finalJson.includes("live answer"), finalJson);
  manager.dispose();
});
