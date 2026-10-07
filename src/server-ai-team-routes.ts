import { randomUUID } from "node:crypto";
import type { Express, Response } from "express";

import { AiTeamConflictError, type AiTeamRunner } from "./ai-team-runner.js";
import {
  AI_TEAM_AVATAR_MAX_CHARS,
  AI_TEAM_DEFAULT_MAX_STEPS,
  AI_TEAM_MAX_CANDIDATES,
  AI_TEAM_MAX_MEMBERS,
  AI_TEAM_MAX_STEPS,
  AI_TEAM_MIN_MEMBERS,
  AI_TEAM_MIN_STEPS,
  agentKey,
  isTeamMemberRole,
  memberAgents,
  type AiTeam,
  type AiTeamMember,
} from "./ai-team-types.js";
import { requireTeamEmployee, type AiTeamEmployeeSource } from "./ai-team-employee-binding.js";
import { asyncRoute } from "./express-async.js";
import { getErrorMessage } from "./error-utils.js";
import { defaultMilestoneIdForWrite, scopedMilestoneId } from "./milestone-scope.js";
import { bodyObject, sendRouteError, text } from "./server-request.js";
import { parseTaskAgent } from "./server-task-routes.js";
import type { WandStorage } from "./storage.js";
import { provisionalTaskTitleFromDescription } from "./task-title.js";
import type { WandTaskAgent } from "./task-types.js";

const NOT_FOUND = /不存在/;
/** 团队页「直接开工」自动建卡的标记（§4.2 / Q3）：看板靠它区分团队卡与手写卡。 */
export const TEAM_DIRECT_LABEL = "team_direct";
/** note 上限，与团队协作指令同口径（§4.2）。 */
const TEAM_DIRECT_NOTE_MAX = 4000;
/** `GET /api/ai-teams/:id` 附带多少个运行摘要（§4.1 B14）：面板只要最近这一段。 */
const TEAM_DIRECT_RUNS_LIMIT = 50;

function sendTeamError(res: Response, error: unknown): void {
  const message = getErrorMessage(error, "团队操作失败。");
  const status = error instanceof AiTeamConflictError ? 409 : NOT_FOUND.test(message) ? 404 : 400;
  sendRouteError(res, error, "团队操作失败。", status);
}

function boundedText(value: unknown, label: string, min: number, max: number): string {
  const result = text(value);
  if (result.length < min) throw new Error(`${label}不能为空。`);
  if (result.length > max) throw new Error(`${label}不能超过 ${max} 个字符。`);
  return result;
}

function parseAvatar(value: unknown, name: string): string {
  const avatar = text(value);
  if (!avatar || /^cat:\d{1,2}$/.test(avatar)) return avatar;
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) throw new Error(`成员「${name}」的头像格式无效。`);
  if (avatar.length > AI_TEAM_AVATAR_MAX_CHARS) throw new Error(`成员「${name}」的头像太大。`);
  return avatar;
}

function parseMembers(value: unknown, existing: AiTeam | null, source?: AiTeamEmployeeSource): AiTeamMember[] {
  if (!Array.isArray(value)) throw new Error("成员列表必须是数组。");
  if (value.length < AI_TEAM_MIN_MEMBERS || value.length > AI_TEAM_MAX_MEMBERS) {
    throw new Error(`团队需要 ${AI_TEAM_MIN_MEMBERS}–${AI_TEAM_MAX_MEMBERS} 名成员。`);
  }
  const names = new Set<string>();
  const ids = new Set<string>();
  const employees = new Set<string>();
  const members = value.map((raw, index): AiTeamMember => {
    const body = bodyObject(raw);
    const rawId = text(body.id);
    const prior = existing?.members.find((member) => member.id === rawId);
    if (body.employeeId !== undefined && body.employeeId !== null && typeof body.employeeId !== "string") {
      throw new Error("员工 ID 必须是文字。");
    }
    const employeeId = body.employeeId === undefined ? prior?.employeeId : text(body.employeeId) || undefined;
    if (employeeId && !source) throw new Error("员工绑定需要真实员工来源。");
    if (employeeId && employees.has(employeeId)) throw new Error("同一员工不能重复加入同一团队。");
    if (employeeId) employees.add(employeeId);
    const employee = employeeId ? requireTeamEmployee(source!, employeeId) : null;
    const name = employee?.name ?? boundedText(body.name, `第 ${index + 1} 位成员的名字`, 1, 40);
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(`成员名字「${name}」重复。`);
    names.add(key);
    const id = /^m_[A-Za-z0-9]{1,32}$/.test(rawId) && !ids.has(rawId)
      ? rawId
      : `m_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    ids.add(id);
    const duty = text(body.duty);
    if (duty.length > 2000) throw new Error(`成员「${name}」的职责不能超过 2000 个字符。`);
    let agents: WandTaskAgent[];
    try {
      if (employee) {
        agents = employee.agents.map((candidate) => ({ ...candidate }));
      } else if (Array.isArray(body.agents)) {
        if (body.agents.length === 0) throw new Error("至少需要一个执行候选。");
        if (body.agents.length > AI_TEAM_MAX_CANDIDATES) throw new Error(`最多 ${AI_TEAM_MAX_CANDIDATES} 个执行候选。`);
        agents = body.agents.map((rawAgent): WandTaskAgent => {
          const parsed = parseTaskAgent(rawAgent ?? {});
          if (!parsed) throw new Error("请选择有效的 CLI 工具。");
          return parsed;
        });
      } else if (body.agents !== undefined && body.agents !== null) {
        throw new Error("候选执行配置必须是数组。");
      } else {
        const agent = parseTaskAgent(body.agent ?? {});
        if (!agent) throw new Error("没有选择 CLI 工具。");
        agents = [agent];
      }
    } catch (error) {
      throw new Error(`成员「${name}」：${getErrorMessage(error)}`);
    }
    const seenKeys = new Set(agents.map(agentKey));
    if (seenKeys.size !== agents.length) throw new Error(`成员「${name}」的执行候选重复。`);
    const member: AiTeamMember = {
      id, name, duty, agents,
      ...(employeeId ? { employeeId } : {}),
      // 服务端强制兼容字段 = 首选候选，不信任客户端传来的 agent。
      agent: agents[0]!,
      isLeader: body.isLeader === true,
      avatar: employee?.avatar ?? parseAvatar(body.avatar, name),
    };
    if (isTeamMemberRole(body.role)) member.role = body.role;
    return member;
  });
  if (members.filter((member) => member.isLeader).length !== 1) throw new Error("团队需要恰好一位负责人。");
  return members;
}

export function parseAiTeamInput(value: unknown, existing: AiTeam | null, now: string, source?: AiTeamEmployeeSource): AiTeam {
  const body = bodyObject(value);
  const maxSteps = body.maxSteps === undefined ? existing?.maxSteps ?? AI_TEAM_DEFAULT_MAX_STEPS : Number(body.maxSteps);
  if (!Number.isInteger(maxSteps) || maxSteps < AI_TEAM_MIN_STEPS || maxSteps > AI_TEAM_MAX_STEPS) {
    throw new Error(`步数上限需要是 ${AI_TEAM_MIN_STEPS}–${AI_TEAM_MAX_STEPS} 之间的整数。`);
  }
  const description = text(body.description);
  if (description.length > 500) throw new Error("说明不能超过 500 个字符。");
  const instructions = body.instructions === undefined ? existing?.instructions ?? "" : text(body.instructions);
  if (instructions.length > 4000) throw new Error("协作指令不能超过 4000 个字符。");
  return {
    id: existing?.id ?? `team_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    name: boundedText(body.name, "团队名", 1, 60),
    description,
    instructions,
    members: parseMembers(body.members, existing, source),
    requirePlanApproval: typeof body.requirePlanApproval === "boolean"
      ? body.requirePlanApproval
      : existing?.requirePlanApproval ?? true,
    maxSteps,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function registerAiTeamRoutes(app: Express, deps: {
  storage: WandStorage;
  runner: AiTeamRunner;
  notifyTeamChanged?: (teamId: string) => void;
}): void {
  const { storage, runner } = deps;
  const notifyTeam = (teamId: string): void => {
    try {
      deps.notifyTeamChanged?.(teamId);
    } catch (error) {
      console.error("[AiTeam] notify definition failed:", getErrorMessage(error));
    }
  };

  app.get("/api/ai-teams", (_req, res) => {
    res.json(storage.listAiTeams());
  });

  app.post("/api/ai-teams", (req, res) => {
    try {
      const team = parseAiTeamInput(req.body, null, new Date().toISOString(), storage);
      storage.saveAiTeam(team);
      res.status(201).json(team);
    } catch (error) {
      sendTeamError(res, error);
    }
  });

  app.put("/api/ai-teams/:id", (req, res) => {
    try {
      const existing = storage.getAiTeam(req.params.id);
      if (!existing) throw new Error("团队不存在。");
      const team = parseAiTeamInput(req.body, existing, new Date().toISOString(), storage);
      storage.saveAiTeam(team);
      notifyTeam(team.id);
      res.json(team);
    } catch (error) {
      sendTeamError(res, error);
    }
  });

  app.delete("/api/ai-teams/:id", (req, res) => {
    storage.deleteAiTeam(req.params.id);
    notifyTeam(req.params.id);
    res.json({ ok: true });
  });

  /** 团队详情：团队对象 + 该团队的运行摘要（修正 B14，Android AiTeamDetailScreen 与 Web 面板共用）。 */
  app.get("/api/ai-teams/:id", (req, res) => {
    try {
      const team = storage.getAiTeam(req.params.id);
      if (!team) throw new Error("团队不存在。");
      res.json({ team, runs: runner.listRuns({ teamId: team.id, limit: TEAM_DIRECT_RUNS_LIMIT }) });
    } catch (error) {
      sendTeamError(res, error);
    }
  });

  /**
   * 直接开工（§4.2，需求 D）：服务端自己建一张 `team_direct` 卡再起 run，**没有 cwd 入参**。
   * 工作目录只能来自已校验的非 global workspace —— 缺省 workspaceId 的卡不会在建卡时报错，
   * 而是在派发时静默落到 `<configDir>/scratch`（N2），所以整条校验链必须卡在入口。
   */
  app.post("/api/ai-teams/:id/runs", asyncRoute(async (req, res) => {
    try {
      const body = bodyObject(req.body ?? {});
      const workspaceId = text(body.workspaceId);
      if (!workspaceId) throw new Error("请选择工作项目。");
      const workspace = storage.getWorkspace(workspaceId);
      if (!workspace) throw new Error("请选择工作项目。");
      if (workspace.kind === "global") {
        throw new Error("AI 团队不能在全局暂存工作区运行，请先选择或创建一个项目。");
      }
      if (!text(workspace.cwd)) throw new Error("这个项目还没有工作目录，请先选择一个项目。");
      const note = boundedText(body.note, "开工说明", 1, TEAM_DIRECT_NOTE_MAX);
      const team = storage.getAiTeam(req.params.id);
      if (!team) throw new Error("团队不存在。");
      // 卡片上的执行配置取团队首选（负责人的第一个候选），看板与快捷提交都按它显示。
      const preferredMember = team.members.find((member) => member.isLeader) ?? team.members[0];
      const agent = preferredMember ? memberAgents(preferredMember)[0] ?? null : null;
      const milestoneId = defaultMilestoneIdForWrite(storage);
      const task = storage.createWandTask({
        workspaceId: workspace.id,
        title: provisionalTaskTitleFromDescription(note) || team.name,
        description: note,
        // 团队开工即进行中（§4.2 的 "processing" 对应看板列 doing；runner.start 不再回退它）。
        status: "doing",
        labels: [TEAM_DIRECT_LABEL],
        milestoneId: scopedMilestoneId(storage, milestoneId, workspace.id) ?? milestoneId,
        agent,
        executionSubject: { type: "team", id: team.id },
      });
      try {
        const detail = await runner.start({ teamId: team.id, taskId: task.id, note });
        res.status(202).json({ ...detail, taskId: task.id });
      } catch (error) {
        // 不留空卡：起 run 失败就删掉刚建的卡；回滚本身失败只记日志，错误原样映射出去。
        try {
          storage.deleteWandTask(task.id);
        } catch (rollbackError) {
          console.error(`[AiTeam] rollback direct task ${task.id} failed:`, getErrorMessage(rollbackError));
        }
        throw error;
      }
    } catch (error) {
      sendTeamError(res, error);
    }
  }));

  app.get("/api/ai-team-runs", (req, res) => {
    const teamId = typeof req.query.teamId === "string" ? req.query.teamId : undefined;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json(runner.listRuns({ teamId, activeOnly: req.query.active === "1", limit }));
  });

  app.get("/api/wand-tasks/:id/team-runs", (req, res) => {
    res.json(runner.listForTask(req.params.id));
  });

  app.post("/api/wand-tasks/:id/team-runs", asyncRoute(async (req, res) => {
    try {
      const body = bodyObject(req.body);
      const teamId = text(body.teamId);
      if (!teamId) throw new Error("请选择团队。");
      const detail = await runner.start({ teamId, taskId: req.params.id, note: text(body.note) });
      storage.updateWandTask(req.params.id, { executionSubject: { type: "team", id: teamId } });
      res.status(202).json(detail);
    } catch (error) {
      sendTeamError(res, error);
    }
  }));

  app.get("/api/ai-team-runs/:id", (req, res) => {
    try {
      res.json(runner.detail(req.params.id));
    } catch (error) {
      sendTeamError(res, error);
    }
  });

  /**
   * 运行中步骤的 live 文本（§4.9.1）：Web 走 ai-team-step-live 推送，移动端轻量轮询这个端点。
   * 除步骤快照外还回 run 级活动时间（startedAt / lastActivityAt / observedAt），轮询端不必
   * 再拉一次 detail 才知道「还在跑、只是这一轮安静」。
   */
  app.get("/api/ai-team-runs/:id/live", (req, res) => {
    try {
      res.json(runner.liveSnapshot(req.params.id));
    } catch (error) {
      sendTeamError(res, error);
    }
  });

  const action = (
    path: string,
    handler: (runId: string, body: Record<string, unknown>, params: Record<string, string>) => Promise<unknown>,
  ): void => {
    app.post(path, asyncRoute(async (req, res) => {
      try {
        res.json(await handler(req.params.id, bodyObject(req.body ?? {}), req.params as Record<string, string>));
      } catch (error) {
        sendTeamError(res, error);
      }
    }));
  };
  action("/api/ai-team-runs/:id/approve", (runId) => runner.approve(runId));
  action("/api/ai-team-runs/:id/reject", (runId, body) => runner.reject(runId, text(body.feedback)));
  action("/api/ai-team-runs/:id/reply", (runId, body) => runner.reply(runId, text(body.text)));
  action("/api/ai-team-runs/:id/continue", (runId, body) => runner.continueRun(runId, Number(body.extraSteps) || 10));
  action("/api/ai-team-runs/:id/steps/:stepId/complete", (runId, body, params) => (
    runner.completeStep(runId, params.stepId!, text(body.report))
  ));
  action("/api/ai-team-runs/:id/stop", (runId) => runner.stop(runId));
}
