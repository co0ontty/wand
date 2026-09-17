import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
} from "../src/structured-runner.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";

class ScriptedOpenCodeRunner implements StructuredRunnerAdapter {
  starts: StructuredRunnerContext[] = [];

  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    this.starts.push(context);
    const state = {
      blocks: [{ type: "text" as const, text: "scripted response" }],
      result: "scripted response",
      sessionId: "scripted-session-id",
      model: "scripted-model",
      usage: { inputTokens: 3, outputTokens: 4 },
    };
    const completion = Promise.resolve().then(() => {
      observer.onEvent?.({ type: "text" });
      observer.onUpdate(state);
      return {
        state,
        exitCode: 0,
        signal: null,
        stderr: "",
        primaryError: null,
      };
    });
    return {
      args: ["run"],
      spawnedAt: "2026-07-15T00:00:00.000Z",
      pid: 42,
      completion,
      interrupt: () => {},
    };
  }
}

class BackgroundPhasePiRunner implements StructuredRunnerAdapter {
  observer: StructuredRunnerObserver | null = null;
  private resolveCompletion: ((value: Awaited<StructuredRunnerExecution["completion"]>) => void) | null = null;
  readonly state = {
    blocks: [{ type: "text" as const, text: "background work started" }],
    result: "background work started",
    sessionId: "pi-session-id",
    phase: "background" as const,
  };

  start(_context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    this.observer = observer;
    const completion = new Promise<Awaited<StructuredRunnerExecution["completion"]>>((resolve) => {
      this.resolveCompletion = resolve;
    });
    return {
      args: ["--mode", "json", "--print"],
      spawnedAt: "2026-07-15T00:00:00.000Z",
      pid: 43,
      completion,
      interrupt: () => {},
    };
  }

  publishBackgroundPhase(): void {
    this.observer?.onUpdate(this.state);
  }

  finish(): void {
    this.resolveCompletion?.({
      state: this.state,
      exitCode: 0,
      signal: null,
      stderr: "",
      primaryError: null,
    });
    this.resolveCompletion = null;
  }
}

class InterruptibleOpenCodeRunner implements StructuredRunnerAdapter {
  interruptCalls = 0;
  private finish: (() => void) | null = null;

  start(context: StructuredRunnerContext): StructuredRunnerExecution {
    const state = { blocks: [], result: "", sessionId: context.session.claudeSessionId };
    const completion = new Promise<Awaited<StructuredRunnerExecution["completion"]>>((resolve) => {
      this.finish = () => resolve({
        state,
        exitCode: null,
        signal: "SIGTERM",
        stderr: "",
        primaryError: null,
      });
    });
    return {
      args: ["run"],
      spawnedAt: "2026-07-15T00:00:00.000Z",
      pid: null,
      completion,
      interrupt: () => {
        this.interruptCalls++;
        this.finish?.();
        this.finish = null;
      },
    };
  }
}

test("StructuredSessionManager drives OpenCode through the runner interface", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-runner-seam-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const runner = new ScriptedOpenCodeRunner();
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root },
    null,
    undefined,
    { opencode: runner },
  );
  t.after(() => {
    manager.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  const session = manager.createSession({ cwd: root, mode: "assist", provider: "opencode" });
  manager.setSessionTopic(session.id, "test", "test");
  const finished = await manager.sendMessage(session.id, "hello adapter");

  assert.equal(runner.starts.length, 1);
  assert.equal(runner.starts[0].prompt, "hello adapter");
  assert.equal(finished.status, "idle");
  assert.equal(finished.output, "scripted response");
  assert.equal(finished.claudeSessionId, "scripted-session-id");
  assert.equal(finished.structuredState?.model, "scripted-model");
  const lastTurn = finished.messages?.at(-1);
  assert.equal(lastTurn?.role, "assistant");
  assert.deepEqual(lastTurn?.content, [{ type: "text", text: "scripted response" }]);
  assert.deepEqual(lastTurn?.usage, { inputTokens: 3, outputTokens: 4 });
  // 聊天时间戳是新增字段：完成态必须同时给出开始与结束的 ISO 时间。
  assert.match(String(lastTurn?.createdAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.match(String(lastTurn?.completedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test("StructuredSessionManager drives Codex through the runner interface", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-codex-runner-seam-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const runner = new ScriptedOpenCodeRunner();
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root },
    null,
    undefined,
    { codex: runner },
  );
  t.after(() => {
    manager.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  const session = manager.createSession({ cwd: root, mode: "assist", provider: "codex" });
  manager.setSessionTopic(session.id, "test", "test");
  const finished = await manager.sendMessage(session.id, "hello codex adapter");

  assert.equal(runner.starts.length, 1);
  assert.equal(runner.starts[0].prompt, "hello codex adapter");
  assert.equal(finished.status, "idle");
  assert.equal(finished.output, "scripted response");
  assert.equal(finished.claudeSessionId, "scripted-session-id");
});

test("StructuredSessionManager drives Claude CLI through the runner interface", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-claude-runner-seam-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const runner = new ScriptedOpenCodeRunner();
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root },
    null,
    undefined,
    { claudeCli: runner },
  );
  t.after(() => {
    manager.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  const session = manager.createSession({
    cwd: root,
    mode: "assist",
    provider: "claude",
    runner: "claude-cli-print",
  });
  manager.setSessionTopic(session.id, "test", "test");
  const finished = await manager.sendMessage(session.id, "hello claude adapter");

  assert.equal(runner.starts.length, 1);
  assert.equal(runner.starts[0].prompt, "hello claude adapter");
  assert.equal(finished.output, "scripted response");
  assert.equal(finished.claudeSessionId, "scripted-session-id");
});

test("StructuredSessionManager exposes Pi background draining until the CLI exits", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-pi-background-phase-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const runner = new BackgroundPhasePiRunner();
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root },
    null,
    undefined,
    { pi: runner },
  );
  t.after(() => {
    manager.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  const session = manager.createSession({ cwd: root, mode: "assist", provider: "pi" });
  manager.setSessionTopic(session.id, "test", "test");
  const pending = manager.sendMessage(session.id, "delegate work");
  await Promise.resolve();
  runner.publishBackgroundPhase();

  const draining = manager.get(session.id);
  assert.equal(draining?.status, "running");
  assert.equal(draining?.structuredState?.inFlight, true);
  assert.equal(draining?.structuredState?.phase, "background");

  runner.finish();
  const finished = await pending;
  assert.equal(finished.status, "idle");
  assert.equal(finished.structuredState?.inFlight, false);
  assert.equal(finished.structuredState?.phase, undefined);
});

test("StructuredSessionManager interrupts OpenCode without accessing its process handle", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-runner-interrupt-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const runner = new InterruptibleOpenCodeRunner();
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root },
    null,
    undefined,
    { opencode: runner },
  );
  t.after(() => {
    manager.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  const session = manager.createSession({ cwd: root, mode: "assist", provider: "opencode" });
  manager.setSessionTopic(session.id, "test", "test");
  const pending = manager.sendMessage(session.id, "wait");
  const stopped = manager.stop(session.id);
  const completed = await pending;

  assert.equal(runner.interruptCalls, 1);
  assert.equal(stopped.status, "idle");
  assert.equal(completed.status, "idle");
  assert.equal(completed.structuredState?.inFlight, false);
});

test("StructuredSessionManager interrupts Codex without accessing its process handle", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-codex-runner-interrupt-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const runner = new InterruptibleOpenCodeRunner();
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), defaultCwd: root },
    null,
    undefined,
    { codex: runner },
  );
  t.after(() => {
    manager.dispose();
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  const session = manager.createSession({ cwd: root, mode: "assist", provider: "codex" });
  manager.setSessionTopic(session.id, "test", "test");
  const pending = manager.sendMessage(session.id, "wait");
  const stopped = manager.stop(session.id);
  const completed = await pending;

  assert.equal(runner.interruptCalls, 1);
  assert.equal(stopped.status, "idle");
  assert.equal(completed.status, "idle");
  assert.equal(completed.structuredState?.inFlight, false);
});
