import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

import { PtyTerminalState } from "../src/pty-terminal-state.js";
import { TerminalDaemonClient } from "../src/terminal-daemon-client.js";
import { terminalDaemonPaths } from "../src/terminal-daemon-protocol.js";
import type { TerminalAttachResult, TerminalSpawnRequest } from "../src/terminal-host.js";

const NODE = process.execPath;
const COLS = 100;
const ROWS = 30;

/**
 * The daemon keeps a server-side xterm screen so a reconnecting client can be
 * handed a snapshot instead of a full replay. The mirror coalesces incoming
 * chunks and re-baselines on a quiet-period checkpoint, so these tests pin the
 * guarantee that a snapshot always reproduces the same screen as replaying the
 * raw bytes in order.
 */

function makeSpawnRequest(sessionId: string, script: string): TerminalSpawnRequest {
  return {
    sessionId,
    file: NODE,
    args: ["-e", script],
    cwd: tmpdir(),
    env: { ...process.env },
    name: "xterm-256color",
    cols: COLS,
    rows: ROWS,
  };
}

function startDaemonProcess(configPath: string): ChildProcess {
  const entry = path.resolve("src/cli.ts");
  const child = spawn(process.execPath, ["--import", "tsx", entry, "terminald", "-c", configPath], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", () => { /* keep the pipe drained */ });
  return child;
}

async function waitForToken(configPath: string): Promise<string> {
  const paths = terminalDaemonPaths(configPath);
  for (let i = 0; i < 200; i++) {
    try {
      return readFileSync(paths.tokenPath, "utf8").trim();
    } catch { /* not published yet */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("terminal daemon token never appeared");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Race a promise against a deadline without leaking the timer into the run loop. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function attachWithFreshClient(
  socketPath: string,
  token: string,
  request: TerminalSpawnRequest,
): Promise<{ client: TerminalDaemonClient; attached: TerminalAttachResult }> {
  // A fresh connection has an empty inventory, which is exactly how a web
  // restart re-attaches and pulls a snapshot back out of the daemon.
  const client = new TerminalDaemonClient(socketPath, token);
  await client.connect();
  const attached = await client.createOrAttach(request);
  return { client, attached };
}

/** Replay a snapshot into a fresh mirror the way a reconnecting client does. */
function rebuild(snapshot: NonNullable<TerminalAttachResult["state"]["terminalSnapshot"]>): PtyTerminalState {
  const state = new PtyTerminalState(snapshot.cols, snapshot.rows, snapshot.data);
  for (const operation of snapshot.pending) {
    if (operation.type === "data") state.write(operation.data);
    else state.resize(operation.cols, operation.rows);
  }
  return state;
}

async function collectUntilExit(attached: TerminalAttachResult): Promise<string> {
  const chunks: string[] = [];
  const exited = new Promise<void>((resolve) => {
    attached.process?.onExit(() => resolve());
  });
  attached.process?.onData((event) => chunks.push(event.data));
  await withTimeout(exited, 20_000, "the child never exited");
  return chunks.join("");
}

test("a daemon snapshot reproduces the same screen as an ordered raw replay", async (t) => {
  const configPath = path.join(mkdtempSync(path.join(tmpdir(), "wand-mirror-")), "config.json");
  const daemon = startDaemonProcess(configPath);
  let client: TerminalDaemonClient | null = null;
  t.after(() => {
    client?.disconnect();
    daemon.kill("SIGTERM");
  });

  const token = await waitForToken(configPath);
  const paths = terminalDaemonPaths(configPath);
  const request = makeSpawnRequest("sess-mirror", `
    let out = "";
    for (let i = 0; i < 4000; i++) {
      out += "\\u001b[3" + (i % 8) + "mline " + i + " 中文🙂\\u001b[0m";
      out += i % 7 === 0 ? "\\u001b[1A\\u001b[2K\\rredrawn " + i : "";
      out += "\\r\\n";
    }
    process.stdout.write(out);
    process.stdout.write("MIRROR-DONE\\r\\n");
  `);

  client = new TerminalDaemonClient(paths.socketPath, token);
  await client.connect();
  const attached = await client.createOrAttach(request);
  const raw = await collectUntilExit(attached);
  assert.ok(raw.includes("MIRROR-DONE"), "the child should finish its burst");
  await delay(400); // let the quiet-period checkpoint commit the mirror

  const { client: second, attached: reattached } = await attachWithFreshClient(paths.socketPath, token, request);
  t.after(() => second.disconnect());
  const snapshot = reattached.state.terminalSnapshot;
  assert.ok(snapshot, "the daemon should own a terminal snapshot");
  assert.equal(snapshot.pending.length, 0, "a quiesced session must expose a committed baseline");

  const replayed = new PtyTerminalState(COLS, ROWS);
  replayed.write(raw);
  await delay(300);
  assert.equal(snapshot.data, replayed.snapshot().data);
  assert.equal(snapshot.cols, COLS);
  assert.equal(snapshot.rows, ROWS);
  replayed.dispose();
});

test("a session that never pauses still carries a bounded, replayable snapshot", async (t) => {
  const configPath = path.join(mkdtempSync(path.join(tmpdir(), "wand-mirror-paced-")), "config.json");
  const daemon = startDaemonProcess(configPath);
  let client: TerminalDaemonClient | null = null;
  t.after(() => {
    client?.disconnect();
    daemon.kill("SIGTERM");
  });

  const token = await waitForToken(configPath);
  const paths = terminalDaemonPaths(configPath);
  // 8 bytes every 20ms: shorter than the flush batch delay and far shorter than
  // the checkpoint quiet window, so output never pauses on its own.
  const request = makeSpawnRequest("sess-paced", `
    let i = 0;
    const timer = setInterval(() => {
      if (++i > 60) {
        clearInterval(timer);
        process.stdout.write("PACED-DONE\\r\\n");
        process.exit(0);
      }
      process.stdout.write("tick " + i + "\\r\\n");
    }, 20);
  `);

  client = new TerminalDaemonClient(paths.socketPath, token);
  await client.connect();
  const attached = await client.createOrAttach(request);
  const chunks: string[] = [];
  attached.process?.onData((event) => chunks.push(event.data));
  await delay(600);

  const mid = await attachWithFreshClient(paths.socketPath, token, request);
  t.after(() => mid.client.disconnect());
  const midSnapshot = mid.attached.state.terminalSnapshot;
  assert.ok(midSnapshot, "the daemon should own a terminal snapshot");
  assert.ok(midSnapshot.pending.length > 0, "in-flight bytes must stay replayable");
  const pendingChars = midSnapshot.pending.reduce(
    (total, operation) => total + (operation.type === "data" ? operation.data.length : 0),
    0,
  );
  assert.ok(pendingChars <= 320 * 1024, `pending replay stayed bounded: ${pendingChars} chars`);
  const restored = rebuild(midSnapshot);
  restored.dispose();

  await withTimeout(new Promise<void>((resolve) => {
    attached.process?.onExit(() => resolve());
  }), 20_000, "the paced child never exited");
  await delay(400);

  const settled = await attachWithFreshClient(paths.socketPath, token, request);
  t.after(() => settled.client.disconnect());
  const settledSnapshot = settled.attached.state.terminalSnapshot;
  assert.ok(settledSnapshot);
  assert.equal(settledSnapshot.pending.length, 0, "a finished writer must converge to a committed baseline");
  const replayed = new PtyTerminalState(COLS, ROWS);
  replayed.write(chunks.join(""));
  await delay(300);
  assert.equal(settledSnapshot.data, replayed.snapshot().data);
  replayed.dispose();
});
