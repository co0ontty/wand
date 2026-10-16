import type { Express } from "express";
import { asyncRoute } from "./express-async.js";
import { badRequest, conflict, notFound } from "./http-error.js";
import { conversationOrganizationService, type ConversationOrganizationDependencies } from "./conversation-organize-service.js";
import type { ConversationOrganizationScope } from "./conversation-organize-contract.js";
import type { TaskOrganizeTarget } from "./task-organize-contract.js";
import type { WandStorage } from "./storage.js";

function scopeFrom(body: Record<string, unknown>, storage: WandStorage): ConversationOrganizationScope {
  if (body.mode !== undefined && body.mode !== "auto" && body.mode !== "all") throw badRequest("请选择默认范围或所有工作会话。");
  const ids = (value: unknown): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 500 || value.some(id => typeof id !== "string" || !id.trim())) throw badRequest("会话/任务ID列表无效或超过500个。");
    return [...new Set(value as string[])];
  };
  const taskIds = ids(body.taskIds), sessionIds = ids(body.sessionIds);
  let target: TaskOrganizeTarget | undefined;
  if (body.target !== undefined) {
    if (!body.target || typeof body.target !== "object" || Array.isArray(body.target) || taskIds || sessionIds) throw badRequest("目录范围与多选范围不能混用。");
    const value = body.target as Record<string, unknown>;
    if (value.kind === "all") target = { kind: "all" };
    else if (value.kind === "workspace" && typeof value.workspaceId === "string" && storage.getWorkspace(value.workspaceId)) target = { kind: "workspace", workspaceId: value.workspaceId };
    else if (value.kind === "directory" && typeof value.cwd === "string" && value.cwd.trim()) target = { kind: "directory", cwd: value.cwd };
    else throw badRequest("会话归类目录无效。");
  }
  if (!target && !taskIds?.length && !sessionIds?.length) throw badRequest("请选择会话、任务或目录范围。");
  return { mode: body.mode === "all" ? "all" : "auto", target, taskIds, sessionIds };
}

export function registerConversationOrganizeRoutes(app: Express, storage: WandStorage, deps: ConversationOrganizationDependencies): void {
  const service = conversationOrganizationService(storage, deps);
  app.post("/api/sessions/auto-organize", asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.action === "start") {
      if (typeof body.token !== "string" || !body.token.trim() || body.force !== undefined && typeof body.force !== "boolean") throw badRequest("确认令牌或执行参数无效。");
      try { res.status(202).json({ kind: "job", job: service.start(body.token, body.force === true) }); }
      catch (error) { throw conflict(error instanceof Error ? error.message : "会话归类预览已失效。"); }
      return;
    }
    if (body.action !== undefined && body.action !== "preview") throw badRequest("会话归类操作无效。");
    try { res.json({ kind: "preview", preview: service.prepare(scopeFrom(body, storage)) }); }
    catch (error) { throw badRequest(error instanceof Error ? error.message : "无法读取会话归类范围。"); }
  }));
  app.get("/api/sessions/auto-organize/by-token/:token", (req, res) => {
    const job = storage.getConversationOrganizationJobByToken(req.params.token);
    if (!job) throw notFound("尚未找到该确认请求的已接受作业；不会自动重发。");
    res.json({ job: service.get(job.id) ?? job });
  });
  app.get("/api/sessions/auto-organize/:id", (req, res) => {
    const job = service.get(req.params.id);
    if (!job) throw notFound("归类作业不存在。");
    res.json({ job });
  });
  app.post("/api/sessions/auto-organize/:id/cancel", (req, res) => {
    const job = service.cancel(req.params.id);
    if (!job) throw notFound("归类作业不存在。");
    res.json({ job });
  });
}
