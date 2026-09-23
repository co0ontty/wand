import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { RenderStructuredClient } from "../src/render-structured-client.js";
import { structuredRenderPaths } from "../src/render-structured-protocol.js";
import { terminalDaemonPaths } from "../src/terminal-daemon-protocol.js";

const RUST_BIN = process.env.WAND_STRUCTURED_RENDER_BIN
  || path.resolve("render/target/debug/wand-structured-renderd");
const CLI = path.resolve("dist/cli.js");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitFor(predicate: () => Promise<boolean>, maxMs = 8000): Promise<void> {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    try { if (await predicate()) return; } catch { /* not ready yet */ }
    await delay(35);
  }
  throw new Error("isolated Web/structured daemon did not reach the expected state");
}

async function stop(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(3000).then(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }),
  ]);
}

function killOwnedDaemon(pidFile: string): void {
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, "SIGTERM");
  } catch { /* the isolated daemon may already have stopped */ }
}

test("S1 isolated Web restart recovers a v2-owned CLI without changing PID or DTO", {
  skip: existsSync(RUST_BIN) && existsSync(CLI) ? false : "build Rust v2 and npm dist first",
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-structured-server-e2e-"));
  const configPath = path.join(root, "config.json");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(16).toString("hex");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const fakeCli = path.join(bin, "pi");
  writeFileSync(fakeCli, `#!/usr/bin/env node
const line = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
line({type:"session",id:"fixture-session"});
setTimeout(() => line({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"before "}}), 100);
const fs = require("node:fs");
const check = setInterval(() => {
  if (!fs.existsSync("resume.marker")) return;
  clearInterval(check);
  line({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"after"}});
  line({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"before after"}],stopReason:"stop"}});
}, 25);
setTimeout(() => process.exit(2), 15000).unref();
`);
  chmodSync(fakeCli, 0o755);
  writeFileSync(configPath, JSON.stringify({ host: "127.0.0.1", port, password,
    defaultCwd: root, defaultMode: "assist", structuredRunner: "cli",
    render: { engine: "legacy" }, structured: { processHost: "rust" } }), { mode: 0o600 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    WAND_STRUCTURED_RENDER_BIN: RUST_BIN };
  delete env.NODE_TEST_CONTEXT;
  delete env.WAND_TEST_MODE;
  let web: ChildProcess | null = null;
  let v2: RenderStructuredClient | null = null;
  t.after(async () => {
    v2?.disconnect();
    await stop(web);
    killOwnedDaemon(structuredRenderPaths(configPath).pidPath);
    killOwnedDaemon(terminalDaemonPaths(configPath).pidPath);
    await delay(100);
    rmSync(root, { recursive: true, force: true });
  });
  const startWeb = async (): Promise<void> => {
    web = spawn(process.execPath, [CLI, "web", "-c", configPath], { env, stdio: "ignore" });
    await waitFor(async () => {
      const res = await fetch(`${base}/api/health`);
      return res.status > 0;
    });
  };
  const login = async (): Promise<string> => {
    const response = await fetch(`${base}/api/login`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password, client: "browser-extension" }) });
    assert.equal(response.status, 200);
    const result = await response.json() as { appToken?: string };
    assert.ok(result.appToken);
    return result.appToken;
  };
  await startWeb();
  let token = await login();
  const created = await fetch(`${base}/api/structured-sessions`, { method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ cwd: root, provider: "pi", mode: "assist", prompt: "fixture",
      respondImmediately: true }) });
  assert.equal(created.status, 201);
  const snapshot = await created.json() as { id: string };
  assert.ok(snapshot.id);
  const session = async (): Promise<{ output: string; structuredState?: { inFlight: boolean } }> => {
    const result = await fetch(`${base}/api/sessions/${snapshot.id}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(result.status, 200);
    return result.json() as Promise<{ output: string; structuredState?: { inFlight: boolean } }>;
  };
  await waitFor(async () => (await session()).output.includes("before "));
  v2 = new RenderStructuredClient(configPath);
  await v2.connect();
  const initial = await v2.attachRun(`structured:${snapshot.id}`);
  assert.ok(initial?.pid && initial.pid > 0);
  const pid = initial.pid;
  await stop(web);
  web = null;
  await startWeb();
  token = await login();
  const recovered = await v2.attachRun(`structured:${snapshot.id}`);
  assert.equal(recovered?.pid, pid, "Web restart must not respawn the CLI");
  writeFileSync(path.join(root, "resume.marker"), "ok");
  await waitFor(async () => (await session()).structuredState?.inFlight === false, 12_000);
  const final = await session();
  assert.equal(final.output, "before after");
});
