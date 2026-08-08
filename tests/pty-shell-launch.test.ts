import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pty from "node-pty";

import { buildPtyShellLaunchPlan, PtyCliExitMarker } from "../src/pty-shell-launch.js";

async function waitForOutput(read: () => string, expected: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!read().includes(expected)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for PTY output: ${expected}; received ${JSON.stringify(read())}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCondition(check: () => boolean, failure: () => string): Promise<void> {
  const deadline = Date.now() + 3_000;
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
  assert.match(plan.shellArgs[1], /exec '\/bin\/zsh' -l$/);
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
  t.after(() => {
    try { child.kill(); } catch { /* already exited */ }
    rmSync(root, { recursive: true, force: true });
  });

  await waitForOutput(() => output, "WAND_HISTORY_PROMPT> ");
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

test("bare shells and one-shot non-provider commands preserve their distinct lifecycles", () => {
  const shell = buildPtyShellLaunchPlan({
    shell: "/bin/bash",
    command: "/bin/bash",
    bareShell: true,
    providerCommand: false,
    platform: "linux",
  });
  assert.deepEqual(shell.shellArgs, ["-l"]);
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
