import type { Express, Response } from "express";

import type { DecisionService } from "./decision-service.js";
import { DecisionError } from "./decision-types.js";
import { asyncRoute } from "./express-async.js";
import { getErrorMessage } from "./error-utils.js";
import { bodyObject, sendRouteError, text } from "./server-request.js";
import type { WandStorage } from "./storage.js";
import {
  assertDispatchDecisionReady,
  planTeamDispatch,
  startTeamDispatch,
} from "./team-dispatch.js";

function sendDispatchError(res: Response, error: unknown): void {
  const message = getErrorMessage(error, "派工失败。");
  // 这里所有错误都是“请求体/名单不合法”或决策服务不可用；不当成资源路径缺失（404），
  // 也不把“员工不存在”（名单里的 id）混同于“项目不存在”。
  if (error instanceof DecisionError) {
    res.status(error.status).json({ error: message, code: error.code });
    return;
  }
  sendRouteError(res, error, "派工失败。", 400);
}

/**
 * 无指派派工：不预设员工，由本地决策模型按任务描述给出建议名单，确认后才开工。
 * 「建议」和「开工」是两个独立请求，中间不需要服务端保存计划：
 * 开工时重新校验名单（员工存在、未归档、非系统运维、含负责人）。
 */
export function registerTeamDispatchRoutes(app: Express, deps: {
  storage: WandStorage;
  runner: { start(input: { teamId: string; taskId: string; note?: string }): Promise<unknown> };
  decisions: Pick<DecisionService, "evaluate" | "status">;
}): void {
  app.post("/api/team-dispatch/plan", asyncRoute(async (req, res) => {
    try {
      const body = bodyObject(req.body ?? {});
      const note = text(body.note);
      const maxMembers = typeof body.maxMembers === "number" ? body.maxMembers : undefined;
      const threshold = typeof body.threshold === "number" ? body.threshold : undefined;
      assertDispatchDecisionReady(deps.decisions);
      const plan = await planTeamDispatch({
        storage: deps.storage,
        note,
        ...(maxMembers === undefined ? {} : { maxMembers }),
        ...(threshold === undefined ? {} : { threshold }),
        evaluate: (value, caller, signal) => deps.decisions.evaluate(value, caller, signal),
      });
      res.json(plan);
    } catch (error) {
      sendDispatchError(res, error);
    }
  }));

  app.post("/api/team-dispatch/start", asyncRoute(async (req, res) => {
    try {
      const body = bodyObject(req.body ?? {});
      const workspaceId = text(body.workspaceId);
      if (!workspaceId) throw new Error("请选择工作项目。");
      const rawMembers = Array.isArray(body.members) ? body.members : [];
      const members = rawMembers.map((raw) => {
        const record = bodyObject(raw);
        return {
          employeeId: text(record.employeeId),
          ...(record.isLeader === true ? { isLeader: true } : {}),
        };
      });
      const name = text(body.name);
      const result = await startTeamDispatch({
        storage: deps.storage,
        runner: deps.runner,
        workspaceId,
        note: text(body.note),
        members,
        ...(name ? { name } : {}),
      });
      res.status(202).json({ ...(result.run as Record<string, unknown>), teamId: result.teamId, taskId: result.taskId });
    } catch (error) {
      sendDispatchError(res, error);
    }
  }));
}
