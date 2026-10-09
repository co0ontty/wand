import type { Express, Request, RequestHandler } from "express";
import type { DaemonMaintenance } from "./daemon-maintenance.js";

export function registerDaemonMaintenanceRoutes(app: Express, options: {
  requireAdmin: RequestHandler;
  canForceUpdate(req: Request): boolean;
  maintenance: Pick<DaemonMaintenance, "status" | "forceUpdate">;
  log(error: unknown): void;
}): void {
  const { maintenance } = options;
  app.get("/api/daemon-maintenance", (req, res) => {
    res.set("Cache-Control", "no-store").json({ ...maintenance.status(), canForceUpdate: options.canForceUpdate(req) });
  });
  app.post("/api/daemon-maintenance/force-update", options.requireAdmin, async (req, res) => {
    if (req.body?.confirmInterrupt !== true) {
      res.status(400).json({ error: "请先确认中断正在执行的任务。" });
      return;
    }
    try {
      res.set("Cache-Control", "no-store").json(await maintenance.forceUpdate());
    } catch (error) {
      options.log(error);
      res.status(409).json({ error: "强制更新未完成，执行可能仍在停止或组件暂不可用。系统会在空闲后自动重试。", ...maintenance.status() });
    }
  });
}
