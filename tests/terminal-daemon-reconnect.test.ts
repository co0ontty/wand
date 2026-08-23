import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TERMINAL_DAEMON_PROTOCOL_VERSION } from "../src/terminal-daemon-protocol.js";
import { TerminalDaemonClient } from "../src/terminal-daemon-client.js";
import type { TerminalDataEvent, TerminalSessionState, TerminalSpawnRequest } from "../src/terminal-host.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(probe: () => T | null, message: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== null) return value;
    await delay(25);
  }
  throw new Error(message);
}

function makeState(
  sessionId: string,
  incarnationId: string,
  overrides: Partial<TerminalSessionState> = {},
): TerminalSessionState {
  return {
    sessionId,
    incarnationId,
    pid: 4242,
    status: "running",
    exitCode: null,
    cols: 80,
    rows: 24,
    seq: 0,
    output: "",
    chunks: [],
    terminalSnapshot: null,
    launchMarkerToken: null,
    ...overrides,
  };
}

function makeSpawnRequest(sessionId: string): TerminalSpawnRequest {
  return {
    sessionId,
    file: "/bin/sh",
    args: [],
    cwd: os.tmpdir(),
    env: {},
    name: "xterm-256color",
    cols: 80,
    rows: 24,
  };
}

/** Minimal in-process stand-in for the terminal daemon over a unix socket. */
class FakeDaemon {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private bufferBySocket = new WeakMap<net.Socket, string>();
  sessions: TerminalSessionState[] = [];
  runs: unknown[] = [];

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.sockets.add(socket);
        this.bufferBySocket.set(socket, "");
        socket.setNoDelay(true);
        socket.on("data", (data) => this.consume(socket, data.toString("utf8")));
        socket.on("close", () => this.sockets.delete(socket));
        socket.on("error", () => this.sockets.delete(socket));
      });
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        this.server = server;
        resolve();
      });
    });
  }

  /** Simulate daemon death: tear down all connections and the listener. */
  async kill(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try { unlinkSync(this.socketPath); } catch { /* already absent */ }
  }

  private consume(socket: net.Socket, chunk: string): void {
    let buffer = (this.bufferBySocket.get(socket) ?? "") + chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      this.bufferBySocket.set(socket, buffer);
      let request: { id?: number; token?: string; method?: string };
      try { request = JSON.parse(line); } catch { continue; }
      this.dispatch(socket, request);
    }
    this.bufferBySocket.set(socket, buffer);
  }

  private dispatch(socket: net.Socket, request: { id?: number; token?: string; method?: string }): void {
    if (request.token !== this.token) {
      socket.write(`${JSON.stringify({ kind: "response", id: request.id, ok: false, error: "Unauthorized" })}\n`);
      socket.destroy();
      return;
    }
    let result: unknown;
    switch (request.method) {
      case "hello":
        result = { protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION, pid: process.pid };
        break;
      case "list":
        result = this.sessions;
        break;
      case "structuredList":
        result = this.runs;
        break;
      case "createOrAttach": {
        const sessionId = String((request as { params?: { sessionId?: string } }).params?.sessionId ?? "");
        const existing = this.sessions.find((session) => session.sessionId === sessionId);
        result = existing
          ? { state: existing, isNew: false }
          : { state: makeState(sessionId, `inc-${sessionId}`), isNew: true };
        break;
      }
      default:
        result = { ok: true };
    }
    socket.write(`${JSON.stringify({ kind: "response", id: request.id, ok: true, result })}\n`);
  }
}

async function withHarness(
  t: test.TestContext,
  run: (harness: { daemon: FakeDaemon; client: TerminalDaemonClient; socketPath: string }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-daemon-reconnect-"));
  const socketPath = path.join(root, "terminald.sock");
  const daemon = new FakeDaemon(socketPath, "test-token");
  let client: TerminalDaemonClient | null = null;
  t.after(async () => {
    client?.disconnect();
    await daemon.kill();
    rmSync(root, { recursive: true, force: true });
  });
  await run({ daemon, client: (client = new TerminalDaemonClient(socketPath, "test-token")), socketPath });
}

test("reconnect delivers exit when the PTY exited while disconnected", async (t) => {
  await withHarness(t, async ({ daemon, client }) => {
    daemon.sessions = [makeState("sess-1", "inc-1")];
    await daemon.start();
    await client.connect();
    const attached = await client.createOrAttach(makeSpawnRequest("sess-1"));
    assert.ok(attached.process);
    const exits: number[] = [];
    attached.process.onExit(({ exitCode }) => exits.push(exitCode));

    await daemon.kill();
    daemon.sessions = [makeState("sess-1", "inc-1", { status: "exited", exitCode: 0 })];
    await daemon.start();

    await waitFor(() => (exits.length > 0 ? exits : null), "exit was not delivered after reconnect");
    assert.equal(exits[0], 0);
  });
});

test("reconnect delivers exit code -1 when the session vanished (daemon restart)", async (t) => {
  await withHarness(t, async ({ daemon, client }) => {
    daemon.sessions = [makeState("sess-gone", "inc-gone")];
    await daemon.start();
    await client.connect();
    const attached = await client.createOrAttach(makeSpawnRequest("sess-gone"));
    assert.ok(attached.process);
    const exits: number[] = [];
    attached.process.onExit(({ exitCode }) => exits.push(exitCode));

    await daemon.kill();
    daemon.sessions = [];
    await daemon.start();

    await waitFor(() => (exits.length > 0 ? exits : null), "exit was not delivered for vanished session");
    assert.equal(exits[0], -1);
  });
});

test("reconnect replays chunks missed while disconnected for live sessions", async (t) => {
  await withHarness(t, async ({ daemon, client }) => {
    daemon.sessions = [makeState("sess-live", "inc-live")];
    await daemon.start();
    await client.connect();
    const attached = await client.createOrAttach(makeSpawnRequest("sess-live"));
    assert.ok(attached.process);
    const data: TerminalDataEvent[] = [];
    const exits: number[] = [];
    attached.process.onData((event) => data.push(event));
    attached.process.onExit(({ exitCode }) => exits.push(exitCode));

    const missedChunks: TerminalDataEvent[] = [
      { data: "missed-a", seq: 1 },
      { data: "missed-b", seq: 2 },
    ];
    await daemon.kill();
    daemon.sessions = [makeState("sess-live", "inc-live", { seq: 2, chunks: missedChunks, output: "missed-amissed-b" })];
    await daemon.start();

    await waitFor(
      () => (data.some((event) => event.data.includes("missed-b")) ? data : null),
      "missed chunks were not replayed after reconnect",
    );
    assert.deepEqual(data.map((event) => event.data), ["missed-a", "missed-b"]);
    assert.equal(exits.length, 0);
  });
});

test("disconnect() stops the reconnect loop", async (t) => {
  await withHarness(t, async ({ daemon, client, socketPath }) => {
    daemon.sessions = [makeState("sess-stop", "inc-stop")];
    await daemon.start();
    await client.connect();
    await client.createOrAttach(makeSpawnRequest("sess-stop"));

    await daemon.kill();
    client.disconnect();
    await delay(700);
    await daemon.start();
    await delay(1_200);
    // No crash, no zombie reconnect: the client stays disconnected and the
    // process has no pending reconnect timer keeping it alive.
    const probe = new TerminalDaemonClient(socketPath, "test-token");
    await probe.connect();
    probe.disconnect();
  });
});
