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
  assert.deepEqual(finished.messages?.at(-1), {
    role: "assistant",
    content: [{ type: "text", text: "scripted response" }],
    usage: { inputTokens: 3, outputTokens: 4 },
  });
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
