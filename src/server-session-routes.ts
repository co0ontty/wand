import type { Express } from "express";
import { isSystemAiCall, SYSTEM_AI_READ_ONLY } from "./system-ai-call.js";
import { registerPiRecommendationRoute } from "./server-pi-recommendation-routes.js";

export { parseExecutionMode,parseSessionCreationOrigin } from "./session-request.js";

export * from "./session-service.js";
export { createSessionRouteContext, type SessionRouteContext, type SessionRouteDeps } from "./server-session-context.js";
export { registerClaudeHistoryRoutes } from "./server-history-routes.js";
import { registerSessionListRoutes } from "./server-session-list-routes.js";
import { registerSessionLifecycleRoutes } from "./server-session-lifecycle-routes.js";
import { registerSessionInputRoutes } from "./server-session-input-routes.js";
import { registerSessionWorktreeRoutes } from "./server-session-worktree-routes.js";
import { createSessionRouteContext, type SessionRouteDeps } from "./server-session-context.js";

/** Registers all `/api/sessions` resource families. Order inside each family is preserved. */
export function registerSessionRoutes(app: Express, deps: SessionRouteDeps): void {
  // Historical system calls have no interactive runner. Guard every mutation family, not only Send.
  for (const prefix of ["/api/sessions/:id", "/api/structured-sessions/:id"]) {
    app.use(prefix, (req, res, next) => {
      const session = deps.sessions.getSlim(req.params.id);
      if (!isSystemAiCall(session) || req.method === "GET" || req.method === "HEAD") { next(); return; }
      const allowed = req.method === "POST" && ["/archive", "/unarchive", "/completion/view"].includes(req.path)
        || req.method === "DELETE" && req.path === "/" && session?.status !== "running";
      if (allowed) { next(); return; }
      res.status(409).json({ error: SYSTEM_AI_READ_ONLY, code: "system_call_read_only" });
    });
  }
  registerPiRecommendationRoute(app, { structured: deps.structured, sessions: deps.sessions, config: deps.config, decisions: deps.decisions });
  const ctx = createSessionRouteContext(deps);
  registerSessionListRoutes(app, ctx);
  registerSessionLifecycleRoutes(app, ctx);
  registerSessionInputRoutes(app, ctx);
  registerSessionWorktreeRoutes(app, ctx);
}
