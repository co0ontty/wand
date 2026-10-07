import type { Express, Response } from "express";
import { randomUUID } from "node:crypto";
import type { ConversationService, GroupInput } from "./conversation-service.js";
import type { ConversationReceipt, ConversationTarget } from "./conversation-types.js";
import { AiTeamConflictError } from "./ai-team-runner.js";
import { asyncRoute } from "./express-async.js";
import { bodyObject, sendRouteError, text } from "./server-request.js";

function targetOf(value: unknown): ConversationTarget {
  if (value === null || value === undefined) return null;
  const body = bodyObject(value);
  if (!text(body.taskId) || !text(body.runId)) throw new Error("发送目标需要明确 taskId 和 runId。");
  return { taskId: text(body.taskId), runId: text(body.runId) };
}
function result(res: Response, receipt: ConversationReceipt): void {
  if (receipt.state === "rejected") res.status(400).json({ error: receipt.error ?? "请求未接受。", receipt });
  else res.status(202).json(receipt);
}

export function registerConversationRoutes(app: Express, service: ConversationService): void {
  app.get("/api/conversations", (req, res) => res.json({ conversations: service.list() }));
  app.patch("/api/conversations/:id/list-state", (req, res) => {
    try {
      const body = bodyObject(req.body);
      if ((body.pinned !== undefined && typeof body.pinned !== "boolean") || (body.dissolved !== undefined && typeof body.dissolved !== "boolean")
        || (body.pinned === undefined && body.dissolved === undefined)) throw new Error("请提供有效的置顶或列表显示状态。");
      res.json(service.updateListState(req.params.id, { pinned: body.pinned as boolean | undefined, dissolved: body.dissolved as boolean | undefined }));
    } catch (error) { sendRouteError(res, error, "对话列表更新失败。", 400); }
  });
  app.delete("/api/conversations/:id", asyncRoute(async (req, res) => {
    try { await service.remove(req.params.id); res.json({ ok: true }); }
    catch (error) { sendRouteError(res, error, "删除对话失败。", error instanceof AiTeamConflictError ? 409 : 400); }
  }));
  app.get("/api/conversations/requests/:requestId", (req, res) => {
    const receipt = service.receipt(req.params.requestId);
    if (!receipt) res.status(404).json({ error: "未找到回执；不能据此断言请求未接受。" });
    else res.json(receipt);
  });
  app.get("/api/conversations/:id", (req, res) => {
    try { res.json(service.detail(req.params.id)); }
    catch (error) { sendRouteError(res, error, "对话读取失败。", 404); }
  });
  const post = (path: string, operation: (id: string, body: Record<string, unknown>) => Promise<ConversationReceipt>): void => {
    app.post(path, asyncRoute(async (req, res) => {
      try { result(res, await operation(req.params.id ?? "", bodyObject(req.body))); }
      catch (error) { sendRouteError(res, error, "对话操作失败。", error instanceof AiTeamConflictError ? 409 : 400); }
    }));
  };
  post("/api/conversations", (_id, body) => service.createGroup(text(body.requestId), bodyObject(body.group) as GroupInput));
  post("/api/conversations/:id/invitations", (id, body) => service.invite(id, text(body.requestId), Number(body.memberVersion), bodyObject(body.group) as GroupInput));
  post("/api/conversations/:id/channel", (id, body) => service.prepare(id, text(body.requestId), text(body.cwd) || undefined));
  post("/api/conversations/:id/messages", (id, body) => service.send(id, text(body.requestId), text(body.input), targetOf(body.target), text(body.cwd) || undefined));
  post("/api/conversations/:id/tasks", (id, body) => service.dispatch(id, text(body.requestId), {
    title: text(body.title), description: text(body.description), workspaceId: text(body.workspaceId), cwd: text(body.cwd) || undefined,
    memberVersion: body.memberVersion === undefined ? undefined : Number(body.memberVersion),
    continueTaskId: text(body.continueTaskId) || undefined,
  }));
  post("/api/conversations/:id/actions", (id, body) => {
    const target = targetOf(body.target);
    if (!target) throw new Error("运行操作需要明确任务与轮次。");
    return service.act(id, text(body.requestId), target, text(body.action), body.extraSteps === undefined ? undefined : Number(body.extraSteps));
  });
}

/** Compatibility relay inputs are ordinary talk; never infer the newest task or approve a short phrase. */
export async function forwardConversationRelay(service: ConversationService, sessionId: string, input: string): Promise<void> {
  const group = service.list().find((item) => item.sessionId === sessionId);
  if (!group) throw new Error("群实例不存在，请从对话列表核对。");
  const receipt = await service.send(group.id, randomUUID(), input, null, undefined, false);
  if (receipt.error) throw new Error(receipt.error);
}
