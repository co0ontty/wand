import type { Express, RequestHandler, ErrorRequestHandler } from "express";
import { DecisionError } from "./decision-types.js";
import { SpeechError } from "./speech-service.js";
import type { LocalModelSetupService } from "./local-model-setup.js";
import type { LocalModelKind } from "./local-model-types.js";

/** Behind generic /api authentication; inference-only capabilities cannot install dependencies. */
export function registerLocalModelRoutes(app: Express, deps: {
  models: LocalModelSetupService; requireSessions: RequestHandler; requireAdmin: RequestHandler;
}): void {
  app.use("/api/local-models", deps.requireSessions, (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  const kind: RequestHandler = (req, res, next) => {
    if (req.params.kind !== "laya" && req.params.kind !== "speech") { res.status(404).json({ error: "未知本地模型。" }); return; }
    next();
  };
  app.get("/api/local-models/status", async (_req, res, next) => {
    try { res.json(await deps.models.status()); } catch (error) { next(error); }
  });
  for (const action of ["download", "initialize"] as const) {
    app.post(`/api/local-models/:kind/${action}`, deps.requireAdmin, kind, async (req, res, next) => {
      try { deps.models.start(req.params.kind as LocalModelKind, action, req.body ?? {}); res.status(202).json(await deps.models.status()); }
      catch (error) { next(error); }
    });
  }
  app.post("/api/local-models/:kind/cancel", deps.requireAdmin, kind, async (req, res, next) => {
    try {
      if (req.body && Object.keys(req.body).length) throw new DecisionError("INVALID_REQUEST", "取消操作不接受命令参数。");
      deps.models.cancel(req.params.kind as LocalModelKind); res.status(202).json(await deps.models.status());
    } catch (error) { next(error); }
  });
  app.patch("/api/local-models/laya/settings", deps.requireAdmin, async (req, res, next) => {
    try {
      if (!req.body || Object.keys(req.body).length !== 1 || typeof req.body.enabled !== "boolean") throw new DecisionError("INVALID_REQUEST", "仅允许修改 LAYA 启用状态；路径由受信任安装入口确定。");
      deps.models.setLayaEnabled(req.body.enabled); res.json(await deps.models.status());
    } catch (error) { next(error); }
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof DecisionError || error instanceof SpeechError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    res.status(500).json({ error: "本地模型管理失败，请刷新状态后重试。", code: "SETUP_FAILED" });
  };
  app.use("/api/local-models", errors);
}
