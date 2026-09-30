import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerExecution,
  StructuredRunnerTurnState,
} from "../src/structured-runner.js";
import type { SessionProvider, SessionRunner, SessionSnapshot } from "../src/types.js";

/**
 * 结构化回合的「不落盘、等测试放行」runner：interrupt() 只记账（模拟杀不死的子进程），
 * completion 由测试显式 finish() 释放，用来验证并发/取消的时序语义。
 */
class DeferredClaudeCliRunner implements StructuredRunnerAdapter {
  readonly starts: string[] = [];
  interruptCalls = 0;
  private readonly releases: Array<() => void> = [];

  start(context: { prompt: string }): StructuredRunnerExecution {
    this.starts.push(context.prompt);
    const state: StructuredRunnerTurnState = {
      blocks: [],
      result: "",
      sessionId: `deferred-session-${this.starts.length}`,
    };
    const completion = new Promise<Awaited<StructuredRunnerExecution["completion"]>>((resolve) => {
      this.releases.push(() => resolve({
        state,
        exitCode: null,
        signal: "SIGTERM",
        stderr: "",
        primaryError: null,
      }));
    });
    return {
      args: ["-p"],
      spawnedAt: new Date().toISOString(),
      pid: null,
      completion,
      interrupt: () => {
        this.interruptCalls++;
      },
    };
  }

  /** 释放一次回合（默认最新一次），等价于子进程退出。 */
  finish(index = this.releases.length - 1): void {
    const release = this.releases[index];
    if (!release) return;
    this.releases[index] = () => {};
    release();
  }

  finishAll(): void {
    for (let index = 0; index < this.releases.length; index++) this.finish(index);
  }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function createHarness(t: TestContext, runner: SessionRunner = "claude-cli-print") {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-structured-generation-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const claudeRunner = new DeferredClaudeCliRunner();
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root },
    null,
    { claudeCli: claudeRunner },
  );
  const session = manager.createSession({
    cwd: root,
    mode: "assist",
    provider: "claude",
    runner,
  });
  manager.setSessionTopic(session.id, "test", "test");

  t.after(() => {
    // dispose 先把会话标为 idle，迟到的 completion 不会再写已关闭的库。
    manager.dispose();
    claudeRunner.finishAll();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { manager, claudeRunner, session };
}

test("Claude CLI in-flight turns queue a second message instead of starting concurrently", async (t) => {
  const { manager, claudeRunner, session } = createHarness(t);

  const firstRun = manager.sendMessage(session.id, "first");
  await waitFor(() => claudeRunner.starts.length === 1, "first turn did not start");
  const firstRequestId = manager.get(session.id)?.structuredState?.activeRequestId;

  const queued = await manager.sendMessage(session.id, "second");
  assert.equal(claudeRunner.starts.length, 1);
  assert.deepEqual(queued.queuedMessages, ["second"]);
  assert.equal(queued.structuredState?.activeRequestId, firstRequestId);
  assert.equal(queued.structuredState?.inFlight, true);

  manager.stop(session.id);
  claudeRunner.finish();
  await firstRun;
});

test("a stopped turn cannot overwrite or release a newer turn", async (t) => {
  const { manager, claudeRunner, session } = createHarness(t);

  const firstRun = manager.sendMessage(session.id, "first");
  await waitFor(() => claudeRunner.starts.length === 1, "first turn did not start");
  manager.stop(session.id);

  const secondRun = manager.sendMessage(session.id, "second");
  await waitFor(() => claudeRunner.starts.length === 2, "second turn did not start");
  const secondRequestId = manager.get(session.id)?.structuredState?.activeRequestId;
  assert.ok(secondRequestId);

  // Let the stopped turn unwind only after the replacement owns the maps.
  claudeRunner.finish(0);
  await firstRun;

  const afterOldClose = manager.get(session.id);
  assert.equal(afterOldClose?.structuredState?.activeRequestId, secondRequestId);
  assert.equal(afterOldClose?.structuredState?.inFlight, true);

  const queued = await manager.sendMessage(session.id, "third");
  assert.equal(claudeRunner.starts.length, 2, "old cleanup removed the replacement execution");
  assert.deepEqual(queued.queuedMessages, ["third"]);

  manager.stop(session.id);
  claudeRunner.finish();
  await secondRun;
});

test("legacy claude-sdk sessions run through the injected Claude CLI runner", async (t) => {
  const { manager, claudeRunner, session } = createHarness(t, "claude-sdk");
  assert.equal(session.runner, "claude-cli-print", "legacy SDK sessions normalize to the CLI runner");

  const run = manager.sendMessage(session.id, "use the injected runner");
  await waitFor(() => claudeRunner.starts.length === 1, "legacy session did not use the CLI runner");
  assert.deepEqual(claudeRunner.starts, ["use the injected runner"]);

  manager.stop(session.id);
  claudeRunner.finish();
  await run;
});

test("session creation validates provider-runner combinations and applies defaults", (t) => {
  const { manager } = createHarness(t);
  const base = { cwd: os.tmpdir(), mode: "assist" as const };

  assert.equal(manager.createSession({ ...base, provider: "claude" }).runner, "claude-cli-print");
  assert.equal(manager.createSession({ ...base, provider: "claude", runner: "claude-cli-print" }).runner, "claude-cli-print");
  assert.equal(manager.createSession({ ...base, provider: "claude", runner: "claude-sdk" }).runner, "claude-cli-print");
  assert.equal(manager.createSession({ ...base, provider: "codex" }).runner, "codex-cli-exec");
  assert.equal(manager.createSession({ ...base, provider: "opencode" }).runner, "opencode-cli-run");
  assert.equal(manager.createSession({ ...base, provider: "grok" }).runner, "grok-cli-headless");
  assert.equal(manager.createSession({ ...base, provider: "qoder" }).runner, "qoder-cli-print");
  assert.equal(manager.createSession({ ...base, provider: "pi" }).runner, "pi-cli-json");

  const runners: SessionRunner[] = [
    "claude-cli",
    "claude-cli-print",
    "codex-cli-exec",
    "opencode-cli-run",
    "grok-cli-headless",
    "qoder-cli-print",
    "pi-cli-json",
    "pty",
  ];
  const allowed: Record<SessionProvider, SessionRunner[]> = {
    claude: ["claude-cli-print"],
    codex: ["codex-cli-exec"],
    opencode: ["opencode-cli-run"],
    grok: ["grok-cli-headless"],
    qoder: ["qoder-cli-print"],
    pi: ["pi-cli-json"],
  };
  for (const provider of ["claude", "codex", "opencode", "grok", "qoder", "pi"] as const) {
    for (const runner of runners) {
      if (allowed[provider].includes(runner)) continue;
      assert.throws(
        () => manager.createSession({ ...base, provider, runner }),
        /不支持 provider/,
        `${provider} should reject ${runner}`,
      );
    }
  }
});

test("an interrupted runner stays in-flight until its owning completion releases it", async (t) => {
  const { manager, session } = createHarness(t);
  let killCalls = 0;
  const fakeExecution = {
    interrupt: () => {
      killCalls++;
    },
  };
  const internal = manager as unknown as {
    sessions: Map<string, SessionSnapshot>;
    pendingRunnerExecutions: Map<string, unknown>;
  };
  internal.sessions.set(session.id, {
    ...session,
    status: "running",
    structuredState: {
      ...(session.structuredState as NonNullable<SessionSnapshot["structuredState"]>),
      inFlight: true,
      activeRequestId: "request-before-close",
    },
  });
  internal.pendingRunnerExecutions.set(session.id, fakeExecution);

  const queued = await manager.sendMessage(session.id, "wait for close");
  assert.deepEqual(queued.queuedMessages, ["wait for close"]);
  assert.equal(queued.structuredState?.activeRequestId, "request-before-close");

  manager.stop(session.id);
  assert.equal(killCalls, 1);
});

test("Claude CLI AskUserQuestion SIGTERM finishes as a waiting turn, not a failure", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-structured-cli-ask-"));
  const binDir = path.join(root, "bin");
  const claudePath = path.join(binDir, "claude");
  const originalPath = process.env.PATH;
  mkdirSync(binDir);
  writeFileSync(claudePath, `#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"type":"assistant","session_id":"22222222-2222-4222-8222-222222222222","message":{"id":"assistant-ask","content":[{"type":"tool_use","id":"ask-cli-1","name":"AskUserQuestion","input":{"questions":[{"question":"Choose","options":["one","two"]}]}}]}}'
exec sleep 30
`, "utf8");
  chmodSync(claudePath, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

  const storage = new WandStorage(path.join(root, "wand.db"));
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root, inheritEnv: true },
  );
  const session = manager.createSession({
    cwd: root,
    mode: "assist",
    provider: "claude",
    runner: "claude-cli-print",
  });
  manager.setSessionTopic(session.id, "test", "test");
  t.after(() => {
    manager.dispose();
    storage.close();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  });

  const waiting = await manager.sendMessage(session.id, "ask me");
  assert.equal(waiting.status, "running");
  assert.equal(waiting.structuredState?.inFlight, false);
  assert.equal(waiting.structuredState?.lastError, null);
  assert.ok(waiting.messages?.at(-1)?.content.some(
    (block) => block.type === "tool_use" && block.name === "AskUserQuestion",
  ));
});

test("queued messages survive queue operations", async (t) => {
  const { manager, claudeRunner, session } = createHarness(t);
  const run = manager.sendMessage(session.id, "first");
  await waitFor(() => claudeRunner.starts.length === 1, "first turn did not start");

  await manager.sendMessage(session.id, "second");
  await manager.sendMessage(session.id, "third");
  assert.deepEqual(manager.get(session.id)?.queuedMessages, ["second", "third"]);

  manager.reorderQueuedMessages(session.id, [1, 0]);
  assert.deepEqual(manager.get(session.id)?.queuedMessages, ["third", "second"]);

  assert.throws(
    () => manager.deleteQueuedMessage(session.id, 0, "second"),
    /排队消息已变化/,
  );
  assert.deepEqual(manager.get(session.id)?.queuedMessages, ["third", "second"]);

  manager.deleteQueuedMessage(session.id, 0, "third");
  assert.deepEqual(manager.get(session.id)?.queuedMessages, ["second"]);

  manager.stop(session.id);
  claudeRunner.finish();
  await run;
});

test("structured escalation resolution validates pending request and preserves resolution", (t) => {
  const { manager, session } = createHarness(t);
  const internal = manager as unknown as { sessions: Map<string, SessionSnapshot> };

  assert.throws(
    () => manager.resolveEscalation(session.id, "missing", "approve_once"),
    /没有待处理/,
  );

  internal.sessions.set(session.id, {
    ...session,
    permissionBlocked: true,
    pendingEscalation: {
      requestId: "request-1",
      scope: "run_command",
      runner: "json",
      source: "tool_permission_request",
      reason: "run tests",
    },
  });

  assert.throws(
    () => manager.resolveEscalation(session.id, "stale-request", "approve_once"),
    /已失效/,
  );
  assert.throws(
    () => manager.resolveEscalation(session.id, "request-1", "approve_everything"),
    /resolution 必须/,
  );
  assert.equal(manager.get(session.id)?.pendingEscalation?.requestId, "request-1");
  assert.equal(manager.get(session.id)?.approvalStats?.total, 0);

  const approved = manager.resolveEscalation(session.id, "request-1", "approve_turn");
  assert.equal(approved.pendingEscalation, null);
  assert.equal(approved.permissionBlocked, false);
  assert.deepEqual(approved.lastEscalationResult, {
    requestId: "request-1",
    resolution: "approve_turn",
    reason: "user_approved",
  });
  assert.equal(approved.approvalStats?.command, 1);
  assert.equal(approved.approvalStats?.total, 1);
});
