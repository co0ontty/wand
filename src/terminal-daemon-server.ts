import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import pty from "node-pty";

import { ensureNodePtyHelperExecutable } from "./ensure-node-pty-helper.js";
import {
  TERMINAL_DAEMON_PROTOCOL_VERSION,
  terminalDaemonPaths,
  type TerminalDaemonAttachPayload,
  type TerminalDaemonCreateParams,
  type TerminalDaemonEvent,
  type TerminalDaemonRequest,
  type TerminalDaemonResponse,
} from "./terminal-daemon-protocol.js";
import {
  appendTerminalChunkWindow,
  type TerminalDataEvent,
  type TerminalSessionState,
} from "./terminal-host.js";
import { PtyTerminalState } from "./pty-terminal-state.js";
import { PtyCliExitMarker } from "./pty-shell-launch.js";
import { appendWindow, PTY_OUTPUT_MAX_SIZE } from "./pty-text-utils.js";

interface DaemonSession {
  sessionId: string;
  incarnationId: string;
  process: import("node-pty").IPty | null;
  pid: number;
  status: "running" | "exited";
  exitCode: number | null;
  cols: number;
  rows: number;
  seq: number;
  output: string;
  chunks: TerminalDataEvent[];
  terminalState: PtyTerminalState;
  launchMarkerToken: string | null;
  displayMarker: PtyCliExitMarker | null;
}

interface DaemonClient {
  socket: net.Socket;
  authenticated: boolean;
  buffer: string;
}

const MAX_REQUEST_BUFFER = 4 * 1024 * 1024;

export async function runTerminalDaemon(configPath: string): Promise<void> {
  const paths = terminalDaemonPaths(configPath);
  mkdirSync(path.dirname(paths.tokenPath), { recursive: true, mode: 0o700 });

  const previousPid = readTerminalDaemonPid(configPath);
  if (previousPid && previousPid !== process.pid && isProcessAlive(previousPid)) {
    // A service install/update must never evict the daemon that owns live PTYs.
    // Stay as the service-manager-owned successor and take over only after the
    // previous standalone/versioned daemon naturally exits (for example reboot).
    await waitForProcessExit(previousPid);
  }

  if (process.platform !== "win32" && existsSync(paths.socketPath)) {
    if (await socketAcceptsConnections(paths.socketPath)) {
      // Covers the narrow startup window before the winning daemon publishes
      // its pid. Never unlink a socket that another live daemon already bound.
      await waitForSocketRelease(paths.socketPath);
    }
    try { unlinkSync(paths.socketPath); } catch { /* listen will report the real error */ }
  }

  const token = randomBytes(32).toString("hex");

  const sessions = new Map<string, DaemonSession>();
  const clients = new Set<DaemonClient>();

  const send = (socket: net.Socket, message: TerminalDaemonResponse | TerminalDaemonEvent): void => {
    if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`);
  };

  const broadcast = (event: TerminalDaemonEvent): void => {
    for (const client of clients) {
      if (client.authenticated) send(client.socket, event);
    }
  };

  const serialize = (session: DaemonSession): TerminalSessionState => ({
    sessionId: session.sessionId,
    incarnationId: session.incarnationId,
    pid: session.pid,
    status: session.status,
    exitCode: session.exitCode,
    cols: session.cols,
    rows: session.rows,
    seq: session.seq,
    output: session.output,
    chunks: session.chunks.map((chunk) => ({ ...chunk })),
    terminalSnapshot: session.terminalState.snapshot(),
    launchMarkerToken: session.launchMarkerToken,
  });

  const createOrAttach = (params: TerminalDaemonCreateParams): TerminalDaemonAttachPayload => {
    const existing = sessions.get(params.sessionId);
    if (existing) return { state: serialize(existing), isNew: false };

    ensureNodePtyHelperExecutable();
    const child = pty.spawn(params.file, params.args, {
      cwd: params.cwd,
      env: params.env,
      name: params.name,
      cols: params.cols,
      rows: params.rows,
    });
    const session: DaemonSession = {
      sessionId: params.sessionId,
      incarnationId: randomUUID(),
      process: child,
      pid: child.pid,
      status: "running",
      exitCode: null,
      cols: params.cols,
      rows: params.rows,
      seq: 0,
      output: "",
      chunks: [],
      terminalState: new PtyTerminalState(params.cols, params.rows),
      launchMarkerToken: params.launchMarkerToken ?? null,
      displayMarker: params.launchMarkerToken ? new PtyCliExitMarker(params.launchMarkerToken) : null,
    };
    sessions.set(params.sessionId, session);

    child.onData((data) => {
      if (sessions.get(session.sessionId) !== session || session.process !== child) return;
      const event = { data, seq: ++session.seq };
      const visibleData = session.displayMarker?.consume(data).data ?? data;
      session.output = appendWindow(session.output, visibleData, PTY_OUTPUT_MAX_SIZE);
      session.chunks = appendTerminalChunkWindow(session.chunks, event);
      if (visibleData) session.terminalState.write(visibleData);
      broadcast({
        kind: "event",
        event: "data",
        sessionId: session.sessionId,
        incarnationId: session.incarnationId,
        data,
        seq: event.seq,
      });
    });

    child.onExit(({ exitCode, signal }) => {
      if (sessions.get(session.sessionId) !== session || session.process !== child) return;
      session.process = null;
      session.status = "exited";
      session.exitCode = exitCode;
      broadcast({
        kind: "event",
        event: "exit",
        sessionId: session.sessionId,
        incarnationId: session.incarnationId,
        exitCode,
        signal,
      });
    });

    return { state: serialize(session), isNew: true };
  };

  const forget = (sessionId: string): void => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    const child = session.process;
    session.process = null;
    if (child) {
      try { child.kill(); } catch { /* best-effort explicit deletion */ }
    }
    session.terminalState.dispose();
  };

  const handleRequest = (client: DaemonClient, request: TerminalDaemonRequest): void => {
    if (request.token !== token) {
      send(client.socket, { kind: "response", id: request.id, ok: false, error: "Unauthorized" });
      client.socket.destroy();
      return;
    }
    if (request.protocolVersion !== TERMINAL_DAEMON_PROTOCOL_VERSION) {
      send(client.socket, {
        kind: "response",
        id: request.id,
        ok: false,
        error: `Unsupported terminal daemon protocol ${request.protocolVersion}`,
      });
      return;
    }
    client.authenticated = true;

    try {
      let result: unknown;
      const params = request.params ?? {};
      switch (request.method) {
        case "hello":
          result = { protocolVersion: TERMINAL_DAEMON_PROTOCOL_VERSION, pid: process.pid };
          break;
        case "list":
          result = Array.from(sessions.values(), serialize);
          break;
        case "createOrAttach":
          result = createOrAttach(params as unknown as TerminalDaemonCreateParams);
          break;
        case "write": {
          const session = sessions.get(String(params.sessionId ?? ""));
          if (!session?.process || session.status !== "running") throw new Error("Terminal is not running");
          session.process.write(String(params.data ?? ""));
          result = { ok: true };
          break;
        }
        case "resize": {
          const session = sessions.get(String(params.sessionId ?? ""));
          if (!session?.process || session.status !== "running") throw new Error("Terminal is not running");
          const cols = Number(params.cols);
          const rows = Number(params.rows);
          if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)) throw new Error("Invalid terminal size");
          session.process.resize(cols, rows);
          session.terminalState.resize(cols, rows);
          session.cols = cols;
          session.rows = rows;
          result = { ok: true };
          break;
        }
        case "kill": {
          const session = sessions.get(String(params.sessionId ?? ""));
          if (session?.process) session.process.kill(typeof params.signal === "string" ? params.signal : undefined);
          result = { ok: true };
          break;
        }
        case "forget":
          forget(String(params.sessionId ?? ""));
          result = { ok: true };
          break;
      }
      send(client.socket, { kind: "response", id: request.id, ok: true, result });
    } catch (error) {
      send(client.socket, {
        kind: "response",
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const server = net.createServer((socket) => {
    const client: DaemonClient = { socket, authenticated: false, buffer: "" };
    clients.add(client);
    socket.setNoDelay(true);
    socket.on("data", (data) => {
      client.buffer += data.toString("utf8");
      if (client.buffer.length > MAX_REQUEST_BUFFER) {
        socket.destroy();
        return;
      }
      while (true) {
        const newline = client.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = client.buffer.slice(0, newline);
        client.buffer = client.buffer.slice(newline + 1);
        if (!line) continue;
        try {
          handleRequest(client, JSON.parse(line) as TerminalDaemonRequest);
        } catch {
          socket.destroy();
          return;
        }
      }
    });
    socket.on("close", () => clients.delete(client));
    socket.on("error", () => clients.delete(client));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socketPath, () => {
      server.off("error", reject);
      if (process.platform !== "win32") chmodSync(paths.socketPath, 0o600);
      // Publish credentials only after this process has atomically won the
      // socket bind. Concurrent starters can no longer overwrite the live
      // daemon's token/pid before discovering EADDRINUSE.
      writeFileSync(paths.tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
      writeFileSync(paths.pidPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
      resolve();
    });
  });

  const shutdown = (): void => {
    for (const sessionId of Array.from(sessions.keys())) forget(sessionId);
    for (const client of clients) client.socket.destroy();
    server.close(() => process.exit(0));
    cleanupDaemonFiles(paths.socketPath, paths.tokenPath, paths.pidPath);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function cleanupDaemonFiles(socketPath: string, tokenPath: string, pidPath: string): void {
  for (const file of [socketPath, tokenPath, pidPath]) {
    if (process.platform === "win32" && file === socketPath) continue;
    try { unlinkSync(file); } catch { /* already absent */ }
  }
}

export function readTerminalDaemonPid(configPath: string): number | null {
  try {
    const value = Number(readFileSync(terminalDaemonPaths(configPath).pidPath, "utf8").trim());
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForProcessExit(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (isProcessAlive(pid)) return;
      clearInterval(timer);
      process.off("SIGINT", stopWaiting);
      process.off("SIGTERM", stopWaiting);
      resolve();
    }, 500);
    const stopWaiting = () => {
      clearInterval(timer);
      process.exit(0);
    };
    process.once("SIGINT", stopWaiting);
    process.once("SIGTERM", stopWaiting);
  });
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    const timer = setTimeout(() => finish(false), 300);
    timer.unref?.();
  });
}

async function waitForSocketRelease(socketPath: string): Promise<void> {
  let stopped = false;
  const stopWaiting = () => {
    stopped = true;
  };
  process.once("SIGINT", stopWaiting);
  process.once("SIGTERM", stopWaiting);
  while (!stopped && await socketAcceptsConnections(socketPath)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  process.off("SIGINT", stopWaiting);
  process.off("SIGTERM", stopWaiting);
  if (stopped) process.exit(0);
}
