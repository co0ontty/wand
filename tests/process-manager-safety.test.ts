import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import pty, { type IPty } from "node-pty";
import { defaultConfig } from "../src/config.js";
import { isCommandAllowedByPrefixes, ProcessManager } from "../src/process-manager.js";
import type { EscalationRequest, ProcessEvent, SessionSnapshot } from "../src/types.js";
import type { WandStorage } from "../src/storage.js";

class FakeStorage {
  private readonly sessions = new Map<string, SessionSnapshot>();
  fullSaveCalls = 0;
  runtimeMetadataCalls = 0;
  outputCheckpointCalls = 0;
  messageCheckpointCalls = 0;

  loadSessions(): SessionSnapshot[] {
    return Array.from(this.sessions.values());
  }

  getSession(id: string): SessionSnapshot | null {
    return this.sessions.get(id) ?? null;
  }

  saveSession(snapshot: SessionSnapshot): void {
    this.fullSaveCalls += 1;
    this.sessions.set(snapshot.id, structuredClone(snapshot));
  }

  saveSessionMetadata(snapshot: SessionSnapshot): void {
    this.updateSessionRuntimeMetadata(snapshot);
  }

  updateSessionRuntimeMetadata(snapshot: SessionSnapshot): void {
    this.runtimeMetadataCalls += 1;
    const current = this.sessions.get(snapshot.id);
    this.sessions.set(snapshot.id, structuredClone({
      ...snapshot,
      output: current?.output ?? snapshot.output,
      messages: current?.messages,
    }));
  }

  checkpointSessionOutput(id: string, output: string): void {
    this.outputCheckpointCalls += 1;
    const current = this.sessions.get(id);
    if (current) this.sessions.set(id, structuredClone({ ...current, output }));
  }

  checkpointSessionMessages(
    id: string,
    messages: NonNullable<SessionSnapshot["messages"]>,
    structuredState?: SessionSnapshot["structuredState"] | null,
    output?: string,
  ): void {
    this.messageCheckpointCalls += 1;
    const current = this.sessions.get(id);
    if (!current) return;
    this.sessions.set(id, structuredClone({
      ...current,
      messages,
      ...(structuredState !== undefined ? { structuredState: structuredState ?? undefined } : {}),
      ...(output !== undefined ? { output } : {}),
    }));
  }

  deleteSession(id: string): void {
    this.sessions.delete(id);
  }

  resetCounts(): void {
    this.fullSaveCalls = 0;
    this.runtimeMetadataCalls = 0;
    this.outputCheckpointCalls = 0;
    this.messageCheckpointCalls = 0;
  }
}

class FakePty {
  readonly process = "fake";
  readonly handleFlowControl = false;
  readonly writes: string[] = [];
  killed = false;
  resizeCalls = 0;
  cols = 120;
  rows = 36;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  constructor(readonly pid: number) {}

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls += 1;
    this.cols = cols;
    this.rows = rows;
  }

  clear(): void {}
  pause(): void {}
  resume(): void {}

  kill(): void {
    this.killed = true;
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) listener({ exitCode });
  }
}

function createHarness(t: test.TestContext, allowedCommandPrefixes: string[] = []) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pm-safety-"));
  const spawned: FakePty[] = [];
  const spawnCalls: unknown[][] = [];
  const ptyModule = pty as unknown as { spawn: (...args: unknown[]) => IPty };
  const originalSpawn = ptyModule.spawn;
  ptyModule.spawn = (...args: unknown[]) => {
    spawnCalls.push(args);
    const child = new FakePty(10_000 + spawned.length);
    spawned.push(child);
    return child as unknown as IPty;
  };

  const storage = new FakeStorage();
  const manager = new ProcessManager(
    { ...defaultConfig(), defaultCwd: root, startupCommands: [], allowedCommandPrefixes },
    storage as unknown as WandStorage,
    path.join(root, ".wand"),
  );

  t.after(() => {
    ptyModule.spawn = originalSpawn;
    rmSync(root, { recursive: true, force: true });
  });

  return { manager, root, spawned, spawnCalls, storage };
}

test("Grok PTY launches the TUI with model, effort, and managed approval flags", async (t) => {
  const { manager, root, spawnCalls } = createHarness(t);
  const session = await manager.start("grok", root, "managed", undefined, {
    provider: "grok",
    model: "grok-4.5",
    thinkingEffort: "deep",
  });
  assert.equal(session.provider, "grok");
  assert.equal(session.runner, "pty");
  assert.equal(session.providerCliActive, true);
  assert.match(session.claudeSessionId ?? "", /^[0-9a-f-]{36}$/);
  const shellArgs = spawnCalls[0][1] as string[];
  assert.equal(shellArgs[0], "-lic");
  assert.match(shellArgs.at(-1) ?? "", /if grok --model 'grok-4\.5' --effort 'high' --always-approve --session-id [0-9a-f-]{36}/);
});

test("Qoder PTY launches the TUI with model and managed permission flags", async (t) => {
  const { manager, root, spawnCalls } = createHarness(t);
  const session = await manager.start("qodercli", root, "managed", undefined, {
    provider: "qoder",
    model: "performance",
  });
  assert.equal(session.provider, "qoder");
  assert.equal(session.runner, "pty");
  assert.match(session.claudeSessionId ?? "", /^[0-9a-f-]{36}$/);
  const shellArgs = spawnCalls[0][1] as string[];
  assert.equal(shellArgs[0], "-lic");
  assert.match(shellArgs.at(-1) ?? "", /if qodercli --model 'performance' --permission-mode bypass_permissions --session-id [0-9a-f-]{36}/);
});

test("Pi PTY launches the TUI with model and thinking flags", async (t) => {
  const { manager, root, spawnCalls } = createHarness(t);
  const session = await manager.start("pi", root, "managed", undefined, {
    provider: "pi",
    model: "openai/gpt-5.4",
    thinkingEffort: "deep",
  });
  assert.equal(session.provider, "pi");
  assert.equal(session.runner, "pty");
  const shellArgs = spawnCalls[0][1] as string[];
  assert.equal(shellArgs[0], "-lic");
  assert.match(shellArgs.at(-1) ?? "", /if pi --model 'openai\/gpt-5\.4' --thinking 'high'/);
});

test("OpenCode PTY never injects --variant (TUI-only flags must stay on `opencode run`)", async (t) => {
  const { manager, root, spawnCalls } = createHarness(t);
  // --variant belongs to the `opencode run` subcommand only; the interactive
  // TUI rejects it and exits. thinkingEffort must not leak into the TUI command.
  const session = await manager.start("opencode", root, "full-access", undefined, {
    provider: "opencode",
    model: "opencode/big-pickle",
    thinkingEffort: "max",
  });
  assert.equal(session.provider, "opencode");
  assert.equal(session.runner, "pty");
  const shellArgs = spawnCalls[0][1] as string[];
  assert.equal(shellArgs[0], "-lic");
  const launched = shellArgs.at(-1) ?? "";
  assert.match(launched, /if opencode --model 'opencode\/big-pickle' --auto/);
  assert.doesNotMatch(launched, /--variant/);
});

test("command allowlist compares safe shell tokens instead of raw prefixes", () => {
  assert.equal(isCommandAllowedByPrefixes("claude --resume abc", ["claude"]), true);
  assert.equal(isCommandAllowedByPrefixes("MODEL=sonnet claude --help", ["claude"]), false);
  assert.equal(isCommandAllowedByPrefixes("MODEL=sonnet claude --help", ["MODEL=sonnet claude"]), true);
  assert.equal(isCommandAllowedByPrefixes("npx claude --help", ["npx claude"]), true);
  assert.equal(isCommandAllowedByPrefixes("claude --prompt 'safe; argument'", ["claude"]), true);
  assert.equal(isCommandAllowedByPrefixes("claude --prompt \"safe | argument\"", ["claude"]), true);

  assert.equal(isCommandAllowedByPrefixes("claude-malicious", ["claude"]), false);
  assert.equal(isCommandAllowedByPrefixes("PATH=/tmp claude", ["claude"]), false);
  assert.equal(isCommandAllowedByPrefixes("claude; evil", ["claude"]), false);
  assert.equal(isCommandAllowedByPrefixes("claude && evil", ["claude"]), false);
  assert.equal(isCommandAllowedByPrefixes("claude | evil", ["claude"]), false);
  assert.equal(isCommandAllowedByPrefixes("claude $(evil)", ["claude"]), false);
  assert.equal(isCommandAllowedByPrefixes("claude \"$(evil)\"", ["claude"]), false);
  assert.equal(isCommandAllowedByPrefixes("claude 'unterminated", ["claude"]), false);
});

test("ProcessManager rejects unsafe allowlist lookalikes before spawning", async (t) => {
  const { manager, root, spawned } = createHarness(t, ["opencode"]);

  await assert.rejects(
    manager.start("opencode-malicious", root, "default", undefined, { provider: "opencode" }),
    /not allowed/,
  );
  await assert.rejects(
    manager.start("opencode; evil", root, "default", undefined, { provider: "opencode" }),
    /not allowed/,
  );
  assert.equal(spawned.length, 0);
});

test("bare shell sessions launch the configured login shell without provider metadata", async (t) => {
  const { manager, root, spawned, spawnCalls } = createHarness(t, ["claude"]);

  const session = await manager.startShell(root, "default", { cols: 96, rows: 28 });

  assert.equal(session.sessionKind, "pty");
  assert.equal(session.provider, undefined);
  assert.equal(session.providerCliActive, false);
  assert.equal(session.command, defaultConfig().shell);
  assert.equal(spawnCalls[0][0], defaultConfig().shell);
  assert.deepEqual(spawnCalls[0][1], process.platform === "win32" ? [] : ["-l"]);
  assert.equal(session.claudeSessionId, null);
  assert.equal(session.autoApprovePermissions, false);
  manager.resize(session.id, 96, 28);
  assert.equal(spawned[0].resizeCalls, 0, "an unchanged size must not signal SIGWINCH");
  manager.resize(session.id, 100, 30);
  assert.equal(spawned[0].resizeCalls, 1);
});

test("provider CLI exit returns to the live shell without parsing later shell commands as chat", async (t) => {
  const { manager, root, spawned, spawnCalls } = createHarness(t);
  const session = await manager.start("claude", root, "managed", undefined, {
    provider: "claude",
    reuseId: "provider-shell-fallback",
  });
  const wrapper = (spawnCalls[0][1] as string[])[1];
  const token = /WAND_CLI_EXIT:([0-9a-f-]+):%s/.exec(wrapper)?.[1];
  assert.ok(token);

  spawned[0].emitData(`provider stopped\x1eWAND_CLI_EXIT:${token}:130\x1fshell prompt`);
  const afterExit = manager.get(session.id)!;
  assert.equal(afterExit.status, "running");
  assert.equal(afterExit.providerCliActive, false);
  assert.equal(afterExit.providerCliExitCode, 130);
  assert.equal(afterExit.output.includes("WAND_CLI_EXIT"), false);
  assert.match(afterExit.output, /provider stoppedshell prompt/);

  manager.sendInput(session.id, "pwd\r", "terminal");
  assert.deepEqual(manager.get(session.id)?.messages ?? [], []);
  assert.equal(spawned[0].writes.at(-1), "pwd\r");

  const writesBeforeModelChange = spawned[0].writes.length;
  manager.setSessionModel(session.id, "sonnet");
  manager.setSessionThinkingEffort(session.id, "deep");
  assert.equal(spawned[0].writes.length, writesBeforeModelChange);
});

test("disabling auto approval persists the false value", async (t) => {
  const { manager, root, storage } = createHarness(t);
  const started = await manager.start("claude", root, "full-access", undefined, {
    provider: "claude",
    reuseId: "persist-false-auto-approve",
  });
  assert.equal(started.autoApprovePermissions, true);

  const updated = manager.toggleAutoApprove(started.id);
  assert.equal(updated.autoApprovePermissions, false);
  assert.equal(storage.getSession(started.id)?.autoApprovePermissions, false);

  manager.dispose();
  const persisted = storage.getSession(started.id)!;
  storage.saveSession({
    ...persisted,
    approvalStats: { tool: 1, command: 2, file: 3, total: 6 },
    currentTaskTitle: "Persisted task",
    summary: "Persisted summary",
  });
  const restored = new ProcessManager(
    { ...defaultConfig(), defaultCwd: root, startupCommands: [] },
    storage as unknown as WandStorage,
    path.join(root, ".wand-restored"),
  );
  t.after(() => restored.dispose());
  assert.equal(restored.get(started.id)?.autoApprovePermissions, false);
  assert.deepEqual(restored.get(started.id)?.approvalStats, {
    tool: 1,
    command: 2,
    file: 3,
    total: 6,
  });
  assert.equal(restored.get(started.id)?.currentTaskTitle, "Persisted task");
  assert.equal(restored.get(started.id)?.summary, "Persisted summary");
});

test("late PTY data and exit callbacks cannot mutate a reused session id", async (t) => {
  const { manager, root, spawned, storage } = createHarness(t);
  const events: ProcessEvent[] = [];
  manager.on("process", (event) => events.push(event));

  await manager.start("opencode", root, "default", undefined, {
    provider: "opencode",
    reuseId: "same-session",
  });
  const oldPty = spawned[0];
  oldPty.emitData("old output");

  await manager.start("opencode", root, "default", undefined, {
    provider: "opencode",
    reuseId: "same-session",
  });
  const currentPty = spawned[1];
  assert.equal(oldPty.killed, true);

  oldPty.emitData("stale output");
  oldPty.emitExit(1);

  assert.equal(manager.get("same-session")?.status, "running");
  assert.equal(manager.get("same-session")?.output.includes("stale output"), false);
  assert.equal(storage.getSession("same-session")?.status, "running");
  assert.equal(events.filter((event) => event.type === "ended").length, 0);

  manager.sendInput("same-session", "current input", "terminal");
  assert.deepEqual(currentPty.writes, ["current input"]);
  assert.deepEqual(oldPty.writes, []);

  currentPty.emitData("current output");
  assert.equal(manager.get("same-session")?.output, "current output");
  currentPty.emitExit(0);
  assert.equal(manager.get("same-session")?.status, "exited");
  assert.equal(events.filter((event) => event.type === "ended").length, 1);
});

test("continuous PTY output checkpoints every throttle window and flushes on dispose", async (t) => {
  const { manager, root, spawned, storage } = createHarness(t);
  const started = await manager.start("opencode", root, "default", undefined, {
    provider: "opencode",
    reuseId: "continuous-output",
  });
  storage.resetCounts();

  spawned[0].emitData("0");
  let index = 1;
  const interval = setInterval(() => spawned[0].emitData(String(index++)), 10);
  interval.unref?.();
  await delay(1_100);
  clearInterval(interval);

  assert.equal(storage.outputCheckpointCalls, 1, "continuous output must not postpone the one-second checkpoint");
  assert.equal(storage.fullSaveCalls, 0);
  const expectedOutput = manager.get(started.id)?.output;

  manager.dispose();
  assert.equal(storage.fullSaveCalls, 1);
  assert.equal(storage.getSession(started.id)?.output, expectedOutput);
});

test("permission resolution requires a live matching escalation", async (t) => {
  const { manager, root, spawned } = createHarness(t);
  const session = await manager.start("opencode", root, "default", undefined, {
    provider: "opencode",
    reuseId: "permission-session",
  });
  const child = spawned[0];

  assert.throws(
    () => manager.resolvePermission(session.id, "approve_once"),
    /not found/,
  );
  assert.deepEqual(child.writes, []);

  const records = (manager as unknown as {
    sessions: Map<string, {
      pendingEscalation: EscalationRequest | null;
      ptyPermissionBlocked: boolean;
    }>;
  }).sessions;
  const record = records.get(session.id)!;
  record.pendingEscalation = {
    requestId: "request-1",
    scope: "run_command",
    runner: "pty",
    source: "tool_permission_request",
    reason: "Run a command",
  };
  record.ptyPermissionBlocked = true;

  assert.throws(
    () => manager.resolveEscalation(session.id, "stale-request", "approve_once"),
    /not found/,
  );
  assert.throws(
    () => manager.resolvePermission(session.id, "approve_forever" as never, "request-1"),
    /Invalid permission resolution/,
  );
  assert.deepEqual(child.writes, []);
  assert.equal(record.pendingEscalation?.requestId, "request-1");

  const resolved = manager.resolveEscalation(session.id, "request-1", "approve_turn");
  assert.deepEqual(child.writes, ["\r"]);
  assert.equal(resolved.pendingEscalation, undefined);
  assert.equal(resolved.lastEscalationResult?.requestId, "request-1");
  assert.equal(resolved.lastEscalationResult?.resolution, "approve_turn");
});
