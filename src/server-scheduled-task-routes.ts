import type { Express, Response } from "express";

import { ScheduledTaskConflictError, ScheduledTaskNotFoundError, type ScheduledTaskService } from "./scheduled-task-service.js";
import { sendRouteError } from "./server-request.js";

function failure(res: Response, error: unknown): void {
  sendRouteError(res, error, "定时任务操作失败。", error instanceof ScheduledTaskNotFoundError ? 404
    : error instanceof ScheduledTaskConflictError ? 409 : 400);
}

/** Authentication and the sessions capability are enforced by the server route family. */
export function registerScheduledTaskRoutes(app: Express, service: ScheduledTaskService): void {
  app.get("/api/scheduled-tasks", (req, res) => { res.json({ tasks: service.list(req.query.includeCancelled === "1") }); });
  app.get("/api/scheduled-tasks/:id", (req, res) => {
    try { res.json(service.get(req.params.id)); } catch (error) { failure(res, error); }
  });
  app.post("/api/scheduled-tasks", (req, res) => {
    try { res.status(201).json({ task: service.create(req.body) }); } catch (error) { failure(res, error); }
  });
  app.patch("/api/scheduled-tasks/:id", (req, res) => {
    try { res.json({ task: service.update(req.params.id, req.body) }); } catch (error) { failure(res, error); }
  });
}
