import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { connectExistingTerminalHost } from "../src/terminal-daemon-client.js";
import { createTmuxTerminalHost } from "../src/tmux-terminal-host.js";
import { InProcessTerminalHost } from "../src/terminal-host.js";
import { buildPtyShellLaunchPlan } from "../src/pty-shell-launch.js";

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error("tmux integration condition timed out");
}

test("tmux routing preserves blank shell state and provider fallback across Server reconnect", { timeout: 30000 }, async t => {
  if (process.platform === "win32" || spawnSync("tmux", ["-V"]).status !== 0) return t.skip("tmux required");
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-tmux-routing-"));
  const configPath = path.join(root, "config.json");
  const daemonPath = path.join(root, "tmux-terminald.json");
  const child = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "fixtures/terminal-daemon-entry.ts"), daemonPath],
    { stdio: "ignore", env: process.env });
  const previousMode = process.env.WAND_TMUX_MODE;
  process.env.WAND_TMUX_MODE = "required";
  let wrapper: Awaited<ReturnType<typeof createTmuxTerminalHost>> | undefined;
  t.after(async () => {
    if (previousMode === undefined) delete process.env.WAND_TMUX_MODE;
    else process.env.WAND_TMUX_MODE = previousMode;
    wrapper?.host.disconnect();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });
  await waitFor(async () => {
    const probe = await connectExistingTerminalHost(daemonPath);
    probe?.disconnect(); return !!probe;
  });
  wrapper = await createTmuxTerminalHost(configPath, new InProcessTerminalHost());
  assert.ok(wrapper.client);
  const env = { ...process.env, HOME: root, HISTFILE: "/dev/null" };
  const shell = await wrapper.host.createOrAttach({ sessionId: "blank", file: "/bin/sh", args: ["-i"], cwd: root,
    env, name: "xterm-256color", cols: 80, rows: 24 });
  assert.ok(shell.process);
  const pid = shell.process.pid;
  await shell.process.writeConfirmed!("export WAND_KEEP=preserved; printf 'state-ready\\n'");
  await shell.process.writeConfirmed!("\r");
  await waitFor(() => wrapper!.host.attach("blank")!.state.output.includes("state-ready\r\n"));
  wrapper.host.disconnect();
  process.env.WAND_TMUX_MODE = "off";
  wrapper = await createTmuxTerminalHost(configPath, new InProcessTerminalHost());
  const restored = wrapper.host.attach("blank")!;
  assert.equal(restored.process!.pid, pid);
  await restored.process!.writeConfirmed!("printf 'value=%s\\n' \"$WAND_KEEP\"");
  await restored.process!.writeConfirmed!("\r");
  await waitFor(() => wrapper!.host.attach("blank")!.state.output.includes("value=preserved"));

  process.env.WAND_TMUX_MODE = "required";
  wrapper.host.disconnect();
  wrapper = await createTmuxTerminalHost(configPath, new InProcessTerminalHost());
  const plan = buildPtyShellLaunchPlan({ shell: "/bin/sh", command: "/bin/sh -c 'exit 7'", bareShell: false, providerCommand: true });
  const provider = await wrapper.host.createOrAttach({ sessionId: "provider", file: "/bin/sh", args: plan.shellArgs,
    cwd: root, env, name: "xterm-256color", cols: 80, rows: 24, launchMarkerToken: plan.cliExitMarker!.token });
  let exitCode: number | null = null;
  let seen = 0;
  await waitFor(() => {
    const state = wrapper!.host.attach("provider")!.state;
    const parsed = plan.cliExitMarker!.consume(state.output.slice(seen)); seen = state.output.length;
    exitCode ??= parsed.exitCode;
    return exitCode !== null;
  });
  assert.equal(exitCode, 7);
  assert.equal(wrapper.host.attach("provider")!.state.status, "running", "provider exit retains interactive shell");
  await provider.process!.writeConfirmed!("printf 'fallback-alive\\n'");
  await provider.process!.writeConfirmed!("\r");
  await waitFor(() => wrapper!.host.attach("provider")!.state.output.includes("fallback-alive\r\n"));
  for (const id of ["blank", "provider"]) wrapper.host.attach(id)!.process!.kill();
  await waitFor(() => ["blank", "provider"].every(id => wrapper!.host.attach(id)!.state.status === "exited"));
});
