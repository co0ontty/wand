import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { RenderStructuredClient } from "../src/render-structured-client.js";
import { structuredRenderPaths } from "../src/render-structured-protocol.js";
import {
  assertStructuredContractEquivalent,
  captureStructuredExecContract,
  EXPECTED_STRUCTURED_CONTRACT,
} from "./helpers/structured-exec-contract.js";

const RUST_BIN = process.env.WAND_STRUCTURED_RENDER_BIN
  || path.resolve("render/target/debug/wand-structured-renderd");

test("S1: Rust v2 matches legacy StructuredExecHost behavior across socket reconnect", {
  skip: existsSync(RUST_BIN) ? false : "Rust v2 debug binary not built; run cargo build -p wand-structured-renderd",
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-structured-v2-contract-"));
  const configPath = path.join(root, "config.json");
  writeFileSync(configPath, "{}", { mode: 0o600 });
  const paths = structuredRenderPaths(configPath);
  const daemon = spawn(RUST_BIN, ["--config", configPath], { stdio: ["ignore", "ignore", "pipe"] });
  let diagnostics = "";
  daemon.stderr?.on("data", (chunk: Buffer) => { diagnostics += chunk.toString("utf8"); });
  t.after(async () => {
    await stopDaemon(daemon);
    rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !existsSync(paths.tokenPath); i++) await delay(30);
  assert.ok(existsSync(paths.tokenPath), `Rust v2 failed to start: ${diagnostics}`);
  // Do not print or record the token. The client reads it from the private file.
  assert.ok(readFileSync(paths.tokenPath, "utf8").trim());
  const connect = async (): Promise<RenderStructuredClient> => {
    const client = new RenderStructuredClient(configPath);
    await client.connect();
    return client;
  };
  const actual = await captureStructuredExecContract(connect, root);
  assertStructuredContractEquivalent(EXPECTED_STRUCTURED_CONTRACT, actual);
});

test("S1: active v2 client replays the missing seq after a broken socket", {
  skip: existsSync(RUST_BIN) ? false : "Rust v2 debug binary not built",
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-v2-reconnect-"));
  const configPath = path.join(root, "config.json");
  writeFileSync(configPath, "{}", { mode: 0o600 });
  const paths = structuredRenderPaths(configPath);
  const daemon = spawn(RUST_BIN, ["--config", configPath], { stdio: "ignore" });
  t.after(async () => {
    await stopDaemon(daemon);
    rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !existsSync(paths.tokenPath); i++) await delay(30);
  assert.ok(existsSync(paths.tokenPath));
  const client = new RenderStructuredClient(configPath);
  t.after(() => client.disconnect());
  await client.connect();
  const script = "process.stdout.write('one\\n');setTimeout(()=>process.stdout.write('two\\n'),450);" +
    "setTimeout(()=>process.stdout.write('three\\n'),550)";
  const handle = await client.spawnStructured({ runId: "structured:reconnect-socket",
    file: process.execPath, args: ["-e", script], cwd: root, env: { PATH: process.env.PATH ?? "" } });
  let output = "";
  let exited = false;
  handle.onStream((event) => { if (event.stream === "stdout") output += event.data; });
  handle.onExit(() => { exited = true; });
  for (let i = 0; i < 100 && !output.includes("one\n"); i++) await delay(20);
  assert.equal(output, "one\n");
  const socket = (client as unknown as { socket: net.Socket | null }).socket;
  assert.ok(socket);
  socket.destroy();
  for (let i = 0; i < 250 && !exited; i++) await delay(20);
  assert.ok(exited, "reconnected client must observe exit");
  assert.equal(output, "one\ntwo\nthree\n", "reconnect must not omit or duplicate any chunk");
  const full = await client.attachRun(handle.runId);
  assert.equal(full?.stdoutLog, output);
});

test("S1: >8 MiB stdout keeps a bounded paged replay without false success from a missing head", {
  skip: existsSync(RUST_BIN) ? false : "Rust v2 debug binary not built",
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-v2-large-log-"));
  const configPath = path.join(root, "config.json");
  writeFileSync(configPath, "{}", { mode: 0o600 });
  const paths = structuredRenderPaths(configPath);
  const daemon = spawn(RUST_BIN, ["--config", configPath], { stdio: "ignore" });
  t.after(async () => {
    await stopDaemon(daemon);
    rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 100 && !existsSync(paths.tokenPath); i++) await delay(30);
  assert.ok(existsSync(paths.tokenPath));
  const client = new RenderStructuredClient(configPath);
  t.after(() => client.disconnect());
  await client.connect();
  const expectedLength = 8 * 1024 * 1024 + 16_384;
  const handle = await client.spawnStructured({ runId: "structured:large-log",
    file: process.execPath, args: ["-e", `process.stdout.write('x'.repeat(${expectedLength}))`],
    cwd: root, env: { PATH: process.env.PATH ?? "" } });
  let total = 0;
  let exited = false;
  handle.onStream((event) => { if (event.stream === "stdout") total += event.data.length; });
  handle.onExit(() => { exited = true; });
  for (let i = 0; i < 250 && !exited; i++) await delay(20);
  assert.ok(exited, "large run did not exit");
  assert.equal(total, expectedLength, "live stream must not lose the head after truncation");
  const full = await client.attachRun(handle.runId);
  assert.equal(full?.stdoutTruncated, true);
  assert.ok((full?.stdoutLog.length ?? 0) <= 8 * 1024 * 1024);
  assert.ok((full?.stdoutLog.length ?? 0) > 7 * 1024 * 1024);
  const list = await client.listRuns();
  assert.equal(list[0]?.stdoutLog, "", "inventory stays metadata-only");
});

async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(2_000).then(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }),
  ]);
}
