import type { Express, RequestHandler } from "express";
import { asyncRoute } from "./express-async.js";
import { HttpError } from "./http-error.js";
import type { StorageCleanup } from "./storage-cleanup.js";

export function registerStorageCleanupRoutes(app: Express, cleanup: StorageCleanup, requireAdmin: RequestHandler): void {
  app.use("/api/storage-cleanup", requireAdmin, (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.get("/api/storage-cleanup/status", (_req, res) => { res.json(cleanup.status()); });
  app.get("/api/storage-cleanup/preview", asyncRoute(async (_req, res) => {
    if (cleanup.status().running) throw new HttpError(409, "cleanup_busy", "清理正在进行，请稍后重试。");
    res.json(await cleanup.run());
  }));
  app.post("/api/storage-cleanup/run", asyncRoute(async (req, res) => {
    if (req.body !== undefined && (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length)) {
      throw new HttpError(400, "bad_request", "清理范围和保留期由服务端固定，不接受路径或命令参数。");
    }
    if (cleanup.status().running) throw new HttpError(409, "cleanup_busy", "清理正在进行，请稍后重试。");
    res.json(await cleanup.run(true));
  }));
}
