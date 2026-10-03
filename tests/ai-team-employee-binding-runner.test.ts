import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AiTeamRunner, type AiTeamSessionOps } from "../src/ai-team-runner.js";
import type { SiliconEmployee } from "../src/ai-team-types.js";
import { parseAiTeamInput } from "../src/server-ai-team-routes.js";
import { WandStorage } from "../src/storage.js";
import type { WandTaskAgent } from "../src/task-types.js";
import type { SessionSnapshot } from "../src/types.js";

const agent = (provider: WandTaskAgent["provider"]): WandTaskAgent => ({
  provider, model: "default", thinkingEffort: "off", mode: "full-access", kind: "structured",
});
const employee = (id: string, agents: WandTaskAgent[]): SiliconEmployee => ({
  id, name: id, avatar: "cat:2", prompt: `ROLE_${id}`, duty: "员工职责", agents,
  createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z",
});

test("team worker dispatch owns the only safe pre-open fallback, freezes unused employees, and does not resend unknown delivery", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "wand-team-worker-binding-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const attempts: Array<Parameters<AiTeamSessionOps["open"]>[0]> = [];
  const sessions = new Map<string, SessionSnapshot>();
  const ops: AiTeamSessionOps = {
    async open(input) {
      attempts.push(input);
      if (input.employee?.id === "e_worker" && input.employeeCandidateIndex === 0) throw new Error("spawn codex ENOENT");
      const id = `session_${attempts.length}`;
      sessions.set(id, { id, employeeId: input.employee?.id, provider: input.agent.provider,
        status: "running", messages: [], structuredState: { inFlight: true }, output: "" } as SessionSnapshot);
      return id;
    },
    async send() {}, stop() {}, snapshot: (id) => sessions.get(id) ?? null, ownerOf: () => "structured",
  };
  storage.saveSiliconEmployee(employee("e_leader", [agent("claude")]));
  storage.saveSiliconEmployee(employee("e_worker", [agent("codex"), agent("pi"), agent("grok")]));
  const team = parseAiTeamInput({ name: "绑定团队", requirePlanApproval: false, members: [
    { id: "m_lead", employeeId: "e_leader", isLeader: true, duty: "派工" },
    { id: "m_worker", employeeId: "e_worker", duty: "实现", role: "work" },
  ] }, null, new Date().toISOString(), storage);
  storage.saveAiTeam(team);
  const task = storage.createWandTask({ title: "实际步骤" });
  const runner = new AiTeamRunner({ storage, ops, resolveCwd: () => root });
  t.after(() => { runner.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  const detail = await runner.start({ teamId: team.id, taskId: task.id });
  // Even an employee not yet dispatched keeps the new-run snapshot.
  storage.saveSiliconEmployee({ ...employee("e_worker", [agent("grok")]), prompt: "CHANGED_ROLE", name: "新名字" });
  const leader = storage.listAiTeamSteps(detail.run.id)[0]!;
  const file = path.join(root, leader.reportPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ action: "assign", message: "开始", steps: [
    { member: "m_worker", title: "实现", instructions: "执行实现" },
  ] }));
  const past = new Date(Date.now() - 10_000); utimesSync(file, past, past);
  sessions.get(leader.sessionId!)!.structuredState!.inFlight = false;
  runner.ingest({ type: "status", sessionId: leader.sessionId! });
  await runner.idle();
  const workerAttempts = attempts.filter((attempt) => attempt.employee?.id === "e_worker");
  assert.equal(workerAttempts.length, 2);
  assert.deepEqual(workerAttempts.map((attempt) => attempt.employeeCandidateIndex), [0, 1]);
  assert.deepEqual(workerAttempts.map((attempt) => attempt.agent.provider), ["codex", "pi"]);
  assert.equal(workerAttempts[1]!.employee!.name, "e_worker");
  assert.ok(workerAttempts[1]!.systemPrompt!.includes("ROLE_e_worker"));
  assert.ok(!workerAttempts[1]!.systemPrompt!.includes("CHANGED_ROLE"));
  assert.ok(!workerAttempts[1]!.prompt.includes("ROLE_e_worker"));
  const running = storage.listAiTeamSteps(detail.run.id).find((step) => step.kind === "work" && step.status === "running")!;
  assert.equal(running.dispatchInfo!.usedCandidate, 1);
  const marker = storage.listAiTeamStepSessionMarkers().get(running.sessionId!)!;
  assert.equal(marker.memberId, "m_worker");
  assert.equal(marker.memberName, "新名字", "only the current name projection follows employee edits");
  const session = sessions.get(running.sessionId!)!;
  session.status = "failed";
  session.structuredState!.inFlight = false;
  session.structuredState!.lastError = "unknown model after input accepted";
  runner.ingest({ type: "status", sessionId: running.sessionId! });
  await runner.idle();
  assert.equal(attempts.filter((attempt) => attempt.employee?.id === "e_worker").length, 2,
    "an opened employee session is never retried using error-text/startup-window heuristics");
  assert.equal(storage.listAiTeamSteps(detail.run.id).find((step) => step.id === running.id)!.status, "failed");
  storage.deleteSiliconEmployee("e_worker");
  assert.equal(storage.listAiTeamStepSessionMarkers().get(running.sessionId!)!.memberName, "e_worker");
});
