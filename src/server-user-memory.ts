import type { Express, RequestHandler } from "express";
import { asyncRoute } from "./express-async.js";
import { bodyObject, sendRouteError } from "./server-request.js";
import type { WandStorage } from "./storage.js";
import { recordUserMemory, type UserMemoryService } from "./user-memory.js";
import { DEFAULT_EMPLOYEE_ID } from "./ai-team-types.js";
import { isTaskExecutionSubject } from "./task-types.js";
import { shouldGenerateSessionTopicFromInput } from "./session-topic.js";

/** Explicit allowlist: never collect GET polling, auth, vault, config, files or tool bodies. */
const OPERATIONS: Array<{ method: string; path: RegExp; feature: string; fields?: string[] }> = [
  { method: "POST", path: /^\/api\/(?:wand-tasks|tasks|workspaces\/[^/]+\/tasks)$/, feature: "task.create", fields: ["description", "title", "name"] },
  { method: "PATCH", path: /^\/api\/(?:wand-tasks|workspace-tasks)\/[^/]+$/, feature: "task.edit", fields: ["description", "title", "name"] },
  { method: "POST", path: /^\/api\/wand-tasks\/[^/]+\/dispatch$/, feature: "task.dispatch", fields: ["prompt"] },
  { method: "POST", path: /^\/api\/(?:ai-teams\/[^/]+\/runs|wand-tasks\/[^/]+\/team-runs)$/, feature: "team.start", fields: ["note"] },
  { method: "POST", path: /^\/api\/sessions\/[^/]+\/model$/, feature: "session.model" },
  { method: "POST", path: /^\/api\/sessions\/[^/]+\/thinking-effort$/, feature: "session.thinking" },
  { method: "POST", path: /^\/api\/sessions\/[^/]+\/mode$/, feature: "session.mode" },
  { method: "POST", path: /^\/api\/sessions\/[^/]+\/quick-commit$/, feature: "git.quick-commit" },
  { method: "POST", path: /^\/api\/sessions\/[^/]+\/upload$/, feature: "file.upload" },
  { method: "POST", path: /^\/api\/sessions\/[^/]+\/worktree\/merge$/, feature: "worktree.merge" },
  { method: "POST", path: /^\/api\/optimize-prompt$/, feature: "prompt.optimize", fields: ["text"] },
  { method: "POST", path: /^\/api\/(?:sessions\/[^/]+\/input|structured-sessions\/[^/]+\/messages)$/, feature: "session.prompt", fields: ["input"] },
];

export function userMemoryOperationLog(storage: WandStorage): RequestHandler {
  return (req, res, next) => {
    const operation = OPERATIONS.find((entry) => entry.method === req.method && entry.path.test(req.path));
    if (operation) {
      const epoch = storage.userMemoryCaptureState();
      const body = bodyObject(req.body);
      const subject = body.executionSubject ?? body.subject;
      const privateEmployee = isTaskExecutionSubject(subject) && subject.type === "employee"
        && subject.id !== DEFAULT_EMPLOYEE_ID;
      const observation = privateEmployee ? "" : (operation.fields ?? [])
        .map((field) => typeof body[field] === "string" ? body[field] : "").filter(Boolean).join("\n");
      // Only the successful user action is evidence. IDs/URLs and arbitrary request fields aren't logged.
      res.once("finish", () => {
        if (epoch.enabled && storage.userMemoryCaptureState().enabled
          && storage.userMemoryCaptureState().revision === epoch.revision
          && res.statusCode >= 200 && res.statusCode < 300) {
          if (operation.feature === "session.prompt") {
            // Team-generated instructions never pass through these authenticated input requests.
            // Only collect direct user replies here; interactive/wand-task runners already capture theirs.
            const sessionId = req.path.split("/")[3]!;
            const session = storage.getSessionSlim(sessionId);
            if (session?.sessionKind === "structured" && session.automationId?.startsWith("ai-team")
              && !/^[\/!]/.test(observation.trim()) && shouldGenerateSessionTopicFromInput(observation)) {
              recordUserMemory(storage, operation.feature, observation, sessionId);
            }
          } else {
            const taskId = operation.feature === "task.dispatch" || operation.feature === "task.edit"
              ? req.path.split("/")[3] : undefined;
            const taskSubject = taskId ? (req.path.split("/")[2] === "workspace-tasks"
              ? storage.getWandTaskByWorkspaceTaskId(taskId) : storage.getWandTask(taskId))?.executionSubject : null;
            const text = taskSubject?.type === "employee" && taskSubject.id !== DEFAULT_EMPLOYEE_ID
              ? "" : observation;
            recordUserMemory(storage, operation.feature, text, req.path);
          }
        }
      });
    }
    next();
  };
}

export function registerUserMemoryRoutes(
  app: Express,
  deps: { storage: WandStorage; service: UserMemoryService; notifyChanged?: (id: string) => void },
): void {
  const { storage, service, notifyChanged } = deps;
  app.get("/api/user-memory", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(service.view());
  });
  app.patch("/api/user-memory", (req, res) => {
    try {
      const body = bodyObject(req.body);
      if (typeof body.enabled !== "boolean") throw new Error("enabled 必须是布尔值。");
      storage.setUserMemoryEnabled(body.enabled);
      notifyChanged?.(DEFAULT_EMPLOYEE_ID);
      res.json(service.view());
    } catch (error) { sendRouteError(res, error, "无法调整短期记忆。"); }
  });
  app.delete("/api/user-memory", (_req, res) => {
    storage.clearUserMemory();
    notifyChanged?.(DEFAULT_EMPLOYEE_ID);
    res.json(service.view());
  });
  app.post("/api/user-memory/refresh", asyncRoute(async (_req, res) => {
    const updated = await service.refresh(true);
    const view = service.view();
    if (!updated && view.lastError) {
      res.status(503).json({ error: view.lastError });
      return;
    }
    res.json({ updated, ...view });
  }));
}
