import type { Express, RequestHandler } from "express";
import type { WandStorage } from "./storage.js";
import type { DecisionService } from "./decision-service.js";
import { DecisionError } from "./decision-types.js";

/** Mounted before generic /api auth so inference-only capabilities cannot authorize any other route. */
export function registerDecisionRoutes(app: Express, deps: {
  storage: WandStorage;
  decisions: Pick<DecisionService, "status" | "evaluate">;
  requireAuth: RequestHandler;
  requireSessions: RequestHandler;
}): void {
  const authorize: RequestHandler = (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const header = req.headers.authorization ?? "";
    const token = /^Bearer (wd_[A-Za-z0-9_-]{43})$/.exec(header)?.[1];
    const sessionId = token ? deps.storage.resolveDecisionAccess(token) : null;
    if (sessionId) {
      res.locals.decisionCaller = `session:${sessionId}`;
      next();
      return;
    }
    deps.requireAuth(req, res, (error?: unknown) => {
      if (error) { next(error); return; }
      deps.requireSessions(req, res, (scopeError?: unknown) => {
        if (scopeError) { next(scopeError); return; }
        res.locals.decisionCaller = "authenticated-client";
        next();
      });
    });
  };
  app.get("/api/decisions/status", authorize, (_req, res) => {
    res.json(deps.decisions.status());
  });
  app.post("/api/decisions/evaluate", authorize, async (req, res) => {
    const abort = new AbortController();
    const disconnected = (): void => { if (!res.writableEnded) abort.abort(); };
    res.once("close", disconnected);
    try {
      const result = await deps.decisions.evaluate(req.body, res.locals.decisionCaller as string, abort.signal);
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (res.destroyed) return;
      const failure = error instanceof DecisionError ? error : new DecisionError("INTERNAL_ERROR", "决策请求失败。", 500);
      res.status(failure.status).json({ error: failure.message, code: failure.code });
    } finally {
      res.off("close", disconnected);
    }
  });
}
