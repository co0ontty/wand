/**
 * /api 路由族的 scope 表（default-deny）。
 *
 * 规则：
 *   - 每个需要登录后访问的 /api 路由族都必须在下表有一行，声明它的 scope；
 *   - 表里没有的路径一律要求 admin（连接应用拿到 403），新增路由族必须显式登记；
 *   - `route-guarded` 表示该族的每个路由自己用 requireAdmin / requireAdminOrSessionPreferences
 *     等守卫，或是明确只读的状态接口，中间件不再叠加 scope 检查；
 *   - 在 `requireAuth` 之前已注册的公开路由（登录、会话探测、更新包下载）不经过本表，见 PUBLIC_API_PREFIXES。
 *
 * 匹配按路径段边界：`/api/sessions` 命中 `/api/sessions/x`，不命中 `/api/session-list`。
 * 第一条命中的规则生效，所以更具体的前缀要写在前面。
 */
import type { RequestHandler } from "express";

import type { AuthScope } from "../storage.js";
import { requireScope } from "./auth.js";

export type ApiRouteScope = AuthScope | "route-guarded";

export interface ApiRouteRule {
  prefix: string;
  scope: ApiRouteScope;
}

/** 在认证中间件之前注册、因此不受本表约束的路由（都在各自模块内显式处理认证或公开）。 */
export const PUBLIC_API_PREFIXES: readonly string[] = [
  "/api/login",
  "/api/logout",
  "/api/session-check",
  "/api/core-status",
  // Only key discovery and encrypted POST ingress are public; reports are admin-only below.
  "/api/feedback/key",
  "/api/android-apk-update",
  "/api/macos-app-update",
  "/api/macos-dmg-update",
  "/api/ios-ipa-update",
];

export const API_ROUTE_RULES: readonly ApiRouteRule[] = [
  // ── 管理员 ──
  { prefix: "/api/feedback/client", scope: "sessions" },
  { prefix: "/api/feedback", scope: "admin" },
  { prefix: "/api/set-password", scope: "admin" },
  { prefix: "/api/restart", scope: "admin" },
  { prefix: "/api/app-connect-code", scope: "admin" },
  { prefix: "/api/connectors", scope: "admin" },
  { prefix: "/api/github", scope: "admin" },
  { prefix: "/api/update", scope: "admin" },
  { prefix: "/api/update-status", scope: "admin" },
  { prefix: "/api/update-channel", scope: "admin" },
  { prefix: "/api/check-update", scope: "admin" },
  { prefix: "/api/auto-update", scope: "admin" },
  { prefix: "/api/provider-cli-updates", scope: "admin" },
  { prefix: "/api/storage-cleanup", scope: "admin" },
  { prefix: "/api/android-apk", scope: "admin" },
  { prefix: "/api/macos-dmg", scope: "admin" },
  { prefix: "/api/ios-ipa", scope: "admin" },

  // ── 路由自守卫：设置页（写操作逐个 requireAdmin；只读 about 与偏好写入见各自路由）──
  { prefix: "/api/settings", scope: "route-guarded" },
  { prefix: "/api/models", scope: "sessions" },
  { prefix: "/api/daemon-maintenance", scope: "route-guarded" },

  // ── 浏览器扩展密码库 ──
  { prefix: "/api/browser-extension", scope: "password-vault" },

  // ── 文件与目录 ──
  { prefix: "/api/directory", scope: "files" },
  { prefix: "/api/folders", scope: "files" },
  { prefix: "/api/path-suggestions", scope: "files" },
  { prefix: "/api/recent-paths", scope: "files" },
  { prefix: "/api/quick-paths", scope: "files" },
  { prefix: "/api/file-preview", scope: "files" },
  { prefix: "/api/file-raw", scope: "files" },
  { prefix: "/api/file-write", scope: "files" },
  { prefix: "/api/file-create", scope: "files" },
  { prefix: "/api/dir-create", scope: "files" },
  { prefix: "/api/file-rename", scope: "files" },
  { prefix: "/api/file-delete", scope: "files" },
  { prefix: "/api/validate-path", scope: "files" },
  { prefix: "/api/file-search", scope: "files" },
  { prefix: "/api/local-file", scope: "files" },
  { prefix: "/api/session-file", scope: "files" },
  // Mounted before the body parsers and guarded by its own requireAuth + requireFiles pair.
  { prefix: "/api/local-preview", scope: "files" },

  // ── 会话、任务、工作区与员工（原生客户端的主要功能面）──
  { prefix: "/api/sessions", scope: "sessions" },
  { prefix: "/api/structured-sessions", scope: "sessions" },
  { prefix: "/api/session-list", scope: "sessions" },
  { prefix: "/api/session-directories", scope: "sessions" },
  { prefix: "/api/structured-chat-avatar", scope: "sessions" },
  { prefix: "/api/config", scope: "sessions" },
  { prefix: "/api/optimize-prompt", scope: "sessions" },
  { prefix: "/api/decisions", scope: "sessions" },
  { prefix: "/api/claude-history", scope: "sessions" },
  { prefix: "/api/codex-history", scope: "sessions" },
  { prefix: "/api/opencode-history", scope: "sessions" },
  { prefix: "/api/qoder-history", scope: "sessions" },
  { prefix: "/api/grok-history", scope: "sessions" },
  { prefix: "/api/pi-history", scope: "sessions" },
  { prefix: "/api/claude-sessions", scope: "sessions" },
  { prefix: "/api/codex-sessions", scope: "sessions" },
  { prefix: "/api/opencode-sessions", scope: "sessions" },
  { prefix: "/api/qoder-sessions", scope: "sessions" },
  { prefix: "/api/grok-sessions", scope: "sessions" },
  { prefix: "/api/pi-sessions", scope: "sessions" },
  { prefix: "/api/conversations", scope: "sessions" },
  { prefix: "/api/scheduled-tasks", scope: "sessions" },
  { prefix: "/api/user-memory", scope: "sessions" },
  { prefix: "/api/silicon-employees", scope: "sessions" },
  { prefix: "/api/ai-teams", scope: "sessions" },
  { prefix: "/api/ai-team-runs", scope: "sessions" },
  { prefix: "/api/team-dispatch", scope: "sessions" },
  { prefix: "/api/tasks", scope: "sessions" },
  { prefix: "/api/wand-tasks", scope: "sessions" },
  { prefix: "/api/wand-task-agent-defaults", scope: "sessions" },
  { prefix: "/api/wand-milestones", scope: "sessions" },
  { prefix: "/api/workspaces", scope: "sessions" },
  { prefix: "/api/workspace-tasks", scope: "sessions" },
  { prefix: "/api/inbox", scope: "sessions" },
  { prefix: "/api/missions", scope: "sessions" },
  { prefix: "/api/attention", scope: "sessions" },

  // ── 本地模型：查询需要 sessions，修改类由路由内部 requireAdmin ──
  { prefix: "/api/local-models", scope: "sessions" },
];

/** 返回命中路径的规则；未登记时返回 undefined（调用方按 admin 处理）。 */
export function findApiRouteRule(apiPath: string): ApiRouteRule | undefined {
  return API_ROUTE_RULES.find((rule) => apiPath === rule.prefix || apiPath.startsWith(`${rule.prefix}/`));
}

/** 未登记路径的 scope 固定为 admin：default-deny。 */
export function requiredApiScope(apiPath: string): ApiRouteScope {
  return findApiRouteRule(apiPath)?.scope ?? "admin";
}

const scopeGuards = new Map<AuthScope, RequestHandler>();

/**
 * 挂在 `app.use("/api", requireAuth)` 之后，按路由族的声明检查 scope。
 * 需要在所有需要登录的 /api 路由注册之前挂载。
 */
export function createApiScopeMiddleware(): RequestHandler {
  return function apiScope(req, res, next) {
    const scope = requiredApiScope(`${req.baseUrl}${req.path}`);
    if (scope === "route-guarded") {
      next();
      return;
    }
    let guard = scopeGuards.get(scope);
    if (!guard) {
      guard = requireScope(scope);
      scopeGuards.set(scope, guard);
    }
    guard(req, res, next);
  };
}
