import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { ClaudeCliRunner } from "../src/structured-claude-adapter.js";
import { ClaudeCliProtocolReducer } from "../src/structured-claude-protocol.js";
import type { StructuredExecHost, StructuredExecProcess, StructuredExitEvent, StructuredSpawnRequest, StructuredStreamEvent } from "../src/structured-exec-host.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { computeRunningSignal } from "../src/web-ui/session-activity.js";
import type { SessionSnapshot } from "../src/types.js";

// Sanitized event shapes from Claude Code 2.1.296. No model/process is invoked.
const result = (systemKilled = 0) => ({ type: "result", subtype: "success", is_error: false,
  result: "Waiting for background agents", subagent_stats: { spawned: 4, completed: 1,
    killed: { parent: 0, user: 0, system: systemKilled } } });

class ControlledHost implements StructuredExecHost {
  readonly persistent = true;
  request?: StructuredSpawnRequest;
  interruptions = 0;
  starts = 0;
  private stream?: (event: StructuredStreamEvent) => void;
  private exitListener?: (event: StructuredExitEvent) => void;
  async spawnStructured(request: StructuredSpawnRequest): Promise<StructuredExecProcess> {
    this.starts++;
    this.request = request;
    return { runId: request.runId, incarnationId: "fixture", pid: 123,
      interrupt: () => { this.interruptions++; this.exit(143, 15); },
      onStream: (listener) => { this.stream = listener; return { dispose() {} }; },
      onExit: (listener) => { this.exitListener = listener; return { dispose() {} }; } };
  }
  event(event: object): void { this.stream!({ stream: "stdout", data: JSON.stringify(event) + "\n", seq: 1 }); }
  exit(exitCode = 0, signal: number | null = null): void { this.exitListener?.({ exitCode, signal }); }
  async attachRun() { return null; }
  async adoptRun() { return null; }
  async listRuns() { return []; }
  forgetRun() {}
}

async function tick(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

function harness(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "wand-claude-bg-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const host = new ControlledHost();
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root }, null, {}, host);
  const session = manager.createSession({ cwd: root, mode: "managed", provider: "claude", runner: "claude-cli-print" });
  manager.setSessionTopic(session.id, "fixture", "fixture");
  t.after(() => { manager.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  return { manager, host, id: session.id };
}

test("Claude print overrides only the parent-idle background deadline and preserves the environment", async () => {
  const host = new ControlledHost();
  const env = { PATH: "/fixture/bin", CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "600000" };
  const execution = new ClaudeCliRunner({}, host).start({ session: {
    id: "fixture", cwd: tmpdir(), mode: "managed", provider: "claude",
  } as SessionSnapshot, prompt: "fixture", env }, { isActive: () => true, onUpdate() {} });
  await tick();
  assert.equal(host.request?.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, "0");
  assert.equal(host.request?.env.PATH, env.PATH);
  assert.equal(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, "600000", "do not mutate the shared environment");
  execution.interrupt();
  await execution.completion;
  assert.equal(host.interruptions, 1, "user cancellation remains available");
});

test("parent results and child progress keep the session running until the CLI actually exits", async (t) => {
  const { manager, host, id } = harness(t);
  const pending = manager.sendMessage(id, "fixture");
  await tick();
  host.event({ type: "assistant", message: { id: "parent", content: [
    { type: "tool_use", name: "Agent", id: "dispatch-a", input: { description: "fixture child" } },
  ] } });
  for (const event of [result(),
    { type: "system", subtype: "task_progress", task_id: "a", tool_use_id: "dispatch-a" }, result()]) {
    host.event(event);
    await tick();
    const live = manager.get(id)!;
    assert.equal(live.status, "running");
    assert.equal(live.structuredState?.inFlight, true);
    assert.equal(computeRunningSignal(live).active, true);
  }
  host.event({ type: "result", subtype: "success", result: "All children completed" });
  host.exit();
  await pending;
  assert.equal(manager.get(id)?.status, "idle");
  assert.equal(manager.get(id)?.structuredState?.inFlight, false);
  assert.equal(manager.get(id)?.structuredState?.lastError, null);
  host.event({ type: "system", subtype: "task_progress", task_id: "late" });
  host.event(result(3));
  await tick();
  assert.equal(manager.get(id)?.status, "idle", "late child traffic cannot reopen or fail a settled turn");
  assert.equal(manager.get(id)?.structuredState?.lastError, null);
});

test("system-killed children cannot become a successful idle turn even with success and exit 0", async (t) => {
  const { manager, host, id } = harness(t);
  const pending = manager.sendMessage(id, "fixture");
  const failed = assert.rejects(pending, /系统停止了 3 个子代理/);
  await tick();
  host.event({ type: "assistant", message: { id: "parent", content: [{ type: "text", text: "Work already performed" }] } });
  host.event(result(3));
  host.event(result(3));
  host.exit();
  await failed;
  const session = manager.get(id)!;
  assert.equal(session.status, "failed");
  assert.equal(session.structuredState?.inFlight, false);
  assert.match(session.structuredState?.lastError ?? "", /任务未完整完成/);
  assert.ok(JSON.stringify(session.messages).includes("Work already performed"));
  assert.equal(host.interruptions, 0);
  assert.equal(host.starts, 1, "executed work must never be automatically replayed");
});

test("background waiting can still be stopped without leaving a stuck running session", async (t) => {
  const { manager, host, id } = harness(t);
  const pending = manager.sendMessage(id, "fixture");
  await tick();
  host.event(result());
  manager.stop(id);
  await pending;
  assert.equal(host.interruptions, 1);
  assert.equal(manager.get(id)?.structuredState?.inFlight, false);
  assert.equal(manager.get(id)?.status, "idle");
  host.event(result());
  await tick();
  assert.equal(manager.get(id)?.structuredState?.inFlight, false, "late parent results cannot undo stop");
});

test("only native Claude system-kill facts mark incomplete work, not prose or user/parent cancellation", () => {
  for (const event of [result(), { ...result(), subagent_stats: { killed: { user: 3, parent: 2 } } },
    { ...result(), subagent_stats: { killed: { system: "3" } } },
    { type: "result", result: "3 agents were system-killed" }]) {
    const reducer = new ClaudeCliProtocolReducer({ provider: "claude" } as SessionSnapshot);
    reducer.apply(event, true);
    assert.equal(reducer.errorText, null);
  }
  const reducer = new ClaudeCliProtocolReducer({ provider: "claude" } as SessionSnapshot);
  reducer.apply(result(3), true);
  reducer.apply(result(), true);
  assert.match(reducer.errorText!, /系统停止了 3 个子代理/);
  assert.equal(reducer.errorResultObserved, false, "not an upstream rejection eligible for fallback");
  const qoder = new ClaudeCliProtocolReducer({ provider: "qoder" } as SessionSnapshot);
  qoder.apply(result(3), true);
  assert.equal(qoder.errorText, null, "do not infer another provider's lifecycle");
});
