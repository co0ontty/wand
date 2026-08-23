import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

import {
  InProcessStructuredExecHost,
  structuredRunId,
  type StructuredExitEvent,
  type StructuredStreamEvent,
} from "../src/structured-exec-host.js";
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timed out");
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
