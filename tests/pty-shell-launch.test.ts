import assert from "node:assert/strict";
import test from "node:test";

import { buildPtyShellLaunchPlan, PtyCliExitMarker } from "../src/pty-shell-launch.js";

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
  assert.match(plan.shellArgs[1], /if codex --model 'gpt-5'/);
  assert.match(plan.shellArgs[1], /WAND_CLI_EXIT:marker-token:%s/);
  assert.match(plan.shellArgs[1], /exec '\/bin\/zsh' -l$/);
  assert.equal(plan.commandToWrite, undefined);
  assert.ok(plan.cliExitMarker);
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
