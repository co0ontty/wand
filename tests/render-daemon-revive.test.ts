import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { connectExistingRenderClient } from "../src/render-daemon-client.js";
import { createRenderDaemonReviver } from "../src/render-host.js";
import { renderPaths } from "../src/render-protocol.js";

const binary = path.resolve("render/target/debug", "wand-render");

async function waitFor(check: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * 运行时自愈：daemon 死掉后端点不可用时（socket 文件被临时目录清理器删掉，
 * 或被 kill -9 后作为陈留文件留下来），Server 必须自己把 Render 拉回来，
 * 而不是永久卡在 `Render is unavailable` 直到有人重启整个 web 服务。
 */
for (const shape of ["socket-file-removed", "stale-socket-left"] as const) {
  test(`render: client revives a dead daemon (${shape})`, {
    skip: !existsSync(binary), timeout: 30_000,
  }, async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wand-render-revive-"));
    const config = path.join(root, "config.json");
    writeFileSync(config, "{}");
    const paths = renderPaths(config);
    const args = ["-c", config];
    const daemon: ChildProcess = spawn(binary, args, { stdio: "ignore" });
    t.after(() => {
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    });

    await waitFor(() => existsSync(paths.socketPath) && existsSync(paths.pidPath), "the first daemon to publish its endpoint");
    const firstPid = Number(readFileSync(paths.pidPath, "utf8").trim());
    assert.ok(firstPid > 0);

    const reviveDaemon = createRenderDaemonReviver(config, binary);
    const client = await connectExistingRenderClient(config, [], reviveDaemon);
    assert.ok(client, "the daemon must be adoptable before the crash");
    t.after(() => client!.disconnect());

    // 撞上线上那次故障的形状：daemon 死掉，端点跟着失效。
    process.kill(firstPid, "SIGKILL");
    await waitFor(() => !alive(firstPid), "the daemon to die");
    if (shape === "socket-file-removed") {
      try { unlinkSync(paths.socketPath); } catch { /* 已经不在了 */ }
    }

    // 客户端必须自己发现「没有活着的 owner + 端点不可用」，重建 daemon 并重连。
    await waitFor(() => {
      try {
        const pid = Number(readFileSync(paths.pidPath, "utf8").trim());
        return pid > 0 && pid !== firstPid && alive(pid);
      } catch { return false; }
    }, "the revived daemon to publish its pid", 25_000);
    const revivedPid = Number(readFileSync(paths.pidPath, "utf8").trim());
    t.after(() => { try { process.kill(revivedPid, "SIGKILL"); } catch { /* 已退出 */ } });

    // 新 daemon 的 token 是轮换过的：这条重试同时覆盖「重连时必须重读 token 文件」。
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        await client.request("hello");
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await delay(100);
      }
    }

    const created = await client.createOrAttach({
      sessionId: "revived-session",
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      env: process.env,
      name: "xterm-256color",
      cols: 80,
      rows: 24,
    });
    assert.equal(created.isNew, true, "a revived daemon must accept new sessions");
    await client.request("kill", { sessionId: "revived-session", signal: "SIGKILL" });
  });
}
