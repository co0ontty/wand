import type { Express, RequestHandler } from "express";
import { asyncRoute } from "./express-async.js";
import { bodyObject } from "./server-request.js";
import { EmployeeImConfigError } from "./employee-im-config.js";
import type { EmployeeImService } from "./employee-im.js";
import type { WandStorage } from "./storage.js";

/** Credentials are admin-only, write-only and never part of employee list/detail responses. */
export function registerEmployeeImRoutes(app: Express, deps: { storage: WandStorage; im: EmployeeImService; requireAdmin: RequestHandler }): void {
  const path = "/api/silicon-employees/:id/im";
  app.use(path, (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); }, deps.requireAdmin, (req, res, next) => {
    if (!deps.storage.getSiliconEmployeeDefinition(String(req.params.id))) { res.status(404).json({ error: "员工不存在。" }); return; }
    next();
  });
  app.get(path, (req, res) => { res.json(deps.storage.getEmployeeImConfig(String(req.params.id))); });
  app.put(path, (req, res) => {
    try { res.json(deps.storage.saveEmployeeImConfig(String(req.params.id), bodyObject(req.body))); }
    catch (error) {
      // Validation errors never contain request values. Crypto/storage failures receive a fixed safe message.
      const message = error instanceof EmployeeImConfigError
        ? error.message : "IM 配置保存失败，请检查本机密钥与存储状态。";
      res.status(400).json({ error: message });
    }
  });
  app.post(`${path}/test`, asyncRoute(async (req, res) => {
    const provider = bodyObject(req.body).provider;
    if (provider !== "telegram" && provider !== "dingtalk") { res.status(400).json({ error: "请选择 Telegram 或钉钉。" }); return; }
    try { await deps.im.test(String(req.params.id), provider); res.json({ ok: true }); }
    catch { res.status(502).json({ error: "测试消息发送未确认，请检查已保存的配置与网络；不会自动重发。" }); }
  }));
}
