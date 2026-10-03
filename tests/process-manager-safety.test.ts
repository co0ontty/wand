import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import pty, { type IPty } from "node-pty";
import { defaultConfig } from "../src/config.js";
import { isCommandAllowedByPrefixes, ProcessManager, type ProcessManagerOptions } from "../src/process-manager.js";
import { toSessionListItemDTO } from "../src/session-transport.js";
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

  /** 这个假存储没有内置员工，会话主题按会话自身的 provider 解析。 */
  getSystemSiliconEmployee() {
    return null;
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

function createHarness(t: test.TestContext, allowedCommandPrefixes: string[] = [], options: ProcessManagerOptions = {}) {
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
    undefined,
    options,
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

test("Qoder PTY always launches in yolo mode regardless of the selected mode", async (t) => {
  for (const mode of ["default", "auto-edit"] as const) {
    const { manager, root, spawnCalls } = createHarness(t);
    const session = await manager.start("qodercli", root, mode, undefined, {
      provider: "qoder",
      model: "performance",
    });
    assert.equal(session.provider, "qoder");
    assert.equal(session.mode, mode);
    const shellArgs = spawnCalls[0][1] as string[];
    assert.match(shellArgs.at(-1) ?? "", /if qodercli --model 'performance' --permission-mode bypass_permissions --session-id [0-9a-f-]{36}/);
    assert.doesNotMatch(shellArgs.at(-1) ?? "", /accept_edits/);
  }
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

test("Gemini PTY launches the TUI with model, mode-derived approval, and an assigned session id", async (t) => {
  const { manager, root, spawnCalls } = createHarness(t);
  const session = await manager.start("gemini", root, "managed", undefined, {
    provider: "gemini",
    model: "gemini-2.5-pro",
  });
  assert.equal(session.provider, "gemini");
  assert.equal(session.runner, "pty");
  // gemini 接受调用方指定的 UUID，PTY 直接前置 --session-id 就能拿到可 resume 的 ID。
  assert.match(session.claudeSessionId ?? "", /^[0-9a-f-]{36}$/);
  const shellArgs = spawnCalls[0][1] as string[];
  assert.equal(shellArgs[0], "-lic");
  assert.match(shellArgs.at(-1) ?? "", /if gemini --model 'gemini-2\.5-pro' --approval-mode yolo --session-id [0-9a-f-]{36}/);

  const standard = await manager.start("gemini", root, "default", undefined, { provider: "gemini" });
  assert.equal(standard.mode, "default");
  assert.doesNotMatch((spawnCalls.at(-1)?.[1] as string[]).at(-1) ?? "", /--approval-mode/);
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
  assert.deepEqual(spawnCalls[0][1], process.platform === "win32" ? [] : ["-il"]);
  const spawnOpts = spawnCalls[0][2] as { env?: NodeJS.ProcessEnv };
  assert.equal(spawnOpts.env?.SHELL, defaultConfig().shell);
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

test("PTY spawn failures raise instead of leaving a failed session row", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pm-spawn-fail-"));
  const storage = new FakeStorage();
  const host = {
    persistent: false,
    attach() { return null; },
    async createOrAttach() { throw new Error("posix_spawnp failed."); },
    forget() {},
    disconnect() {},
  };
  const manager = new ProcessManager(
    { ...defaultConfig(), defaultCwd: root, startupCommands: [] },
    storage as unknown as WandStorage,
    path.join(root, ".wand"),
    host as never,
  );
  t.after(() => {
    manager.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(
    () => manager.startShell(root, "default"),
    /spawn-helper/,
  );
  assert.equal(manager.listSlim().length, 0);
  assert.equal(storage.loadSessions().length, 0);
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

test("explicitly stopping a PTY session broadcasts ended so clients leave the running state", async (t) => {
  const { manager, root, spawned } = createHarness(t);
  const events: ProcessEvent[] = [];
  manager.on("process", (event) => events.push(event));

  const session = await manager.start("opencode", root, "default", undefined, {
    provider: "opencode",
    reuseId: "stop-notifies",
  });
  events.length = 0;

  assert.equal(manager.stop(session.id).status, "stopped");

  // 主动停止后 ptyProcess 已被清空，handleTerminalExit 会把随后的异步退出当成过期
  // 回调直接 return，所以 ended 只能由 stop() 自己发；否则各端一直以为会话在跑。
  const ended = events.filter((event) => event.type === "ended");
  assert.equal(ended.length, 1);
  assert.equal(ended[0]?.sessionId, session.id);
  assert.equal((ended[0]?.data as SessionSnapshot | undefined)?.status, "stopped");

  spawned[0].emitExit(0);
  assert.equal(events.filter((event) => event.type === "ended").length, 1, "no duplicate ended from the stale exit callback");
  assert.equal(manager.get(session.id)?.status, "stopped");

  assert.throws(() => manager.sendInput(session.id, "late", "terminal"), /not running/);
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

test("Claude PTY exposes per-turn ptyBusy on snapshots", async (t) => {
  const { manager, root, spawned } = createHarness(t);
  const session = await manager.start("claude", root, "managed", undefined, {
    provider: "claude",
  });
  // 空闲在提示符：进程活着但本轮未开始 → ptyBusy false
  assert.equal(session.ptyBusy, false);
  assert.equal(toSessionListItemDTO(session).ptyBusy, false);

  // 用户发送输入 → bridge onUserInput → busy true
  manager.sendInput(session.id, "hello\r", "terminal");
  assert.equal(manager.get(session.id)?.ptyBusy, true);

  // CLI 回显输入并以空提示符结束本轮（bare "❯" 行是 noise，需要 "❯ Try" 才判定完成）
  spawned[0].emitData("hello\r\n");
  spawned[0].emitData("\r\n❯ Try\r\n");
  assert.equal(manager.get(session.id)?.ptyBusy, false);

  // 进程退出 → busy 保持 false，status 翻转为 exited
  spawned[0].emitExit(0);
  await delay(20);
  const afterExit = manager.get(session.id);
  assert.equal(afterExit?.status, "exited");
  assert.equal(afterExit?.ptyBusy, false);
});

test("non-Claude PTY providers get a quiet-window turn signal on ptyBusy", async (t) => {
  const { manager, root, spawned } = createHarness(t, [], { ptyTurnIdleMs: 60 });
  const session = await manager.start("pi", root, "managed", undefined, { provider: "pi" });
  assert.equal(session.ptyBusy, false);

  const statuses: boolean[] = [];
  manager.on("process", (event: ProcessEvent) => {
    if (event.type !== "status" || event.sessionId !== session.id) return;
    const busy = (event.data as { ptyBusy?: boolean }).ptyBusy;
    if (typeof busy === "boolean") statuses.push(busy);
  });

  // Body text without a terminator does not start a turn.
  manager.sendInput(session.id, "hello", "terminal");
  assert.equal(manager.get(session.id)?.ptyBusy, false);

  // The separate Enter chunk opens the turn and surfaces on the wire DTO.
  manager.sendInput(session.id, "\r", "terminal", "enter_text");
  assert.equal(manager.get(session.id)?.ptyBusy, true);
  assert.equal(toSessionListItemDTO(manager.get(session.id)!).ptyBusy, true);

  // Output refreshes the window, so the turn stays open past the first deadline.
  spawned[0].emitData("working...");
  await delay(40);
  assert.equal(manager.get(session.id)?.ptyBusy, true);

  // Silence beyond the window means the CLI is back at its prompt.
  await delay(120);
  assert.equal(manager.get(session.id)?.ptyBusy, false);
  assert.deepEqual(statuses, [true, false]);

  // Stray output after a closed turn reopens it while the CLI is still in the
  // foreground: a CLI that keeps drawing is working, whether or not the user just
  // submitted anything (the probe is unknown here, so this falls back to
  // providerCliActive). See the foreground-sampling test for the qualified case.
  spawned[0].emitData("leftover repaint");
  await delay(10);
  assert.equal(manager.get(session.id)?.ptyBusy, true);
});

test("foreground sampling is what qualifies a non-Claude PTY turn", async (t) => {
  let cliInForeground = false;
  const { manager, root, spawned } = createHarness(t, [], {
    ptyTurnIdleMs: 60,
    ptyForegroundSampleMs: 20,
    samplePtyForegrounds: async (pids: readonly number[]) => new Map(pids.map((pid) => [pid, cliInForeground])),
  });
  const session = await manager.start("pi", root, "managed", undefined, { provider: "pi" });
  const wireStatuses: boolean[] = [];
  manager.on("process", (event: ProcessEvent) => {
    if (event.type !== "status" || event.sessionId !== session.id) return;
    const busy = (event.data as { ptyBusy?: boolean }).ptyBusy;
    if (typeof busy === "boolean") wireStatuses.push(busy);
  });

  // 采样说「前台是提示符」：终端里的散装重绘不开启一轮。
  await delay(60);
  spawned[0].emitData("prompt repaint");
  await delay(20);
  assert.equal(manager.get(session.id)?.ptyBusy, false);

  // CLI 重新回到前台（自更新 / 手动重跑）后，同一个终端的输出重新开启一轮，
  // 既不需要新的提交，也不需要那次性的启动标记。
  cliInForeground = true;
  await delay(60);
  spawned[0].emitData("working...");
  await delay(20);
  assert.equal(manager.get(session.id)?.ptyBusy, true);

  // CLI 退回提示符：采样直接收轮，不必等静默窗口。
  cliInForeground = false;
  await delay(80);
  assert.equal(manager.get(session.id)?.ptyBusy, false);
  assert.deepEqual(wireStatuses, [true, false]);
});

test("stopping a non-Claude PTY turn clears the quiet-window timer", async (t) => {
  const { manager, root } = createHarness(t, [], { ptyTurnIdleMs: 60 });
  const session = await manager.start("pi", root, "managed", undefined, { provider: "pi" });
  manager.sendInput(session.id, "\r", "terminal", "enter_text");
  assert.equal(manager.get(session.id)?.ptyBusy, true);
  manager.stop(session.id);
  assert.equal(manager.get(session.id)?.ptyBusy, false);
  assert.equal(manager.get(session.id)?.status, "stopped");
});

test("PTY employee identity survives snapshots, persistence, and same-id resume", async (t) => {
  const { manager, root, storage, spawned } = createHarness(t);
  t.after(() => manager.dispose());
  const identity = { employeeId: "employee-role", employeeName: "角色伙伴", employeeAvatar: "avatar" };
  const session = await manager.start("pi", root, "managed", "首条消息", {
    provider: "pi", model: "chosen-model", systemPrompt: "角色规则", ...identity,
  });
  spawned[0].emitData("❯");
  assert.deepEqual(spawned[0].writes.slice(-2), ["首条消息", "\r"]);
  for (const snapshot of [session, manager.getOwned(session.id)!, storage.getSession(session.id)!,
    toSessionListItemDTO(session)]) {
    for (const key of Object.keys(identity) as Array<keyof typeof identity>) {
      assert.equal(snapshot[key], identity[key]);
    }
    assert.equal(snapshot.sessionKind, "pty");
    assert.equal(snapshot.selectedModel, "chosen-model");
    assert.equal(snapshot.employeeCandidates, undefined);
  }
  manager.stop(session.id);
  const resumed = await manager.start("pi", root, "managed", undefined, {
    reuseId: session.id, provider: "pi", model: "chosen-model",
  });
  assert.equal(resumed.employeeId, identity.employeeId);
  assert.equal(resumed.employeeName, identity.employeeName);
  assert.equal(resumed.employeeAvatar, identity.employeeAvatar);
  assert.equal(resumed.systemPrompt, "角色规则");
  assert.equal(storage.getSession(session.id)?.employeeId, identity.employeeId);
});

test("PTY sessions hand the system prompt to the CLI's own flag, not to the first input", async (t) => {
  const { manager, root, spawnCalls, spawned } = createHarness(t);
  const session = await manager.start("pi", root, "managed", "首条消息", {
    provider: "pi",
    systemPrompt: "你是合并 Agent，只做清单里的事。",
  });
  assert.equal(session.systemPrompt, "你是合并 Agent，只做清单里的事。");
  const launched = (spawnCalls[0][1] as string[]).at(-1) ?? "";
  assert.match(launched, /--append-system-prompt '你是合并 Agent，只做清单里的事。'/);

  // 首条输入保持原样：提示已经走 flag，不能重复并进消息。
  spawned[0].emitData("❯");
  assert.deepEqual(spawned[0].writes.slice(-2), ["首条消息", "\r"]);
});

test("providers without a system-prompt flag get it prepended to the first input", async (t) => {
  const { manager, root, spawnCalls, spawned } = createHarness(t);
  await manager.start("opencode", root, "managed", "首条消息", {
    provider: "opencode",
    systemPrompt: "你是合并 Agent。",
  });
  const launched = (spawnCalls[0][1] as string[]).at(-1) ?? "";
  assert.doesNotMatch(launched, /--append-system-prompt|--rules/);

  spawned[0].emitData("›");
  assert.equal(
    spawned[0].writes.at(-2),
    "以下是本会话的固定要求（来自系统，不是用户输入，优先级高于后面的内容）：\n\n你是合并 Agent。\n\n---\n\n首条消息",
  );
  assert.equal(spawned[0].writes.at(-1), "\r");
});
