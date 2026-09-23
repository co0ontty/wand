import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { ClaudeCliProtocolReducer } from "../src/structured-claude-protocol.js";
import {
  InProcessStructuredExecHost,
  structuredRunId,
  type StructuredExecHost,
  type StructuredExitEvent,
  type StructuredStreamEvent,
} from "../src/structured-exec-host.js";
import { startStructuredCli } from "../src/structured-exec-pump.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
  StructuredRunnerTurnState,
} from "../src/structured-runner.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { applyPiEvent } from "../src/structured-pi-adapter.js";
import { terminalDaemonPaths } from "../src/terminal-daemon-protocol.js";
import { TerminalDaemonClient } from "../src/terminal-daemon-client.js";

const NODE = process.execPath;

function ndjsonScript(lines: string[], exitCode = 0, delayMs = 0): string {
  return `
    const lines = ${JSON.stringify(lines)};
    let i = 0;
    const tick = () => {
      if (i < lines.length) {
        process.stdout.write(lines[i++] + "\\n");
        setTimeout(tick, ${delayMs});
      } else {
        process.stderr.write("diag\\n");
        process.exit(${exitCode});
      }
    };
    tick();
  `;
}

interface Collected {
  stdout: string;
  stderr: string;
  exit: StructuredExitEvent | null;
  done: Promise<void>;
}

class ScriptedClaudeDaemonRunner implements StructuredRunnerAdapter {
  constructor(private readonly execHost: StructuredExecHost) {}

  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    const reducer = new ClaudeCliProtocolReducer(context.session);
    const first = JSON.stringify({
      type: "assistant",
      session_id: "daemon-claude-session",
      message: { id: "answer", content: [{ type: "text", text: "before restart" }] },
    });
    const final = JSON.stringify({
      type: "assistant",
      session_id: "daemon-claude-session",
      message: { id: "answer", content: [{ type: "text", text: "after restart and still running" }] },
    });
    const result = JSON.stringify({
      type: "result",
      session_id: "daemon-claude-session",
      result: "completed after restart",
    });
    const script = `
      process.stdout.write(${JSON.stringify(`${first}\n`)});
      setTimeout(() => {
        process.stdout.write(${JSON.stringify(`${final}\n${result}\n`)});
        process.exit(0);
      }, 1200);
    `;
    return startStructuredCli({
      sessionId: context.session.id,
      file: NODE,
      args: ["-e", script],
      cwd: context.session.cwd,
      env: context.env,
      observer,
      execHost: this.execHost,
      createState: () => reducer.state,
      processLine: (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: unknown;
        try { event = JSON.parse(trimmed); } catch { return; }
        if (reducer.apply(event, false)) observer.onUpdate(reducer.state);
      },
      finalize: (ctx, exitCode, signal, spawnError) => ({
        state: reducer.state,
        exitCode,
        signal,
        stderr: ctx.stderr,
        primaryError: null,
        spawnError,
      }),
    });
  }
}

function collect(
  handle: { onStream(cb: (event: StructuredStreamEvent) => void): { dispose(): void }; onExit(cb: (event: StructuredExitEvent) => void): { dispose(): void } },
): Collected {
  const collected: Collected = { stdout: "", stderr: "", exit: null, done: Promise.resolve() };
  collected.done = new Promise<void>((resolve) => {
    handle.onStream((event) => {
      if (event.stream === "stdout") collected.stdout += event.data;
      else collected.stderr += event.data;
    });
    handle.onExit((event) => {
      collected.exit = event;
      resolve();
    });
  });
  return collected;
}

test("in-process structured host reassembles UTF-8 split across chunks", async () => {
  const host = new InProcessStructuredExecHost();
  const jsonLine = '{"text":"你好🙂"}';
  const payload = jsonLine + "\n";
  const script = [
    `const bytes = Buffer.from(${JSON.stringify(payload)});`,
    "process.stdout.write(bytes.subarray(0, 10));",
    "process.stdout.write(bytes.subarray(10));",
    "process.exit(0);",
  ].join("\n");
  const handle = await host.spawnStructured({
    runId: structuredRunId("s-utf8"),
    file: NODE,
    args: ["-e", script],
    cwd: tmpdir(),
    env: {},
  });
  const collected = collect(handle);
  await Promise.race([collected.done, new Promise((r) => setTimeout(r, 5000))]);
  assert.ok(collected.stdout.includes(jsonLine), `stdout=${JSON.stringify(collected.stdout)}`);
  assert.ok(!collected.stdout.includes("\uFFFD"), `replacement in stdout=${JSON.stringify(collected.stdout)}`);
  assert.equal(collected.exit?.exitCode, 0);
  host.forgetRun(structuredRunId("s-utf8"));
});

test("in-process structured host spawns, streams, and reports exit", async () => {
  const host = new InProcessStructuredExecHost();
  assert.equal(host.persistent, false);
  const handle = await host.spawnStructured({
    runId: structuredRunId("s1"),
    file: NODE,
    args: ["-e", ndjsonScript(["{\"n\":1}", "{\"n\":2}"])],
    cwd: tmpdir(),
    env: {},
  });
  const collected = collect(handle);
  await Promise.race([collected.done, new Promise((r) => setTimeout(r, 5000))]);
  assert.ok(collected.stdout.includes('{"n":1}'));
  assert.ok(collected.stdout.includes('{"n":2}'));
  assert.equal(collected.exit?.exitCode, 0);
  host.forgetRun(structuredRunId("s1"));
});

test("in-process host rejects a one-shot prompt closed before delivery", async () => {
  const host = new InProcessStructuredExecHost();
  const runId = structuredRunId("early-stdin-close");
  const handle = await host.spawnStructured({
    runId, file: NODE, args: ["-e", "process.exit(0)"], cwd: tmpdir(), env: {},
    stdinData: "x".repeat(2 * 1024 * 1024),
  });
  const collected = collect(handle);
  await Promise.race([collected.done, new Promise((_, reject) => setTimeout(() => reject(new Error("stdin-close timeout")), 5000))]);
  assert.equal(collected.exit?.exitCode, -1);
  host.forgetRun(runId);
});

test("daemon-owned structured runs survive client reconnect and replay full logs", async () => {
  const configPath = path.join(mkdtempSync(path.join(tmpdir(), "wand-structured-daemon-")), "config.json");
  // Run the daemon out-of-process so its SIGTERM shutdown handlers never touch
  // the test runner; tsx is available because the suite itself runs under it.
  const daemon = startDaemonProcess(configPath);
  try {
    const paths = terminalDaemonPaths(configPath);
    const waitForToken = async (): Promise<string> => {
      for (let i = 0; i < 100; i++) {
        try { return readFileSync(paths.tokenPath, "utf8").trim(); } catch { /* not yet */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`terminal daemon token never appeared; dir=${JSON.stringify(readdirSync(path.dirname(configPath)))} daemonExit=${daemon.exitCode} stderr=${String(daemon.stderrForDiagnostics ?? "")}`);
    };
    const token = await waitForToken();

    // First "web process": spawn a long-running NDJSON producer.
    const firstClient = new TerminalDaemonClient(paths.socketPath, token);
    await firstClient.connect();
    const script = `
      process.stdout.write('{"n":1}\\n');
      setTimeout(() => { process.stdout.write('{"n":2}\\n'); }, 300);
      setTimeout(() => { process.stdout.write('{"n":3}\\n'); process.exit(0); }, 900);
    `;
    const handle = await firstClient.spawnStructured({
      runId: structuredRunId("s-reconnect"),
      file: NODE,
      args: ["-e", script],
      cwd: tmpdir(),
      env: {},
    });
    const seen: string[] = [];
    handle.onStream((event) => {
      if (event.stream === "stdout") seen.push(event.data.trim());
    });

    // Wait until the second line has been produced, then simulate a web restart.
    await waitFor(() => seen.join("").includes('"n":2'));
    const logBeforeRestart = (await firstClient.attachRun(structuredRunId("s-reconnect")))?.stdoutLog ?? "";
    assert.ok(logBeforeRestart.includes('"n":1'));
    firstClient.disconnect();

    // Second "web process": fresh client adopts the surviving run.
    const secondClient = new TerminalDaemonClient(paths.socketPath, token);
    await secondClient.connect();
    const adoptedState = await secondClient.attachRun(structuredRunId("s-reconnect"));
    assert.ok(adoptedState, "run must survive the client restart");
    assert.equal(adoptedState!.status, "running");
    assert.ok(adoptedState!.stdoutLog.includes('"n":1'));
    assert.ok(adoptedState!.stdoutLog.includes('"n":2'));

    // Adopt live and observe the remaining line plus exit.
    const liveHandle = await secondClient.adoptRun(structuredRunId("s-reconnect"));
    assert.ok(liveHandle);
    const tail: string[] = [];
    const exits: StructuredExitEvent[] = [];
    liveHandle!.onStream((event) => {
      if (event.stream === "stdout") tail.push(event.data);
    });
    liveHandle!.onExit((event) => exits.push(event));
    await waitFor(() => exits.length > 0, 8000);
    assert.equal(exits[0].exitCode, 0);
    // No duplicate replay of already-seen lines beyond the snapshot.
    const tailText = tail.join("");
    assert.ok(tailText.includes('"n":3'), `tail should contain n:3, got: ${JSON.stringify(tailText)}`);
    assert.ok(!tailText.includes('"n":1'), `tail must not replay old lines, got: ${JSON.stringify(tailText)}`);

    // listRuns + forget lifecycle.
    const listed = await secondClient.listRuns();
    assert.ok(listed.some((run) => run.runId === structuredRunId("s-reconnect")));
    secondClient.forgetRun(structuredRunId("s-reconnect"));
    await waitFor(async () => (await secondClient.attachRun(structuredRunId("s-reconnect"))) === null);
    secondClient.disconnect();
  } finally {
    daemon.kill("SIGTERM");
  }
});

test("structured list snapshot stays immutable while adoption drains newer events", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-structured-observed-"));
  const configPath = path.join(root, "config.json");
  const runId = structuredRunId("s-observed-cursor");
  const daemon = startDaemonProcess(configPath);
  let first: TerminalDaemonClient | null = null;
  let second: TerminalDaemonClient | null = null;
  try {
    const paths = terminalDaemonPaths(configPath);
    await waitFor(() => {
      try { return !!readFileSync(paths.tokenPath, "utf8").trim(); } catch { return false; }
    });
    const token = readFileSync(paths.tokenPath, "utf8").trim();
    first = new TerminalDaemonClient(paths.socketPath, token);
    await first.connect();
    await first.spawnStructured({
      runId,
      file: NODE,
      args: ["-e", `
        process.stdout.write("one\\n");
        setTimeout(() => process.stdout.write("two\\n"), 1600);
        setTimeout(() => process.stdout.write("three\\n"), 3200);
      `],
      cwd: root,
      env: {},
    });
    await waitFor(async () => (await first!.attachRun(runId))?.stdoutLog === "one\n");
    first.disconnect();
    first = null;

    second = new TerminalDaemonClient(paths.socketPath, token);
    await second.connect();
    const initial = (await second.listRuns()).find((run) => run.runId === runId);
    assert.equal(initial?.stdoutLog, "one\n");
    const firstSeq = initial!.stdoutSeq;
    // No attach/list after this point: live sdata must not mutate the value
    // already returned to the reducer or its observed adoption watermark.
    await new Promise((resolve) => setTimeout(resolve, 1950));
    assert.equal(initial?.stdoutSeq, firstSeq);
    assert.equal(initial?.stdoutLog, "one\n");
    const adopted = await second.adoptRun(runId);
    assert.ok(adopted);
    const output = collect(adopted!);
    await waitFor(() => output.exit !== null, 8_000);
    assert.equal(output.stdout, "two\nthree\n");
    assert.equal(output.exit?.exitCode, 0);
    second.forgetRun(runId);
  } finally {
    first?.disconnect();
    second?.disconnect();
    await stopDaemonProcess(daemon);
    rmSync(root, { recursive: true, force: true });
  }
});

test("structured manager detaches on web shutdown and recovers the same daemon run", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-structured-manager-restart-"));
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "wand.db");
  const daemon = startDaemonProcess(configPath);
  let firstClient: TerminalDaemonClient | null = null;
  let secondClient: TerminalDaemonClient | null = null;
  let firstStorage: WandStorage | null = null;
  let secondStorage: WandStorage | null = null;
  let firstManager: StructuredSessionManager | null = null;
  let secondManager: StructuredSessionManager | null = null;
  try {
    const paths = terminalDaemonPaths(configPath);
    const waitForToken = async (): Promise<string> => {
      for (let i = 0; i < 100; i++) {
        try { return readFileSync(paths.tokenPath, "utf8").trim(); } catch { /* not yet */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("terminal daemon token never appeared");
    };
    const token = await waitForToken();
    firstClient = new TerminalDaemonClient(paths.socketPath, token);
    await firstClient.connect();
    firstStorage = new WandStorage(dbPath);
    const runner = new ScriptedClaudeDaemonRunner(firstClient);
    firstManager = new StructuredSessionManager(
      firstStorage,
      { ...defaultConfig(), defaultCwd: root },
      null,
      undefined,
      { claudeCli: runner },
      firstClient,
    );
    const session = firstManager.createSession({
      cwd: root,
      mode: "assist",
      provider: "claude",
      runner: "claude-cli-print",
    });
    firstManager.setSessionTopic(session.id, "restart", "restart");
    (firstManager as unknown as { maybeGenerateSessionTopic(): void }).maybeGenerateSessionTopic = () => {};
    void firstManager.sendMessage(session.id, "continue through restart");
    await waitFor(() => JSON.stringify(firstManager?.get(session.id)?.messages ?? []).includes("before restart"));
    const beforeRestart = await firstClient.attachRun(structuredRunId(session.id));
    assert.ok(beforeRestart);
    assert.equal(beforeRestart!.status, "running");
    const originalPid = beforeRestart!.pid;

    firstManager.dispose();
    firstManager = null;
    firstClient.disconnect();
    firstClient = null;
    firstStorage.close();
    firstStorage = null;

    secondClient = new TerminalDaemonClient(paths.socketPath, token);
    await secondClient.connect();
    const whileWebWasDown = await secondClient.attachRun(structuredRunId(session.id));
    assert.ok(whileWebWasDown, "daemon run must survive web manager disposal");
    assert.equal(whileWebWasDown!.status, "running");
    assert.equal(whileWebWasDown!.pid, originalPid);

    secondStorage = new WandStorage(dbPath);
    assert.equal(secondStorage.getSession(session.id)?.status, "running");
    secondManager = new StructuredSessionManager(
      secondStorage,
      { ...defaultConfig(), defaultCwd: root },
      null,
      undefined,
      {},
      secondClient,
    );
    await secondManager.recoverDetachedRuns();
    await waitFor(() => secondManager?.get(session.id)?.status === "idle", 8_000);
    const recovered = secondManager.get(session.id);
    assert.equal(recovered?.output, "completed after restart");
    assert.equal(recovered?.claudeSessionId, "daemon-claude-session");
    assert.ok(
      JSON.stringify(recovered?.messages ?? []).includes("after restart"),
      JSON.stringify(recovered?.messages ?? []),
    );
    assert.equal(secondStorage.getSession(session.id)?.structuredState?.inFlight, false);
    await waitFor(async () => (await secondClient!.attachRun(structuredRunId(session.id))) === null);
  } finally {
    try { secondManager?.dispose(); } catch { /* best effort */ }
    try { firstManager?.dispose(); } catch { /* best effort */ }
    try { secondClient?.disconnect(); } catch { /* best effort */ }
    try { firstClient?.disconnect(); } catch { /* best effort */ }
    try { secondStorage?.close(); } catch { /* best effort */ }
    try { firstStorage?.close(); } catch { /* best effort */ }
    await stopDaemonProcess(daemon);
    rmSync(root, { recursive: true, force: true });
  }
});

class ScriptedPiFloodRunner implements StructuredRunnerAdapter {
  /** 洪泛行数 × 每行长度必须超过 STRUCTURED_RUN_LOG_MAX_CHARS，才能真的触发 daemon 截断。 */
  constructor(
    private readonly execHost: StructuredExecHost,
    private readonly floodLines = 72,
    private readonly floodLineBytes = 120_000,
    private readonly postFloodDelayMs = 6_000,
  ) {}
  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    const state: StructuredRunnerTurnState = {
      blocks: [],
      result: "",
      sessionId: context.session.claudeSessionId,
      model: context.session.selectedModel ?? undefined,
      phase: "responding",
    };
    const line = (event: Record<string, unknown>): string => JSON.stringify(event) + "\n";
    const pre = [
      line({ type: "session", id: "pi-flood-session" }),
      line({ type: "turn_start" }),
      line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "before restart" } }),
      line({ type: "tool_execution_start", toolCallId: "pre-1", toolName: "bash", args: { command: "echo pre" } }),
      line({ type: "tool_execution_end", toolCallId: "pre-1", result: "pre" }),
    ].join("");
    // mid-1 出现在洪泛之后：重启时它仍在 daemon 尾部日志里，是「本地已存 turn」和
    // 「replay turn」唯一的重叠锚点，新增块就是靠它定位的。
    const mid = [
      line({ type: "tool_execution_start", toolCallId: "mid-1", toolName: "bash", args: { command: "echo mid" } }),
      line({ type: "tool_execution_end", toolCallId: "mid-1", result: "mid" }),
    ].join("");
    const live = [
      line({ type: "tool_execution_start", toolCallId: "live-1", toolName: "bash", args: { command: "echo live" } }),
      line({ type: "tool_execution_end", toolCallId: "live-1", result: "live" }),
    ].join("");
    const liveText = line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "live streaming answer" } });
    const post = [
      line({ type: "tool_execution_start", toolCallId: "post-1", toolName: "bash", args: { command: "echo post" } }),
      line({ type: "tool_execution_end", toolCallId: "post-1", result: "post" }),
      line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "after restart" } }),
      line({ type: "turn_end", message: { role: "assistant", model: "flood-model", stopReason: "stop", content: [{ type: "text", text: "after restart" }] } }),
    ].join("");
    const script = `
      process.stdout.write(${JSON.stringify(pre)});
      const pad = "x".repeat(${this.floodLineBytes});
      for (let i = 0; i < ${this.floodLines}; i++) process.stdout.write(JSON.stringify({ type: "flood", i, pad }) + "\\n");
      process.stdout.write(${JSON.stringify(mid)});
      setTimeout(() => process.stdout.write(${JSON.stringify(live)}), 1200);
      setTimeout(() => process.stdout.write(${JSON.stringify(liveText)}), 3000);
      setTimeout(() => {
        process.stdout.write(${JSON.stringify(post)});
        process.exit(0);
      }, ${this.postFloodDelayMs});
    `;
    return startStructuredCli({
      sessionId: context.session.id,
      file: NODE,
      args: ["-e", script],
      cwd: context.session.cwd,
      env: context.env,
      observer,
      execHost: this.execHost,
      createState: () => state,
      processLine: (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: Record<string, unknown>;
        try { event = JSON.parse(trimmed) as Record<string, unknown>; } catch { return; }
        applyPiEvent(state, event);
        observer.onUpdate(state);
      },
      finalize: (ctx, exitCode, signal, spawnError) => ({
        state,
        exitCode,
        signal,
        stderr: ctx.stderr,
        primaryError: null,
        spawnError,
      }),
    });
  }
}

test("truncated daemon replay keeps the checkpoint transcript instead of failing a clean exit", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-structured-truncated-recovery-"));
  const configPath = path.join(root, "config.json");
  const dbPath = path.join(root, "wand.db");
  const daemon = startDaemonProcess(configPath);
  let client: TerminalDaemonClient | null = null;
  let storage: WandStorage | null = null;
  let manager: StructuredSessionManager | null = null;
  try {
    const paths = terminalDaemonPaths(configPath);
    const token = await (async (): Promise<string> => {
      for (let i = 0; i < 100; i++) {
        try { return readFileSync(paths.tokenPath, "utf8").trim(); } catch { /* not yet */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("terminal daemon token never appeared");
    })();
    client = new TerminalDaemonClient(paths.socketPath, token);
    await client.connect();
    storage = new WandStorage(dbPath);
    manager = new StructuredSessionManager(
      storage,
      { ...defaultConfig(), defaultCwd: root },
      null,
      undefined,
      { pi: new ScriptedPiFloodRunner(client) },
      client,
    );
    const session = manager.createSession({ cwd: root, mode: "assist", provider: "pi", runner: "pi-cli-json" });
    manager.setSessionTopic(session.id, "flood", "flood");
    (manager as unknown as { maybeGenerateSessionTopic(): void }).maybeGenerateSessionTopic = () => {};
    void manager.sendMessage(session.id, "flood stdout");

    // 等 checkpoint 落盘：mid-1 必须已经在库里，重启后才有「本地已存 turn」可比对。
    await waitFor(() => JSON.stringify(storage?.getSession(session.id)?.messages ?? []).includes("mid-1"), 30_000);
    const beforeRestart = await client.attachRun(structuredRunId(session.id));
    assert.equal(beforeRestart?.status, "running");
    assert.equal(beforeRestart?.stdoutTruncated, true, "precondition: daemon log must exceed the 8MB cap");
    const originalPid = beforeRestart!.pid;

    manager.dispose();
    manager = null;
    client.disconnect();
    client = null;
    storage.close();
    storage = null;

    client = new TerminalDaemonClient(paths.socketPath, token);
    await client.connect();
    const recoveredState = await client.attachRun(structuredRunId(session.id));
    assert.ok(recoveredState, "daemon run must survive web manager disposal");
    assert.equal(recoveredState!.status, "running");
    assert.equal(recoveredState!.pid, originalPid);
    assert.equal(recoveredState!.stdoutTruncated, true);
    assert.ok(
      !recoveredState!.stdoutLog.includes("before restart"),
      "pre-flood output must have been evicted from the daemon log",
    );

    storage = new WandStorage(dbPath);
    // 模拟「上一轮已经拿到 resume id」的真实场景：截断后 replay 里看不到 pi 的
    // session 事件，但 checkpoint 里的 claudeSessionId 必须被保留。
    const persisted = storage.getSession(session.id);
    assert.ok(persisted);
    storage.saveSession({ ...persisted!, claudeSessionId: "pi-flood-session" });
    manager = new StructuredSessionManager(
      storage,
      { ...defaultConfig(), defaultCwd: root },
      null,
      undefined,
      { pi: new ScriptedPiFloodRunner(client) },
      client,
    );
    (manager as unknown as { maybeGenerateSessionTopic(): void }).maybeGenerateSessionTopic = () => {};
    await manager.recoverDetachedRuns();

    // 恢复期间必须继续流式：还在跑的时候就要能看到重启后的新块，并且底没被 replay 覆盖。
    await waitFor(() => {
      const live = manager?.get(session.id);
      if (live?.status !== "running") return false;
      const json = JSON.stringify(live.messages ?? []);
      return json.includes("live-1") && json.includes("before restart") && json.includes("mid-1");
    }, 30_000);
    const streamed = manager.get(session.id);
    assert.equal(streamed?.structuredState?.inFlight, true);
    const streamedJson = JSON.stringify(streamed?.messages ?? []);
    assert.ok(streamedJson.includes("pre-1"), streamedJson);
    // 视图必须随新事件继续增长（而不是只在收尾时一次性出现）。
    await waitFor(() => JSON.stringify(manager?.get(session.id)?.messages ?? []).includes("live streaming answer"), 30_000);

    await waitFor(() => manager?.get(session.id)?.status === "idle", 30_000);

    const recovered = manager.get(session.id);
    assert.equal(recovered?.exitCode, 0);
    assert.equal(recovered?.structuredState?.lastError, null);
    assert.equal(recovered?.structuredState?.inFlight, false);
    assert.equal(recovered?.claudeSessionId, "pi-flood-session");
    const transcript = JSON.stringify(recovered?.messages ?? []);
    // 重启前的内容只存在于 checkpoint 里（daemon 日志已把它挤掉），不能被 replay 覆盖掉。
    assert.ok(transcript.includes("before restart"), transcript);
    assert.ok(transcript.includes("pre-1"), transcript);
    assert.ok(transcript.includes("mid-1"), transcript);
    // 重启后的新增块（含工具调用）必须按锚点并进来，而不是当成「已存在」丢掉。
    assert.ok(transcript.includes("after restart"), transcript);
    assert.ok(transcript.includes("post-1"), transcript);
    assert.ok(transcript.includes("live-1"), transcript);
    assert.equal((transcript.match(/before restart/g) ?? []).length, 1, `duplicated transcript=${transcript}`);
    assert.equal((transcript.match(/"id":"live-1"/g) ?? []).length, 1, `duplicated transcript=${transcript}`);
    assert.ok(!transcript.includes("服务重启后运行进程已丢失"), transcript);
    assert.ok(!transcript.includes("exited with code"), transcript);
    // 截断时 output 保留重启前版本，避免只剩半截尾部。
    assert.equal(recovered?.output, "before restart");
    assert.equal(storage.getSession(session.id)?.status, "idle");
    assert.equal(storage.getSession(session.id)?.structuredState?.lastError ?? null, null);
    await waitFor(async () => (await client!.attachRun(structuredRunId(session.id))) === null);
  } finally {
    try { manager?.dispose(); } catch { /* best effort */ }
    try { client?.disconnect(); } catch { /* best effort */ }
    try { storage?.close(); } catch { /* best effort */ }
    await stopDaemonProcess(daemon);
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon-owned structured runs round-trip a Chinese+emoji JSON line split mid-character", async () => {
  const configPath = path.join(mkdtempSync(path.join(tmpdir(), "wand-structured-utf8-")), "config.json");
  const daemon = startDaemonProcess(configPath);
  try {
    const paths = terminalDaemonPaths(configPath);
    const waitForToken = async (): Promise<string> => {
      for (let i = 0; i < 100; i++) {
        try { return readFileSync(paths.tokenPath, "utf8").trim(); } catch { /* not yet */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("terminal daemon token never appeared");
    };
    const token = await waitForToken();
    const client = new TerminalDaemonClient(paths.socketPath, token);
    await client.connect();
    const jsonLine = '{"text":"你好🙂"}';
    const script = `
      const line = ${JSON.stringify(jsonLine)} + "\\n";
      const bytes = Buffer.from(line, "utf8");
      process.stdout.write(bytes.subarray(0, 16)); // mid 🙂
      setTimeout(() => {
        process.stdout.write(bytes.subarray(16));
        process.exit(0);
      }, 200);
    `;
    const handle = await client.spawnStructured({
      runId: structuredRunId("s-utf8-live"),
      file: NODE,
      args: ["-e", script],
      cwd: tmpdir(),
      env: {},
    });
    const collected = collect(handle);
    await Promise.race([collected.done, new Promise((resolve) => setTimeout(resolve, 5000))]);
    assert.ok(collected.stdout.includes(jsonLine), `live stdout=${JSON.stringify(collected.stdout)}`);
    assert.ok(!collected.stdout.includes("\uFFFD"));
    const attached = await client.attachRun(structuredRunId("s-utf8-live"));
    assert.ok(attached);
    assert.ok(attached!.stdoutLog.includes(jsonLine), `replay log=${JSON.stringify(attached!.stdoutLog)}`);
    assert.ok(!attached!.stdoutLog.includes("\uFFFD"));
    assert.equal(attached!.stdoutTruncated, false);
    client.forgetRun(structuredRunId("s-utf8-live"));
    client.disconnect();
  } finally {
    daemon.kill("SIGTERM");
  }
});

test("incomplete UTF-8 at process exit does not inject replacement characters into daemon logs", async () => {
  const configPath = path.join(mkdtempSync(path.join(tmpdir(), "wand-structured-trunc-")), "config.json");
  const daemon = startDaemonProcess(configPath);
  try {
    const paths = terminalDaemonPaths(configPath);
    const waitForToken = async (): Promise<string> => {
      for (let i = 0; i < 100; i++) {
        try { return readFileSync(paths.tokenPath, "utf8").trim(); } catch { /* not yet */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("terminal daemon token never appeared");
    };
    const token = await waitForToken();
    const client = new TerminalDaemonClient(paths.socketPath, token);
    await client.connect();
    const jsonLine = '{"text":"你好🙂"}';
    const script = `
      const bytes = Buffer.from(${JSON.stringify(jsonLine)}, "utf8");
      process.stdout.write(bytes.subarray(0, 10)); // mid 你, then exit
      process.exit(0);
    `;
    const handle = await client.spawnStructured({
      runId: structuredRunId("s-utf8-trunc"),
      file: NODE,
      args: ["-e", script],
      cwd: tmpdir(),
      env: {},
    });
    const collected = collect(handle);
    await Promise.race([collected.done, new Promise((resolve) => setTimeout(resolve, 5000))]);
    assert.equal(collected.exit?.exitCode, 0);
    assert.ok(!collected.stdout.includes("\uFFFD"), `live stdout=${JSON.stringify(collected.stdout)}`);
    const attached = await client.attachRun(structuredRunId("s-utf8-trunc"));
    assert.ok(attached);
    assert.equal(attached!.stdoutTruncated, false);
    assert.ok(!attached!.stdoutLog.includes("\uFFFD"), `replay log=${JSON.stringify(attached!.stdoutLog)}`);
    assert.equal(attached!.stdoutLog, '{"text":"');
    client.forgetRun(structuredRunId("s-utf8-trunc"));
    client.disconnect();
  } finally {
    daemon.kill("SIGTERM");
  }
});

test("daemon-owned structured spawn still delivers stdout and exit when the child finishes before subscribe", async () => {
  const configPath = path.join(mkdtempSync(path.join(tmpdir(), "wand-structured-fast-exit-")), "config.json");
  const daemon = startDaemonProcess(configPath);
  try {
    const paths = terminalDaemonPaths(configPath);
    const waitForToken = async (): Promise<string> => {
      for (let i = 0; i < 100; i++) {
        try { return readFileSync(paths.tokenPath, "utf8").trim(); } catch { /* not yet */ }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("terminal daemon token never appeared");
    };
    const token = await waitForToken();
    const client = new TerminalDaemonClient(paths.socketPath, token);
    await client.connect();
    const handle = await client.spawnStructured({
      runId: structuredRunId("s-fast-exit"),
      file: NODE,
      args: ["-e", "process.stdout.write('{\"n\":1}\\n'); process.stderr.write('diag\\n'); process.exit(7);"],
      cwd: tmpdir(),
      env: {},
    });
    const collected = collect(handle);
    await Promise.race([collected.done, new Promise((resolve) => setTimeout(resolve, 5000))]);
    assert.ok(collected.stdout.includes('{"n":1}'), `stdout=${JSON.stringify(collected.stdout)}`);
    assert.ok(collected.stderr.includes("diag"), `stderr=${JSON.stringify(collected.stderr)}`);
    assert.equal(collected.exit?.exitCode, 7);
    client.forgetRun(structuredRunId("s-fast-exit"));
    client.disconnect();
  } finally {
    daemon.kill("SIGTERM");
  }
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timed out");
}

async function stopDaemonProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }),
  ]);
}

function startDaemonProcess(configPath: string): ChildProcess {
  const entry = path.resolve("src/cli.ts");
  const child = spawn(process.execPath, ["--import", "tsx", entry, "terminald", "-c", configPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderrText = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderrText += chunk.toString(); });
  child.stderrForDiagnostics = stderrText;
  return child;
}
