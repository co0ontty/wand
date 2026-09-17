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
} from "../src/structured-runner.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
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
