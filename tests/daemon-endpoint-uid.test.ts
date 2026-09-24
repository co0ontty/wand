import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderPaths, resolveEndpointUid } from "../src/render-protocol.js";
import { terminalDaemonPaths } from "../src/terminal-daemon-protocol.js";
import { isDaemonProcessForConfig } from "../src/tui/commands.js";

const configPath = "/Users/example/.wand/config.json";

/**
 * 端点里的 uid 必须是「跑 daemon 的那个用户」，不能是调用者。
 *
 * 2026-09-24 的真实事故：`sudo wand service:install` 以 root 调用了同一套路径推导，
 * 算出 `/tmp/wand-render-0-<hash>.sock` 这种永远不存在的端点，于是把两个**健康**的
 * daemon 判定成「进程活着但端点丢失」直接 SIGKILL（幸好当时没有活会话）。
 */
test("daemon endpoints: uid comes from the owner, not from the caller", () => {
  assert.equal(resolveEndpointUid(501), 501);
  assert.equal(resolveEndpointUid(undefined), os.userInfo().uid);
  assert.match(renderPaths(configPath, 501).socketPath, /^\/tmp\/wand-render-501-[0-9a-f]{12}\.sock$/);
  assert.match(terminalDaemonPaths(configPath, 501).socketPath, /^\/tmp\/wand-terminald-501-[0-9a-f]{12}\.sock$/);
  // root 视角（进程 uid=0）算出来的路径与 owner 视角不同 —— 这正是必须显式传 uid 的原因。
  assert.match(renderPaths(configPath, 0).socketPath, /^\/tmp\/wand-render-0-[0-9a-f]{12}\.sock$/);
  assert.notEqual(renderPaths(configPath, 0).socketPath, renderPaths(configPath, 501).socketPath);
  // token / pid / meta 不带 uid，只按 config 归一化，两种视角一致。
  assert.equal(renderPaths(configPath, 0).pidPath, renderPaths(configPath, 501).pidPath);
});

test("daemon endpoints: an unrelated pid is never treated as this config's daemon", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wand-daemon-identity-"));
  const config = path.join(dir, "config.json");
  writeFileSync(config, "{}");

  // 命令行里同时出现二进制名与 config 路径 = 看起来是本 config 的 daemon。
  const lookalike = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 4000)", "wand-render", "-c", config],
    { stdio: "ignore" },
  );
  // 另一个完全无关的进程：绝不能因为路径解析不一致就被当成 daemon。
  const unrelated = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { stdio: "ignore" });
  try {
    assert.equal(isDaemonProcessForConfig(lookalike.pid!, config, "render"), true);
    // 同一个 pid 换个 kind 不成立（terminald 的命令行里没有 wand-render 的反向）。
    assert.equal(isDaemonProcessForConfig(lookalike.pid!, config, "terminald"), false);
    // config 路径不匹配 → 不认。
    assert.equal(isDaemonProcessForConfig(lookalike.pid!, "/other/config.json", "render"), false);
    assert.equal(isDaemonProcessForConfig(unrelated.pid!, config, "render"), false);
    assert.equal(isDaemonProcessForConfig(99_999_999, config, "render"), false);
  } finally {
    lookalike.kill("SIGKILL");
    unrelated.kill("SIGKILL");
  }
});
