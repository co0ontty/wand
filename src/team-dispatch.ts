import { randomUUID } from "node:crypto";

import {
  AI_TEAM_DEFAULT_MAX_STEPS,
  AI_TEAM_MAX_MEMBERS,
  AI_TEAM_MIN_MEMBERS,
  isSystemSiliconEmployee,
  memberAgents,
  type AiTeam,
  type AiTeamMember,
  type SiliconEmployee,
} from "./ai-team-types.js";
import { DECISION_MAX_OPTIONS, type DecisionResult } from "./decision-types.js";
import { defaultMilestoneIdForWrite, scopedMilestoneId } from "./milestone-scope.js";
import type { WandStorage } from "./storage.js";
import { provisionalTaskTitleFromDescription } from "./task-title.js";

/** 团队页「直接开工」自动建卡的标记，与手写卡区分。 */
export const TEAM_DISPATCH_LABEL = "team_direct";
/** 临时派工的候选集：一次决策调用最多评估这么多员工（= 每题最多选项数）。 */
export const DISPATCH_CANDIDATES_PER_CALL = DECISION_MAX_OPTIONS;
/** 建议名单默认上限：够完成一件事，又不至于把团队开成大会。 */
export const DISPATCH_MAX_MEMBERS_DEFAULT = 3;
/** 一次规划最多发多少次判断（每批 8 人）：保证响应时间与决策 worker 队列不被目录规模拖垮。 */
export const DISPATCH_MAX_CALLS = 8;
/** 入选门槛：低于这个概率视为“不参与”。概率只是参考，不是正确率。 */
export const DISPATCH_MIN_PROBABILITY_DEFAULT = 0.5;
/** 开工说明与状态的上限，与团队直接开工同口径。 */
export const DISPATCH_NOTE_MAX = 4000;
const DISPATCH_INSTRUCTION_MAX = 500;
const DISPATCH_DUTY_MAX = 120;

export interface TeamDispatchCandidate {
  employeeId: string;
  name: string;
  duty: string;
  tags: string[];
  avatar: string;
}

export interface TeamDispatchMember extends TeamDispatchCandidate {
  /** 本地决策给出的参与概率（0–1）；仅作参考，不是正确率。 */
  probability: number;
  /** 决策给出的这一题的原始判定，便于复盘。 */
  isLeader: boolean;
}

export interface TeamDispatchPlan {
  /** 建议参与的人（按概率降序），可能为空。 */
  members: TeamDispatchMember[];
  /** 超过上限但也被判定为参与的备选（按概率降序）。 */
  bench: TeamDispatchMember[];
  /** 员工目录里可派工的候选总数。 */
  considered: number;
  /** 因候选过多、未纳入本轮评估的人数（目录上限之外）。 */
  omitted: number;
  threshold: number;
  maxMembers: number;
  /** 人类可读说明：为空名单、被截断、覆盖范围等都由它表达。 */
  note: string;
  decision: { calls: number; model: string | null; inputTokens: number };
  experimental: true;
}

export interface TeamDispatchRequest {
  storage: WandStorage;
  note: string;
  maxMembers?: number;
  threshold?: number;
  signal?: AbortSignal;
  /** 决策调用入口：生产用 DecisionService.evaluate，测试注入替身。 */
  evaluate: (value: unknown, caller: string, signal?: AbortSignal) => Promise<DecisionResult>;
}

export interface TeamDispatchStartRequest {
  storage: WandStorage;
  runner: { start(input: { teamId: string; taskId: string; note?: string }): Promise<unknown> };
  workspaceId: string;
  note: string;
  members: Array<{ employeeId: string; isLeader?: boolean }>;
  name?: string;
}

function collapse(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
}

/**
 * 可派工的员工目录。
 * 系统运维（Wand 自己的生成式 AI 执行者）不是干活的人，永远不进候选集；
 * 归档员工不参与派工，但历史会话仍可打开。
 */
export function listTeamDispatchCandidates(storage: WandStorage): TeamDispatchCandidate[] {
  return storage.listSiliconEmployees()
    .filter((employee) => !employee.archivedAt && !isSystemSiliconEmployee(employee))
    .map((employee) => candidateOf(employee));
}

function candidateOf(employee: SiliconEmployee): TeamDispatchCandidate {
  return {
    employeeId: employee.id,
    name: employee.name,
    duty: collapse(employee.duty ?? "", DISPATCH_DUTY_MAX),
    tags: employee.tags ?? [],
    avatar: employee.avatar ?? "",
  };
}

function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/**
 * 用本地决策模型给任务挑参与员工：**只产出建议名单**，不自动开工。
 * 每批最多 8 名候选、一名一题（是非判断），批次之间顺序调用（决策服务本身是单 worker）。
 */
export async function planTeamDispatch(request: TeamDispatchRequest): Promise<TeamDispatchPlan> {
  const note = collapse(request.note ?? "", DISPATCH_NOTE_MAX);
  if (!note) throw new Error("请先写清这次要做什么（开工说明不能为空）。");
  const maxMembers = clampInteger(request.maxMembers, DISPATCH_MAX_MEMBERS_DEFAULT, AI_TEAM_MIN_MEMBERS, AI_TEAM_MAX_MEMBERS);  const threshold = clampProbability(request.threshold, DISPATCH_MIN_PROBABILITY_DEFAULT);
  const candidates = listTeamDispatchCandidates(request.storage);
  const considered = candidates.length;
  if (considered === 0) {
    return emptyPlan({ considered, omitted: 0, threshold, maxMembers, note: "员工目录里还没有可派工的员工：先在「AI 团队 → 硅基员工」里建一个。" });
  }
  const batches = chunksOf(candidates, DISPATCH_CANDIDATES_PER_CALL);
  const covered = batches.slice(0, DISPATCH_MAX_CALLS);
  const omitted = Math.max(0, candidates.length - covered.length * DISPATCH_CANDIDATES_PER_CALL);
  const scored: TeamDispatchMember[] = [];
  let calls = 0;
  let model: string | null = null;
  let inputTokens = 0;
  for (const [batchIndex, batch] of covered.entries()) {
    const questions: Record<string, { type: "noul"; instructions: string }> = {};
    for (const [index, candidate] of batch.entries()) questions[`c${batchIndex}_${index}`] = {
      type: "noul",
      instructions: dispatchQuestion(candidate, note),
    };
    const result = await request.evaluate({ state: dispatchState(note), questions }, "team-dispatch", request.signal);
    calls += 1;
    model = model ?? result.model;
    inputTokens += result.usage?.input_tokens ?? 0;
    for (const [index, candidate] of batch.entries()) {
      const answer = result.answers?.[`c${batchIndex}_${index}`] as { noul?: unknown } | undefined;
      const probability = typeof answer?.noul === "number" && Number.isFinite(answer.noul) ? answer.noul : 0;
      if (probability < threshold) continue;
      scored.push({ ...candidate, probability, isLeader: false });
    }
  }
  scored.sort((a, b) => b.probability - a.probability || a.name.localeCompare(b.name, "zh-Hans-CN"));
  const members = scored.slice(0, maxMembers);
  const bench = scored.slice(maxMembers);
  if (members[0]) members[0] = { ...members[0], isLeader: true };
  return {
    members,
    bench,
    considered,
    omitted,
    threshold,
    maxMembers,
    note: planNote({ members, bench, considered, omitted, threshold, calls }),
    decision: { calls, model, inputTokens },
    experimental: true,
  };
}

function dispatchQuestion(candidate: TeamDispatchCandidate, note: string): string {
  const tags = candidate.tags.length ? `；标签：${candidate.tags.join("、")}` : "";
  const role = candidate.duty ? `；职责：${candidate.duty}` : "";
  return collapse(
    `任务：${note}\n判断员工「${candidate.name}」是否应该参与这个任务${role}${tags}。只按能力与职责匹配判断，不要因为他已经做过别的事就默认参与。`,
    DISPATCH_INSTRUCTION_MAX,
  );
}

function dispatchState(note: string): string {
  return collapse(`从员工目录里为一个任务挑选参与者。任务描述：${note}`, 16_000);
}

function planNote(input: {
  members: readonly TeamDispatchMember[];
  bench: readonly TeamDispatchMember[];
  considered: number;
  omitted: number;
  threshold: number;
  calls: number;
}): string {
  if (input.members.length === 0) {
    return `在已评估的候选里没有员工的参与概率超过 ${Math.round(input.threshold * 100)}%；可以放低门槛、补全员工职责/标签，或直接指定员工。`;
  }
  if (input.members.length < AI_TEAM_MIN_MEMBERS) {
    return `只有 1 名员工的参与概率超过 ${Math.round(input.threshold * 100)}%，而团队开工至少需要 ${AI_TEAM_MIN_MEMBERS} 人：放低门槛，或从备选里再点一名。`;
  }
  const parts = [`从 ${input.considered} 名候选里建议 ${input.members.length} 人（${input.calls} 次本地判断）。`];
  if (input.omitted > 0) parts.push(`另有 ${input.omitted} 人未评估（一次规划最多评估 ${DISPATCH_MAX_CALLS * DISPATCH_CANDIDATES_PER_CALL} 人），可直接指定。`);
  if (input.bench.length > 0) parts.push(`另有 ${input.bench.length} 人达到门槛但超出人数上限，可作为备选。`);
  parts.push("概率只是参考，不是正确率；确认后才会开工。");
  return parts.join("");
}

function emptyPlan(input: { considered: number; omitted: number; threshold: number; maxMembers: number; note: string }): TeamDispatchPlan {
  return {
    members: [],
    bench: [],
    considered: input.considered,
    omitted: input.omitted,
    threshold: input.threshold,
    maxMembers: input.maxMembers,
    note: input.note,
    decision: { calls: 0, model: null, inputTokens: 0 },
    experimental: true,
  };
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function clampProbability(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(0.95, Math.max(0.05, parsed));
}

/**
 * 确认开工：用建议名单建一个临时团队并起 run。
 * 名单由调用方回传（服务端重新校验员工身份），所以“建议”和“开工”之间不需要服务端存计划。
 */
export async function startTeamDispatch(request: TeamDispatchStartRequest): Promise<{
  teamId: string;
  taskId: string;
  run: unknown;
}> {
  const note = collapse(request.note ?? "", DISPATCH_NOTE_MAX);
  if (!note) throw new Error("请先写清这次要做什么（开工说明不能为空）。");
  if (request.members.length < AI_TEAM_MIN_MEMBERS) throw new Error(`团队开工至少需要 ${AI_TEAM_MIN_MEMBERS} 名员工（含负责人）。`);
  if (request.members.length > AI_TEAM_MAX_MEMBERS) throw new Error(`临时派工最多 ${AI_TEAM_MAX_MEMBERS} 名员工。`);
  const workspace = request.storage.getWorkspace(request.workspaceId);
  if (!workspace) throw new Error("请选择工作项目。");
  if (workspace.kind === "global") throw new Error("临时派工不能在全局暂存工作区运行，请先选择或创建一个项目。");
  if (!workspace.cwd?.trim()) throw new Error("这个项目还没有工作目录，请先选择一个项目。");

  const seen = new Set<string>();
  const requestedLeader = request.members.findIndex((member) => member.isLeader);
  if (request.members.filter((member) => member.isLeader).length > 1) throw new Error("只能指定一名负责人。");
  const leaderAt = requestedLeader >= 0 ? requestedLeader : 0;
  const members: AiTeamMember[] = [];
  for (const [index, requested] of request.members.entries()) {
    const employeeId = requested.employeeId?.trim();
    if (!employeeId || seen.has(employeeId)) throw new Error("名单里有重复或缺失的员工。");
    seen.add(employeeId);
    const employee = request.storage.getSiliconEmployee(employeeId);
    if (!employee) throw new Error("名单里的员工不存在，请重新生成建议。");
    if (employee.archivedAt) throw new Error(`员工「${employee.name}」已归档，不能参与派工。`);
    if (isSystemSiliconEmployee(employee)) throw new Error("系统运维员工不参与任务派工。");
    const agents = memberAgents({ agents: employee.agents });
    if (agents.length === 0) throw new Error(`员工「${employee.name}」没有可用的执行候选，请先在员工设置里补上。`);
    members.push({
      id: `m_${randomUUID().replace(/-/g, "").slice(0, 8)}`,
      employeeId: employee.id,
      name: employee.name,
      duty: collapse(employee.duty ?? "", DISPATCH_DUTY_MAX),
      agents,
      agent: agents[0]!,
      role: "any",
      isLeader: index === leaderAt,
      avatar: employee.avatar ?? "",
    });
  }
  if (request.members.length < AI_TEAM_MIN_MEMBERS) {
    throw new Error(`团队开工至少需要 ${AI_TEAM_MIN_MEMBERS} 名员工（含负责人）。`);
  }

  const title = provisionalTaskTitleFromDescription(note) || "临时派工";
  const now = new Date().toISOString();
  const team: AiTeam = {
    id: `t_dispatch_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    name: collapse(request.name?.trim() || `临时派工 · ${title}`, 120),
    description: note,
    instructions: [
      "本团队由本地决策模型按任务描述临时组建，只在这一次任务里协作。",
      "分工与职责以成员说明为准；开工说明是本轮的唯一目标。",
      `成员：${members.map((member) => `${member.name}（${member.duty || "未填写职责"}）`).join("；")}`,
    ].join("\n"),
    members,
    requirePlanApproval: false,
    maxSteps: AI_TEAM_DEFAULT_MAX_STEPS,
    createdAt: now,
    updatedAt: now,
  };
  request.storage.saveAiTeam(team);

  const leader = members.find((member) => member.isLeader) ?? members[0]!;
  const milestoneId = defaultMilestoneIdForWrite(request.storage);
  const task = request.storage.createWandTask({
    workspaceId: workspace.id,
    title,
    description: note,
    status: "doing",
    labels: [TEAM_DISPATCH_LABEL],
    milestoneId: scopedMilestoneId(request.storage, milestoneId, workspace.id) ?? milestoneId,
    agent: leader.agents[0] ?? null,
    executionSubject: { type: "team", id: team.id },
  });
  try {
    const run = await request.runner.start({ teamId: team.id, taskId: task.id, note });
    return { teamId: team.id, taskId: task.id, run };
  } catch (error) {
    try {
      request.storage.deleteWandTask(task.id);
    } catch {
      // 回滚失败不回滚错误本身：原始错误更重要。
    }
    try {
      request.storage.deleteAiTeam(team.id);
    } catch {
      // 同上：临时团队即使残留也不会被误用（run 没起来）。
    }
    throw error;
  }
}

/** 决策服务可用性：不可用时明确报错，绝不编造名单。 */
export function assertDispatchDecisionReady(decisions: {
  status(): { enabled: boolean; supported: boolean; configured: boolean };
}): void {
  const status = decisions.status();
  if (!status.enabled) throw new Error("本地决策未启用（localDecision.enabled=false），无法用决策模型选人。");
  if (!status.supported) throw new Error("本地决策在当前平台不可用（首期只支持 macOS arm64），无法用决策模型选人。");
  if (!status.configured) throw new Error("本地决策运行环境未配置（pythonPath / modelPath），无法用决策模型选人。");
}
