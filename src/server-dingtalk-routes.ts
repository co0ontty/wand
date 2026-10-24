import type { Express, RequestHandler } from "express";
import type { DingTalkService } from "./dingtalk-service.js";
import { DingTalkError } from "./dingtalk-dws.js";
import { asyncRoute } from "./express-async.js";
import { bodyObject, text } from "./server-request.js";

/** All discovery, OAuth codes and provisioning controls are admin-scoped, no-store and never public DTO caches. */
export function registerDingTalkRoutes(app: Express, deps: { service: DingTalkService; requireAdmin: RequestHandler; install(): Promise<void> }): void {
  const base = "/api/connectors/dingtalk";
  app.use(base, deps.requireAdmin, (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  const route = (method: "get" | "post" | "patch", path: string, action: (req: import("express").Request) => unknown | Promise<unknown>, successStatus = 200) => {
    app[method](base + path, asyncRoute(async (req, res) => {
      try { res.status(successStatus).json(await action(req)); }
      catch (error) {
        const safe = error instanceof DingTalkError ? error : new DingTalkError("operation_failed", "钉钉操作未完成，请检查当前接入状态。");
        res.status(safe.code === "unauthorized" ? 401 : safe.code === "not_found" ? 404 : 400).json({ error: safe.message, code: safe.code, unknownDelivery: safe.unknownDelivery });
      }
    }));
  };
  route("get", "", () => deps.service.status());
  route("post", "/install", async () => { await deps.install(); return { installed: true }; });
  route("post", "/auth", () => deps.service.auth.begin());
  route("get", "/auth/:id", req => deps.service.auth.get(req.params.id));
  route("post", "/auth/:id/cancel", req => deps.service.auth.cancel(req.params.id));
  route("get", "/groups", req => deps.service.discover(text(req.query.accountId), text(req.query.cursor)));
  route("post", "/plans", req => {
    const b = bodyObject(req.body);
    return deps.service.plan({ accountId: b.accountId, groupIds: b.groupIds, employeeIds: b.employeeIds, excluded: b.excluded, robotNames: b.robotNames, candidateIndices: b.candidateIndices });
  });
  route("post", "/connections", req => { const b = bodyObject(req.body); return deps.service.connect(text(b.planId), b.confirmed === true); }, 202);
  route("patch", "/bindings/:id", req => deps.service.updateBinding(req.params.id, bodyObject(req.body)));
  route("post", "/bindings/:id/resume", req => deps.service.retryBinding(req.params.id), 202);
  route("post", "/bindings/:id/remove", req => { if (bodyObject(req.body).confirmed !== true) throw new DingTalkError("confirmation", "请确认仅移除此群中的员工绑定。"); return deps.service.removeBinding(req.params.id); });
  route("post", "/groups/:id/refresh", req => deps.service.refreshGroup(req.params.id));
}
