import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { RenderDaemonClient } from "../src/render-daemon-client.js";
import { renderPaths } from "../src/render-protocol.js";
import { RenderStructuredClient } from "../src/render-structured-client.js";
import { structuredRenderPaths } from "../src/render-structured-protocol.js";

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 1_000);
  await exited;
  clearTimeout(force);
}

for (const structured of [false, true]) {
  const name = structured ? "wand-structured-renderd" : "wand-render";
  const binary = path.resolve("render/target/debug", name);
  test(`${name}: endpoint recreation preserves daemon, token and process across upgrade adoption`, {
    skip: !existsSync(binary), timeout: 15_000,
  }, async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wand-render-socket-"));
    const config = path.join(root, "config.json");
    writeFileSync(config, "{}");
    const paths = structured ? structuredRenderPaths(config) : renderPaths(config);
    const args = [structured ? "--config" : "-c", config];
    const daemon = spawn(binary, args, { stdio: "ignore" });
    let disposeClient = async (): Promise<void> => {};
    t.after(async () => {
      await disposeClient();
      await stop(daemon);
      rmSync(root, { recursive: true, force: true });
    });
    for (let i = 0; i < 250 && (!existsSync(paths.tokenPath) || !existsSync(paths.pidPath)); i++) {
      await delay(20);
    }
    const token = readFileSync(paths.tokenPath, "utf8").trim();
    const pid = readFileSync(paths.pidPath, "utf8");
    const makeClient = () => structured ? new RenderStructuredClient(config)
      : new RenderDaemonClient(paths.socketPath, token, paths.tokenPath);
    const client = makeClient();
    disposeClient = async () => {
      await client.request("forget", structured ? { runId: "socket-upgrade-run" }
        : { sessionId: "socket-upgrade-run" }).catch(() => {});
      client.disconnect();
    };
    await client.connect();
    const request = { file: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: root, env: process.env };
    const handle = client instanceof RenderStructuredClient
      ? await client.spawnStructured({ ...request, runId: "socket-upgrade-run" })
      : (await client.createOrAttach({ ...request, sessionId: "socket-upgrade-run", name: "xterm",
        cols: 80, rows: 24 })).process!;
    assert.ok(handle);
    for (let attempt = 0; attempt < 2; attempt++) {
      unlinkSync(paths.socketPath);
      // A newly installed daemon must not steal the missing endpoint while
      // its predecessor still owns runs, even before the watchdog ticks.
      const competitor = spawn(binary, args, { stdio: "ignore" });
      const code = await new Promise<number | null>((resolve) => competitor.once("exit", resolve));
      assert.notEqual(code, 0);
      for (let i = 0; i < 150 && !existsSync(paths.socketPath); i++) await delay(20);
      const fresh = makeClient();
      try {
        await fresh.connect();
        const state = fresh instanceof RenderStructuredClient
          ? await fresh.attachRun("socket-upgrade-run") : fresh.attach("socket-upgrade-run")?.state;
        assert.equal(state?.pid, handle.pid);
        assert.equal(state?.incarnationId, handle.incarnationId);
        assert.equal(state?.status, "running");
        assert.equal(readFileSync(paths.tokenPath, "utf8").trim(), token);
        assert.equal(readFileSync(paths.pidPath, "utf8"), pid);
        assert.equal(statSync(paths.socketPath).mode & 0o777, 0o600);
        await client.request(structured ? "ping" : "hello");
      } finally { fresh.disconnect(); }
    }
  });
}
