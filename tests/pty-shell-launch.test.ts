import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pty from "node-pty";

import { buildPtyShellLaunchPlan, PtyCliExitMarker } from "../src/pty-shell-launch.js";

async function waitForOutput(read: () => string, expected: string, timeoutMs = 10_000): Promise<void> {
  // 全量套件下 node --test 会并行拉起几十个测试进程，zsh 启动 + PTY 回显的
  // 尾延迟远高于空载单跑。给足余量避免负载抖动造成假失败。
  const deadline = Date.now() + timeoutMs;
  while (!read().includes(expected)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for PTY output: ${expected}; received ${JSON.stringify(read())}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCondition(check: () => boolean, failure: () => string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(failure());
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("POSIX provider commands return to a persistent interactive login shell", () => {
  const plan = buildPtyShellLaunchPlan({
    shell: "/bin/zsh",
    command: "codex --model 'gpt-5'",
    bareShell: false,
    providerCommand: true,
    platform: "darwin",
    markerToken: "marker-token",
  });

  assert.equal(plan.shellArgs[0], "-lic");
  assert.match(plan.shellArgs[1], /print -s -- 'codex --model '\\''gpt-5'\\'''/);
  assert.match(plan.shellArgs[1], /fc -AI \"\$HISTFILE\"/);
  assert.ok(
    plan.shellArgs[1].indexOf("print -s") < plan.shellArgs[1].indexOf("if codex"),
    "the provider command must be registered before it starts",
  );
  assert.match(plan.shellArgs[1], /if codex --model 'gpt-5'/);
  assert.match(plan.shellArgs[1], /WAND_CLI_EXIT:marker-token:%s/);
  assert.match(plan.shellArgs[1], /1049l/);
  assert.match(plan.shellArgs[1], /stty sane/);
  assert.match(plan.shellArgs[1], /exec '\/bin\/zsh' -il$/);
  assert.equal(plan.commandToWrite, undefined);
  assert.ok(plan.cliExitMarker);
});

test("bash provider commands are appended to interactive history", () => {
  const plan = buildPtyShellLaunchPlan({
    shell: "/bin/bash",
    command: "claude --permission-mode bypassPermissions",
    bareShell: false,
    providerCommand: true,
    platform: "linux",
    markerToken: "bash-marker",
  });

  assert.match(plan.shellArgs[1], /history -s 'claude --permission-mode bypassPermissions'/);
  assert.match(plan.shellArgs[1], /history -a/);
  assert.match(plan.shellArgs[1], /if claude --permission-mode bypassPermissions/);
});

test("zsh fallback recalls the provider command with the up arrow", {
  skip: !existsSync("/bin/zsh"),
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pty-history-"));
  const historyFile = path.join(root, ".zsh_history");
  writeFileSync(
    path.join(root, ".zshrc"),
    [
      `HISTFILE=${historyFile}`,
      "HISTSIZE=100",
      "SAVEHIST=100",
      "setopt SHARE_HISTORY",
      "PS1='WAND_HISTORY_PROMPT> '",
    ].join("\n"),
  );

  const plan = buildPtyShellLaunchPlan({
    shell: "/bin/zsh",
    command: "printf WAND_PROVIDER_RAN",
    bareShell: false,
    providerCommand: true,
    platform: process.platform,
    markerToken: "history-marker",
  });
  const child = pty.spawn("/bin/zsh", plan.shellArgs, {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      ZDOTDIR: root,
      TERM: "xterm-256color",
      TERM_PROGRAM: "wand-test",
      TERM_SESSION_ID: "",
    },
    cols: 100,
    rows: 30,
  });
  let output = "";
  child.onData((chunk) => { output += chunk; });
  t.after(async () => {
    // zsh 退出时会异步 flush HISTFILE；不等它退完就删目录会跟写历史赛跑，
    // 偶发 ENOTEMPTY。先等退出事件（封顶 1.5s），再用带重试的 rmSync 兜底。
    const exited = new Promise<void>((resolve) => child.onExit(() => resolve()));
    try { child.kill(); } catch { /* already exited */ }
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    ]);
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  await waitForOutput(() => output, "WAND_HISTORY_PROMPT> ");
  // SHARE_HISTORY 下 zsh 是增量写历史文件的，提示符出现不等于已落盘——等它
  // 出现再断言次数，否则高负载下会读到半空的文件误报失败。
  await waitForCondition(
    () => /printf WAND_PROVIDER_RAN/.test(readFileSync(historyFile, "utf8")),
    () => `the provider command never reached the history file`,
  );
  assert.equal(
    readFileSync(historyFile, "utf8").match(/printf WAND_PROVIDER_RAN/g)?.length,
    1,
    "shared-history shells must not append Wand's startup command twice",
  );
  child.write("\x1b[A\r");
  await waitForCondition(
    () => (output.match(/WAND_PROVIDER_RAN/g) ?? []).length >= 3,
    () => `the recalled command did not run; received ${JSON.stringify(output)}`,
  );

  const providerRuns = output.match(/WAND_PROVIDER_RAN/g) ?? [];
  assert.ok(providerRuns.length >= 3, "the recalled command should be echoed and executed a second time");
  assert.match(readFileSync(historyFile, "utf8"), /printf WAND_PROVIDER_RAN/);
});

test("Ctrl+C after a provider command lands in an interactive login shell", {
  skip: !existsSync("/bin/zsh"),
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pty-fallback-"));
  writeFileSync(
    path.join(root, ".zshrc"),
    ["PS1='WAND_FALLBACK> '", "unsetopt ZLE", "unsetopt PROMPT_SP"].join("\n"),
  );

  const plan = buildPtyShellLaunchPlan({
    shell: "/bin/zsh",
    command: "printf WAND_PROVIDER_RUNNING; sleep 30",
    bareShell: false,
    providerCommand: true,
    platform: process.platform,
    markerToken: "fallback-marker",
  });
  const child = pty.spawn("/bin/zsh", plan.shellArgs, {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      ZDOTDIR: root,
      SHELL: "/bin/zsh",
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      LC_CTYPE: "C.UTF-8",
    },
    cols: 100,
    rows: 30,
  });
  let output = "";
  let exited = false;
  child.onData((chunk) => { output += chunk; });
  child.onExit(() => { exited = true; });
  t.after(async () => {
    const done = new Promise<void>((resolve) => child.onExit(() => resolve()));
    try { child.kill(); } catch { /* already exited */ }
    await Promise.race([
      done,
      new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    ]);
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  await waitForOutput(() => output, "WAND_PROVIDER_RUNNING");
  child.write("\x03");
  await waitForOutput(() => output, "WAND_FALLBACK> ");
  assert.equal(exited, false, "Ctrl+C must not kill the persistent PTY shell");
  child.write("printf WAND_SHELL_OK\\n\r");
  await waitForOutput(() => output, "WAND_SHELL_OK");
});

test("bare shells and one-shot non-provider commands preserve their distinct lifecycles", () => {
  const shell = buildPtyShellLaunchPlan({
    shell: "/bin/bash",
    command: "/bin/bash",
    bareShell: true,
    providerCommand: false,
    platform: "linux",
  });
  assert.deepEqual(shell.shellArgs, ["-il"]);
  assert.equal(shell.cliExitMarker, null);

  const oneShot = buildPtyShellLaunchPlan({
    shell: "/bin/bash",
    command: "npm test",
    bareShell: false,
    providerCommand: false,
    platform: "linux",
  });
  assert.deepEqual(oneShot.shellArgs, ["-lc", "npm test"]);
  assert.equal(oneShot.commandToWrite, undefined);
});

test("CLI exit markers are stripped across arbitrary PTY chunk boundaries", () => {
  const marker = new PtyCliExitMarker("split-token");
  const first = marker.consume("provider output\x1eWAND_CLI_");
  const second = marker.consume("EXIT:split-token:130\x1fshell prompt");
  const third = marker.consume("$ pwd");

  assert.deepEqual(first, { data: "provider output", exitCode: null });
  assert.deepEqual(second, { data: "shell prompt", exitCode: 130 });
  assert.deepEqual(third, { data: "$ pwd", exitCode: null });
});

test("unknown shell syntaxes use interactive command injection as a compatibility fallback", () => {
  const plan = buildPtyShellLaunchPlan({
    shell: "/usr/local/bin/fish",
    command: "claude",
    bareShell: false,
    providerCommand: true,
    platform: "darwin",
  });

  assert.deepEqual(plan.shellArgs, ["-l"]);
  assert.equal(plan.commandToWrite, "claude");
  assert.equal(plan.cliExitMarker, null);
});
