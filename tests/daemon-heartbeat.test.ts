import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { startDaemonHeartbeat } from "../src/daemon-connection.js";
import { RenderDaemonClient } from "../src/render-daemon-client.js";
import { RenderStructuredClient } from "../src/render-structured-client.js";
import { decodeRenderFrames, encodeRenderFrame } from "../src/render-protocol.js";
import { structuredRenderPaths } from "../src/render-structured-protocol.js";
import { TerminalDaemonClient } from "../src/terminal-daemon-client.js";

async function until(probe: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (probe()) return; await delay(5); }
  assert.ok(probe(), "condition did not become true");
}

test("heartbeat bounds a silent peer, avoids overlapping probes, and stops on disposal", async () => {
  const socket = new net.Socket();
  socket.on("error", () => {});
  let probes = 0;
  const stop = startDaemonHeartbeat(socket, () => {
    probes++;
    return new Promise(() => {});
  }, { intervalMs: 5, timeoutMs: 30 });
  await until(() => socket.destroyed);
  assert.equal(probes, 1);
  stop();
  await delay(20);
  assert.equal(probes, 1);
});

for (const kind of ["legacy", "render", "structured"] as const) {
  test(`${kind}: silent connection reconnects, rotated credentials reload, late old errors are ignored`, async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wand-heartbeat-"));
    const config = path.join(root, "config.json");
    const paths = kind === "structured" ? structuredRenderPaths(config)
      : { socketPath: path.join(root, "daemon.sock"), tokenPath: path.join(root, "token") };
    let token = "old-upgrade-token";
    writeFileSync(paths.tokenPath, token);
    const sockets = new Set<net.Socket>();
    let silent = false;
    let connections = 0;
    let hellos = 0;
    const methods: string[] = [];
    const server = net.createServer((socket) => {
      connections++;
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      let buffer: Buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const frames: Array<{ id: number; method: string; token: string }> = [];
        if (kind === "legacy") {
          for (let newline; (newline = buffer.indexOf(10)) >= 0;) {
            frames.push(JSON.parse(buffer.subarray(0, newline).toString()));
            buffer = buffer.subarray(newline + 1);
          }
        } else {
          const decoded = decodeRenderFrames<{ id: number; method: string; token: string }>(buffer);
          frames.push(...decoded.frames); buffer = decoded.rest;
        }
        for (const req of frames) {
          methods.push(req.method);
          if (silent) continue;
          if (req.token !== token) { socket.destroy(); continue; }
          if (req.method === "hello") hellos++;
          let result: unknown = { pong: true };
          if (req.method === "hello") result = { protocolVersion: kind === "render" ? 1 : 2,
            version: "0.1.0", pid: process.pid, startedAt: new Date().toISOString() };
          if (req.method === "list") result = kind === "legacy" ? []
            : kind === "render" ? { sessions: [] } : { runs: [] };
          // Pre-structured terminald versions returned a generic result for
          // unknown methods. Heartbeat must keep using their existing hello.
          if (req.method === "structuredList") result = { ok: true };
          const response = { kind: "response", id: req.id, ok: true, result };
          socket.write(kind === "legacy" ? JSON.stringify(response) + "\n" : encodeRenderFrame(response));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(paths.socketPath, resolve));
    chmodSync(paths.socketPath, 0o600);
    const oldTime = new Date(1_000);
    utimesSync(paths.socketPath, oldTime, oldTime);
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const client = kind === "legacy" ? new TerminalDaemonClient(paths.socketPath, token, paths.tokenPath)
      : kind === "render" ? new RenderDaemonClient(paths.socketPath, token, paths.tokenPath)
        : new RenderStructuredClient(config);
    t.after(async () => {
      client.disconnect();
      t.mock.timers.reset();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
      if (kind === "structured") rmSync(paths.socketPath, { force: true });
    });
    await Promise.all([client.connect(), client.connect()]);
    assert.equal(connections, 1, "concurrent adoption must share one handshake");
    const oldSocket = (client as unknown as { socket: net.Socket }).socket;
    const initialMethods = methods.length;
    t.mock.timers.tick(15_000);
    await until(() => methods.length > initialMethods);
    await until(() => statSync(paths.socketPath).mtimeMs > oldTime.getTime());
    assert.equal(methods.at(-1), kind === "legacy" ? "hello" : "ping");
    silent = true;
    t.mock.timers.tick(15_000);
    await delay(10);
    t.mock.timers.tick(5_000);
    await until(() => oldSocket.destroyed);
    await delay(10);
    silent = false;
    token = "rotated-upgrade-token";
    writeFileSync(paths.tokenPath, token);
    const priorHellos = hellos;
    t.mock.timers.tick(500);
    await until(() => hellos > priorHellos);
    await client.connect();
    const newSocket = (client as unknown as { socket: net.Socket }).socket;
    assert.notEqual(newSocket, oldSocket);
    oldSocket.emit("error", new Error("late error from old generation"));
    oldSocket.emit("close");
    assert.equal((client as unknown as { socket: net.Socket }).socket, newSocket);
    assert.equal(newSocket.destroyed, false);
    client.disconnect();
    t.mock.timers.tick(60_000);
    await delay(10);
    assert.equal(connections, 2, "disposed clients must not reconnect");
    assert.ok(methods.every((method) => ["hello", "ping", "list", "structuredList"].includes(method)),
      "recovery must not resend input or create new processes");
  });
}
