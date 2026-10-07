import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { WandStorage } from "../../src/storage.js";
import { AiTeamRunner, type AiTeamSessionOps } from "../../src/ai-team-runner.js";
import { ConversationService } from "../../src/conversation-service.js";
import { employeeConversationId } from "../../src/conversation-types.js";
import { registerConversationRoutes } from "../../src/server-conversation-routes.js";
import { parseAiTeamInput } from "../../src/server-ai-team-routes.js";
import { buildLeaderKickoffPrompt, parseLeaderDecision } from "../../src/ai-team-prompts.js";
import type { AiTeam, AiTeamRun, SiliconEmployee } from "../../src/ai-team-types.js";
import type { SessionSnapshot, ConversationTurn, WandConfig } from "../../src/types.js";
import type { StructuredSessionManager } from "../../src/structured-session-manager.js";

// Explicit protocol/execution doubles. This test never invokes a real model/provider or CLI.
export function conversationHarness(t: Pick<TestContext, "after">) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-conversations-"));
  const cwd = path.join(root, "workspace"); mkdirSync(cwd);
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true }); });
  const config = { defaultCwd: cwd, defaultMode: "full-access" } as WandConfig;
  const sessions = new Map<string, SessionSnapshot>();
  const executions: Array<Parameters<AiTeamSessionOps["open"]>[0] & { id: string }> = [];
  const sent: Array<{ id: string; text: string }> = [];
  const structured = {
    createSession(options) {
      const s = { id: randomUUID(), sessionKind: "structured", command: "explicit-test-double", status: "idle", exitCode: null,
        cwd, mode: "full-access", worktreeEnabled: false, worktree: null, startedAt: new Date().toISOString(), endedAt: null,
        output: "", archived: false, archivedAt: null, claudeSessionId: null, selectedModel: options.model ?? null,
        messages: [], queuedMessages: [], structuredState: { inFlight: false, activeRequestId: null, lastError: null, runner: "pi-cli" }, ...options } as SessionSnapshot;
      sessions.set(s.id, s); storage.saveSession(s); return s;
    },
    createRelaySession(options) { return this.createSession(options); },
    get(id) { return sessions.get(id) ?? null; },
    async sendMessage(id, text) {
      const s = sessions.get(id)!; sent.push({ id, text });
      const next = { ...s, messages: [...s.messages!, { role: "user", createdAt: new Date().toISOString(), content: [{ type: "text", text }] },
        { role: "assistant", createdAt: new Date(Date.now() + 1).toISOString(), content: [{ type: "text", text: "明确测试替身回复" }] }] } as SessionSnapshot;
      sessions.set(id, next); storage.saveSession(next); return next;
    },
    appendRelayTurns(id, turns) {
      const s = sessions.get(id)!;
      const next = { ...s, messages: [...s.messages!, ...turns.map(turn => ({ ...turn, createdAt: turn.createdAt ?? new Date().toISOString() }))] };
      sessions.set(id, next); storage.saveSession(next); return next;
    },
  } satisfies Pick<StructuredSessionManager, "createSession" | "createRelaySession" | "get" | "sendMessage" | "appendRelayTurns">;
  const ops: AiTeamSessionOps = {
    async open(input) {
      const s = structured.createSession({ cwd: input.task.workspaceId ? storage.getWorkspace(input.task.workspaceId)!.cwd : cwd,
        mode: input.agent.mode, provider: input.agent.provider, model: input.agent.model, systemPrompt: input.systemPrompt,
        employeeId: input.employee?.id, workspaceId: input.task.workspaceId ?? undefined, workspaceTaskId: input.task.workspaceTaskId ?? undefined });
      sessions.set(s.id, { ...s, status: "running", structuredState: { ...s.structuredState!, inFlight: true } });
      executions.push({ ...input, id: s.id }); return s.id;
    },
    async send(id, text) { const s = sessions.get(id)!; sent.push({ id, text }); sessions.set(id, { ...s, structuredState: { ...s.structuredState!, inFlight: true } }); },
    stop(id) { const s = sessions.get(id)!; sessions.set(id, { ...s, status: "stopped" }); },
    snapshot: id => sessions.get(id) ?? storage.getSession(id), ownerOf: id => sessions.has(id) ? "structured" : "storage",
  };
  let service: ConversationService;
  const runner = new AiTeamRunner({ storage, ops, resolveCwd: () => cwd, now: () => Date.now() + 5000,
    chat: { open: ({ title }) => structured.createRelaySession({ cwd, mode: "full-access", provider: "pi", title, automationId: "test-relay" }).id,
      post: (id, turns) => { structured.appendRelayTurns(id, turns); } },
  });
  service = new ConversationService({ storage, structured, runner, config, deleteSession: id => { sessions.delete(id); storage.deleteSession(id); } });
  const workspace = storage.createWorkspace({ name: "测试项目", cwd });
  for (let n = 1; n <= 4; n++) storage.saveSiliconEmployee({ id: `e_test_${n}`, name: `员工 ${n}`, duty: `职责 ${n}`, prompt: `仅员工 ${n} 的角色`,
    avatar: "", agents: [{ provider: "pi", model: "explicit-test-model", thinkingEffort: "off", mode: "full-access", kind: "structured", engine: "sdk" }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const template = parseAiTeamInput({ name: "开发四人组", description: "预设", instructions: "只做指派范围", requirePlanApproval: true, maxSteps: 15,
    members: storage.listSiliconEmployees().map((e, i) => ({ id: `m_test${i}`, employeeId: e.id, duty: `群职责 ${i}`, isLeader: i === 0, role: i === 0 ? "plan" : "work" })) }, null, new Date().toISOString(), storage);
  storage.saveAiTeam(template);
  t.after(() => { runner.dispose(); });
  const group = async (input = { employeeIds: ["e_test_1"] }) => {
    const receipt = await service.createGroup(randomUUID(), input); assert.equal(receipt.state, "accepted", receipt.error); return receipt.conversationId;
  };
  const dispatch = async (id: string, title: string) => {
    const receipt = await service.dispatch(id, randomUUID(), { title, description: `${title} 的明确任务`, workspaceId: workspace.id });
    assert.equal(receipt.state, "accepted", receipt.error); assert.ok(receipt.runId); await runner.idle(); return receipt;
  };
  // `config` 暴露出来，便于测试切换用户资料等运行期偏好。
  return { storage, service, runner, sessions, structured, sent, executions, cwd, config, workspace, template, group, dispatch };
}
