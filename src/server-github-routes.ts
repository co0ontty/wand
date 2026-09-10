import type { Express, RequestHandler } from "express";

import { asyncRoute } from "./express-async.js";
import {
  connectGithub,
  getGithubConnectorStatus,
  githubRequest,
  githubStatusWithScopes,
  jsonBody,
} from "./github-connector.js";
import { getErrorMessage } from "./error-utils.js";
import type { WandStorage } from "./storage.js";
import type { SessionRegistry } from "./session-registry.js";

interface GithubRouteDependencies {
  storage: WandStorage;
  requireAdmin: RequestHandler;
  sessions?: SessionRegistry;
}

function stringQuery(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function integerQuery(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(stringQuery(value));
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function repoPath(req: { params: Record<string, string> }): string {
  const owner = req.params.owner?.trim();
  const repo = req.params.repo?.trim();
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("仓库名称无效。");
  }
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function issueNumber(req: { params: Record<string, string> }): number {
  const number = Number(req.params.number);
  if (!Number.isInteger(number) || number < 1) throw new Error("Issue 或 PR 编号无效。");
  return number;
}

function validateObjectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("请求体必须是对象。");
  return body as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  if (!value) throw new Error(`${key} 不能为空。`);
  return value;
}

function publicError(error: unknown): { status: number; message: string } {
  const status = error instanceof Error && "status" in error && typeof error.status === "number"
    ? error.status
    : 400;
  return { status: status >= 400 && status < 600 ? status : 500, message: getErrorMessage(error, "GitHub 操作失败。") };
}

export function registerGithubRoutes(app: Express, deps: GithubRouteDependencies): void {
  const { storage, requireAdmin, sessions } = deps;

  app.get("/api/connectors/github", requireAdmin, (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(githubStatusWithScopes(storage));
  });

  app.post("/api/connectors/github", requireAdmin, asyncRoute(async (req, res) => {
    try {
      const body = validateObjectBody(req.body);
      const token = requiredString(body, "token");
      const apiUrl = typeof body.apiUrl === "string" ? body.apiUrl : undefined;
      res.set("Cache-Control", "no-store");
      res.json(await connectGithub(storage, token, apiUrl));
    } catch (error) {
      const result = publicError(error);
      res.status(result.status === 401 || result.status === 403 ? 400 : result.status).json({ error: result.message });
    }
  }));

  app.delete("/api/connectors/github", requireAdmin, (_req, res) => {
    storage.deleteConnector("github");
    res.json({ ok: true, connected: false });
  });

  app.get("/api/github/repos/:owner/:repo/issues/:number/bindings", requireAdmin, (req, res) => {
    try {
      const number = issueNumber(req);
      const bindings = storage.listGithubIssueBindings(req.params.owner, req.params.repo, number);
      res.json({ bindings });
    } catch (error) {
      const result = publicError(error);
      res.status(result.status).json({ error: result.message });
    }
  });

  app.post("/api/github/repos/:owner/:repo/issues/:number/bindings", requireAdmin, (req, res) => {
    try {
      const number = issueNumber(req);
      const body = validateObjectBody(req.body);
      const sessionId = requiredString(body, "sessionId");
      if (sessions && !sessions.get(sessionId)) throw new Error("未找到该会话。");
      storage.bindGithubIssueSession(req.params.owner, req.params.repo, number, sessionId);
      res.status(201).json({ ok: true, sessionId });
    } catch (error) {
      const result = publicError(error);
      res.status(result.status).json({ error: result.message });
    }
  });

  app.delete("/api/github/repos/:owner/:repo/issues/:number/bindings/:sessionId", requireAdmin, (req, res) => {
    try {
      storage.unbindGithubIssueSession(req.params.owner, req.params.repo, issueNumber(req), req.params.sessionId);
      res.json({ ok: true });
    } catch (error) {
      const result = publicError(error);
      res.status(result.status).json({ error: result.message });
    }
  });

  app.get("/api/github/user", requireAdmin, asyncRoute(async (_req, res) => {
    try { res.json((await githubRequest(storage, "/user")).data); }
    catch (error) { const result = publicError(error); res.status(result.status).json({ error: result.message }); }
  }));

  app.get("/api/github/repos", requireAdmin, asyncRoute(async (req, res) => {
    try {
      const query = new URLSearchParams();
      const visibility = stringQuery(req.query.visibility);
      const affiliation = stringQuery(req.query.affiliation);
      const type = stringQuery(req.query.type);
      if (visibility) query.set("visibility", visibility);
      if (affiliation) query.set("affiliation", affiliation);
      if (type) query.set("type", type);
      query.set("sort", stringQuery(req.query.sort, "updated"));
      query.set("direction", stringQuery(req.query.direction, "desc"));
      query.set("per_page", String(integerQuery(req.query.per_page, 30, 1, 100)));
      query.set("page", String(integerQuery(req.query.page, 1, 1, 10_000)));
      const suffix = query.toString();
      res.json((await githubRequest(storage, `/user/repos?${suffix}`)).data);
    } catch (error) { const result = publicError(error); res.status(result.status).json({ error: result.message }); }
  }));

  app.get("/api/github/repos/:owner/:repo", requireAdmin, asyncRoute(async (req, res) => {
    try { res.json((await githubRequest(storage, repoPath(req))).data); }
    catch (error) { const result = publicError(error); res.status(result.status).json({ error: result.message }); }
  }));

  app.get("/api/github/repos/:owner/:repo/issues", requireAdmin, asyncRoute(async (req, res) => {
    try {
      const query = new URLSearchParams();
      query.set("state", stringQuery(req.query.state, "open"));
      if (stringQuery(req.query.labels)) query.set("labels", stringQuery(req.query.labels));
      if (stringQuery(req.query.sort)) query.set("sort", stringQuery(req.query.sort));
      if (stringQuery(req.query.direction)) query.set("direction", stringQuery(req.query.direction));
      query.set("per_page", String(integerQuery(req.query.per_page, 30, 1, 100)));
      query.set("page", String(integerQuery(req.query.page, 1, 1, 10_000)));
      res.json((await githubRequest(storage, `${repoPath(req)}/issues?${query}`)).data);
    } catch (error) { const result = publicError(error); res.status(result.status).json({ error: result.message }); }
  }));

  app.post("/api/github/repos/:owner/:repo/issues", requireAdmin, asyncRoute(async (req, res) => {
    try {
      const body = validateObjectBody(req.body);
      const payload: Record<string, unknown> = { title: requiredString(body, "title") };
      for (const key of ["body", "labels", "assignees", "milestone"] as const) {
        if (body[key] !== undefined) payload[key] = body[key];
      }
      res.status(201).json((await githubRequest(storage, `${repoPath(req)}/issues`, { method: "POST", body: jsonBody(payload) })).data);
    } catch (error) { const result = publicError(error); res.status(result.status).json({ error: result.message }); }
  }));

  app.patch("/api/github/repos/:owner/:repo/issues/:number", requireAdmin, asyncRoute(async (req, res) => {
    try {
      const body = validateObjectBody(req.body);
      const payload: Record<string, unknown> = {};
      for (const key of ["title", "body", "state", "state_reason", "labels", "assignees", "milestone"] as const) {
        if (body[key] !== undefined) payload[key] = body[key];
      }
      if (!Object.keys(payload).length) throw new Error("没有可更新的 Issue 字段。");
      res.json((await githubRequest(storage, `${repoPath(req)}/issues/${issueNumber(req)}`, { method: "PATCH", body: jsonBody(payload) })).data);
    } catch (error) { const result = publicError(error); res.status(result.status).json({ error: result.message }); }
  }));

  app.post("/api/github/repos/:owner/:repo/issues/:number/comments", requireAdmin, asyncRoute(async (req, res) => {
    try {
      const body = validateObjectBody(req.body);
      const payload = { body: requiredString(body, "body") };
      res.status(201).json((await githubRequest(storage, `${repoPath(req)}/issues/${issueNumber(req)}/comments`, { method: "POST", body: jsonBody(payload) })).data);
    } catch (error) { const result = publicError(error); res.status(result.status).json({ error: result.message }); }
  }));

  app.get("/api/github/repos/:owner/:repo/pulls", requireAdmin, asyncRoute(async (req, res) => {
    try {
      const query = new URLSearchParams();
      query.set("state", stringQuery(req.query.state, "open"));
      query.set("sort", stringQuery(req.query.sort, "created"));
      query.set("direction", stringQuery(req.query.direction, "desc"));
      query.set("per_page", String(integerQuery(req.query.per_page, 30, 1, 100)));
      query.set("page", String(integerQuery(req.query.page, 1, 1, 10_000)));
      res.json((await githubRequest(storage, `${repoPath(req)}/pulls?${query}`)).data);
    } catch (error) { const result = publicError(error); res.status(result.status).json({ error: result.message }); }
  }));

  app.post("/api/github/repos/:owner/:repo/pulls", requireAdmin, asyncRoute(async (req, res) => {
    try {
      const body = validateObjectBody(req.body);
      const payload: Record<string, unknown> = {
        title: requiredString(body, "title"),
        head: requiredString(body, "head"),
        base: requiredString(body, "base"),
      };
      for (const key of ["body", "draft", "maintainer_can_modify"] as const) {
        if (body[key] !== undefined) payload[key] = body[key];
      }
      res.status(201).json((await githubRequest(storage, `${repoPath(req)}/pulls`, { method: "POST", body: jsonBody(payload) })).data);
    } catch (error) { const result = publicError(error); res.status(result.status).json({ error: result.message }); }
  }));
}
