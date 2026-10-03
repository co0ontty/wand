import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAiTeamDeliverySummary, AI_TEAM_DELIVERY_FILES_LIMIT } from "../src/ai-team-delivery.js";
import { AiTeamRunner } from "../src/ai-team-runner.js";
import type { AiTeam, AiTeamRun, AiTeamStep } from "../src/ai-team-types.js";
import { WandStorage } from "../src/storage.js";
import type { WandTaskAgent } from "../src/task-types.js";
import type { ConversationTurn, SessionSnapshot } from "../src/types.js";

const agent: WandTaskAgent = { provider: "pi", model: "default", thinkingEffort: "off", mode: "full-access", kind: "structured" };
const now = "2026-10-03T00:00:00.000Z";
function team(): AiTeam {
  return { id: "team_delivery", name: "交付测试", description: "", instructions: "", requirePlanApproval: true, maxSteps: 30,
    createdAt: now, updatedAt: now, members: [
      { id: "m_lead", name: "负责人", duty: "", agents: [agent], agent, isLeader: true },
      { id: "m_work", name: "当前员工名", duty: "", agents: [agent], agent, isLeader: false },
    ] };
}
function run(): AiTeamRun {
  return { id: "run_delivery", teamId: "team_delivery", team: team(), taskId: "task_delivery", objective: "验收交付", cwd: "/tmp/wand-delivery-cwd",
    status: "done", statusDetail: "负责人已交付说明，不等于服务端验证测试成功。", stepsUsed: 3, stepLimit: 30,
    formatRetries: 0, planApproved: true, chatSessionId: "chat_delivery", pendingNotes: [], createdAt: now, updatedAt: now };
}
function step(seq: number, patch: Partial<AiTeamStep> = {}): AiTeamStep {
  return { id: `step_${seq}`, runId: "run_delivery", seq, kind: "work", memberId: "m_work", title: `步骤 ${seq}`, instructions: "", sessionId: null,
    status: "done", dependsOn: [], report: "旧报告正文，不能当成实际文件", reportPath: `missing-${seq}.md`, startedAt: now, endedAt: now, ...patch };
}
function delivery(seq: number, patch: Partial<ConversationTurn> = {}): ConversationTurn {
  return { role: "assistant", content: [], author: { id: "m_work", name: "历史员工名" }, createdAt: now,
    reportFile: { stepId: `step_${seq}`, path: `/tmp/wand-delivery-cwd/report-${seq}.md`, name: `report-${seq}.md`, size: 42,
      preview: { title: "冻结标题", excerpt: "冻结的真实交付摘录" } }, ...patch };
}
function summary(r = run(), steps = [step(1)], relayTurns = [delivery(1)]) {
  return buildAiTeamDeliverySummary({ run: r, steps, displayTeam: team(), relayTurns, memberStates: {} });
}

test("delivery only projects recorded final statements and frozen file metadata without IO or mutation", () => {
  const r = run(); const steps = [step(1)]; const turns = [delivery(1)];
  const before = structuredClone({ r, steps, turns });
  const result = summary(r, steps, turns);
  assert.equal(result.conclusion, r.statusDetail); assert.equal(result.updatedAt, now);
  assert.equal(result.files[0].memberName, "当前员工名");
  assert.deepEqual(result.files[0].file, turns[0].reportFile);
  assert.equal(result.attention, null, "completed runs do not invent unread/acceptance state");
  assert.deepEqual({ r, steps, turns }, before);
  assert.equal(result.files[0].file.path, "/tmp/wand-delivery-cwd/report-1.md", "metadata is usable without reading a now-missing file");
});

test("cross-run, unmatched, failed, leader, user and wrong-author records never become delivery files", () => {
  const turns = [delivery(1), delivery(2), delivery(3), delivery(4), delivery(5, { role: "user" }), delivery(6, { author: { id: "m_other", name: "其他员工" } })];
  const result = summary(run(), [step(1), step(2, { runId: "other_run" }), step(3, { status: "failed" }), step(4, { kind: "leader" }), step(5), step(6)], turns);
  assert.deepEqual(result.files.map(file => file.stepId), ["step_1"]);
});

test("old data is not backfilled from a report string or path and missing previews remain absent", () => {
  assert.equal(summary(run(), [step(1)], []).totalFiles, 0);
  const turn = delivery(1); delete turn.reportFile!.preview;
  const result = summary(run(), [step(1)], [turn]);
  assert.equal(result.files[0].file.preview, undefined);
  assert.equal(result.files[0].file.name, "report-1.md");
});

test("delivery is bounded with truthful totals and a later empty preview cannot overwrite a complete one", () => {
  const r = run(); r.statusDetail = "结论".repeat(1000);
  const steps = Array.from({ length: 25 }, (_, i) => step(i + 1));
  const turns = steps.map(s => delivery(s.seq));
  const duplicate = delivery(25); delete duplicate.reportFile!.preview; turns.push(duplicate);
  const result = summary(r, steps, turns);
  assert.equal(result.totalFiles, 25); assert.equal(result.files.length, AI_TEAM_DELIVERY_FILES_LIMIT);
  assert.equal(result.files[0].seq, 25); assert.equal(result.files[0].file.preview!.excerpt, "冻结的真实交付摘录");
  assert.ok(result.conclusion!.length <= 600);
  const emojiRun = run(); emojiRun.statusDetail = "🙂".repeat(400);
  const emoji = summary(emojiRun, [], []).conclusion!;
  assert.ok(emoji.length <= 600);
  assert.ok(!/[\uD800-\uDBFF]…$/.test(emoji), "bounded source text does not split a Unicode pair");
});

test("handoffs use actual steps, running first and the runner's done-only dependency rule", () => {
  const r = run(); r.status = "running";
  const result = buildAiTeamDeliverySummary({ run: r, displayTeam: team(), relayTurns: [], memberStates: { active: "needs_permission" }, steps: [
    step(1), step(2, { status: "skipped" }), step(3, { status: "queued", dependsOn: ["step_1", "step_2", "missing"] }),
    step(4, { status: "running", sessionId: "active" }), ...Array.from({ length: 8 }, (_, i) => step(i + 5, { status: "queued" })),
  ] });
  assert.equal(result.conclusion, null); assert.equal(result.totalHandoffs, 10); assert.equal(result.handoffs.length, 6);
  assert.equal(result.handoffs[0].stepId, "step_4"); assert.equal(result.handoffs[0].state, "needs_permission");
  assert.deepEqual(result.handoffs[1].waitingFor, ["当前员工名 · 步骤 2", "未完成步骤 missing"]);
});

test("approval/reply/failure/stopped project attention without falsely claiming completed work", () => {
  for (const [status, kind] of [["awaiting_approval", "approval"], ["waiting_user", "reply"], ["failed", "failure"], ["stopped", "stopped"]] as const) {
    const r = run(); r.status = status;
    const result = summary(r, [], []);
    assert.equal(result.attention?.kind, kind); assert.equal(result.conclusion, null);
  }
});

test("malformed/outside-path records are excluded and oversized frozen previews remain bounded", () => {
  const bad = delivery(1); bad.reportFile!.path = "/tmp/outside.md";
  const nan = delivery(2); nan.reportFile!.size = Number.NaN;
  const full = delivery(3); full.reportFile!.preview = { title: "题".repeat(300), excerpt: "行".repeat(400) + "\n第二\n第三\n第四" };
  const result = summary(run(), [step(1), step(2), step(3)], [bad, nan, full]);
  assert.equal(result.totalFiles, 1); assert.ok(result.files[0].file.preview!.title.length <= 100); assert.ok(result.files[0].file.preview!.excerpt.length <= 240);
});

test("runner detail finds delivery before the 200-turn transport tail and does not mutate completion", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wand-delivery-detail-"));
  const storage = new WandStorage(path.join(dir, "config.json")); t.after(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });
  const definition = team(); storage.saveAiTeam(definition);
  const task = storage.createWandTask({ title: "交付测试", description: "", status: "doing" });
  const r = { ...run(), taskId: task.id }; storage.saveAiTeamRun(r); storage.saveAiTeamStep(step(1));
  const messages: ConversationTurn[] = [delivery(1), ...Array.from({ length: 220 }, () => ({ role: "assistant" as const, content: [], notice: true }))];
  const snapshot: SessionSnapshot = { id: "chat_delivery", command: "pi", cwd: r.cwd, mode: "full-access", status: "idle", exitCode: null, startedAt: now,
    endedAt: null, output: "", archived: false, messages, sessionKind: "structured", completionRevision: 3, viewedCompletionRevision: 0 };
  const runner = new AiTeamRunner({ storage, resolveCwd: () => r.cwd, ops: {
    open: async () => { throw new Error("GET must not start work"); }, send: async () => { throw new Error("GET must not send"); },
    stop: () => { throw new Error("GET must not stop"); }, snapshot: id => id === r.chatSessionId ? snapshot : null, ownerOf: () => "structured",
  } }); t.after(() => runner.dispose());
  const before = JSON.stringify(snapshot); const detail = runner.detail(r.id);
  assert.equal(detail.chatTurns.length, 200); assert.ok(detail.chatTurns.every(turn => !turn.reportFile));
  assert.equal(detail.delivery!.totalFiles, 1); assert.equal(detail.delivery!.files[0].file.preview!.title, "冻结标题");
  assert.equal(JSON.stringify(snapshot), before); assert.equal(storage.getWandTask(task.id)!.status, "doing");
});
