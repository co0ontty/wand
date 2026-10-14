import type { Express } from "express";
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
  registerPiRecommendationRoute(app, { structured: deps.structured, sessions: deps.sessions, config: deps.config, decisions: deps.decisions });
  const ctx = createSessionRouteContext(deps);
  registerSessionListRoutes(app, ctx);
  registerSessionLifecycleRoutes(app, ctx);
  registerSessionInputRoutes(app, ctx);
  registerSessionWorktreeRoutes(app, ctx);
}
