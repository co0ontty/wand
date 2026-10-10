import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentDispatchPreflightError, dispatchAgentForTask, sendToAgentSession, stopAgentSession } from "../src/agent-dispatch.js";
import { WAND_LOCAL_DECISION_MODEL } from "../src/decision-expert-identity.js";
import { WandStorage } from "../src/storage.js";
import type { ProcessManager } from "../src/process-manager.js";
import type { SessionRegistry } from "../src/session-registry.js";
import type { StructuredSessionManager } from "../src/structured-session-manager.js";

function fakes(owner: "structured" | "pty") {
  const calls: unknown[][] = [];
  const processes = {
    async sendInputConfirmed(...args: unknown[]) { calls.push(["pty", ...args]); },
    stop(id: string) { calls.push(["pty-stop", id]); },
  } as unknown as ProcessManager;
  const structured = {
    sendMessage(...args: unknown[]) { calls.push(["structured", ...args]); return Promise.resolve(); },
    stop(id: string) { calls.push(["structured-stop", id]); },
  } as unknown as StructuredSessionManager;
  const sessions = { ownerOf: () => owner } as unknown as SessionRegistry;
  return { calls, deps: { processes, structured, sessions } };
}

test("PTY messages are written as text followed by a separate carriage return", async () => {
  const { calls, deps } = fakes("pty");
  await sendToAgentSession(deps, "s1", "hello");
  assert.deepEqual(calls, [
    ["pty", "s1", "hello", "terminal"],
    ["pty", "s1", "\r", "terminal", "enter_text"],
  ]);
});

test("structured messages and stops route by session owner", async () => {
  const { calls, deps } = fakes("structured");
  await sendToAgentSession(deps, "s2", "hi");
  stopAgentSession(deps, "s2");
  assert.deepEqual(calls, [["structured", "s2", "hi"], ["structured-stop", "s2"]]);
});


test("dispatchAgentForTask hands the session system prompt to the runner instead of the first message", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-agent-dispatch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => storage.close());
  const created: Array<Record<string, unknown>> = [];
  const sent: unknown[][] = [];
  const structured = {
    createSession(options: Record<string, unknown>) {
      created.push(options);
      // 绑回任务卡要求会话已入库，这里存一份最小快照冒充结构化会话。
      const session = {
        id: "s1", sessionKind: "structured" as const, sessionSource: "automation" as const,
        provider: "pi" as const, runner: "pi-cli-json" as const, command: "pi --mode json --print",
        cwd: root, mode: "managed" as const, status: "running" as const, exitCode: null,
        startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, output: "", archived: false,
        archivedAt: null, claudeSessionId: null,
      };
      storage.saveSession(session);
      return session;
    },
    sendMessage(...args: unknown[]) {
      sent.push(args);
      return Promise.resolve();
    },
  } as unknown as StructuredSessionManager;
  const task = storage.createWandTask({ title: "给 README 加安装说明", description: "写清楚 npm 安装" });
  await dispatchAgentForTask(
    { storage, config: { defaultCwd: root } as never, structured, processes: null },
    {
      task,
      agent: { provider: "pi", model: "default", thinkingEffort: "off", mode: "managed", kind: "structured" },
      prompt: "本轮要求：写计划。",
      automationId: "ai-team:r1",
      systemPrompt: "你是 AI 团队「三人组」的负责人。",
    },
  );
  assert.equal(created[0]!.systemPrompt, "你是 AI 团队「三人组」的负责人。");
  assert.equal(created[0]!.sessionSource, "automation");
  assert.deepEqual(sent, [["s1", "本轮要求：写计划。"]]);
  assert.deepEqual(storage.listWandTaskSessionIds(task.id), ["s1"]);
});

test("LAYA dispatch is explicitly rejected before creating or binding a session or starting inference", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-agent-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => storage.close());
  const task = storage.createWandTask({ title: "不把 LAYA 当聊天模型" });
  let started = 0;
  const structured = {
    createSession() { started += 1; throw new Error("must not create"); },
    resolveNewSessionPiEngine() { started += 1; throw new Error("must not resolve harness"); },
    sendMessage() { started += 1; throw new Error("must not send"); },
  } as unknown as StructuredSessionManager;
  const agent = { provider: "pi" as const, engine: "sdk" as const, model: WAND_LOCAL_DECISION_MODEL,
    thinkingEffort: "off" as const, mode: "default" as const, kind: "structured" as const };
  await assert.rejects(dispatchAgentForTask({ storage, config: { defaultCwd: root } as never, structured, processes: null },
    { task, agent, prompt: "mock-only", automationId: "ai-team:preflight" }), (error: unknown) => {
      assert.ok(error instanceof AgentDispatchPreflightError);
      assert.deepEqual(error.failure, { kind: "preflight", delivery: "rejected", retryable: true });
      return true;
    });
  assert.equal(started, 0);
  assert.deepEqual(storage.listWandTaskSessionIds(task.id), []);
});
