import type { Express } from "express";
import type { DecisionService } from "./decision-service.js";
import { DecisionError } from "./decision-types.js";
import { discoverPiResources, resolvePiResourceSelection } from "./pi-resource-catalog.js";
import { parsePiRecommendationRequest, recommendPiResources } from "./pi-resource-recommendation.js";
import type { StructuredSessionManager } from "./structured-session-manager.js";
import type { SessionRegistry } from "./session-registry.js";
import type { WandConfig } from "./types.js";

export type PiRecommendationRuntime = Pick<DecisionService, "evaluate" | "status">;

/** Uses the parent's login + sessions-scope middleware; inference-only tokens cannot enter this route. */
export function registerPiRecommendationRoute(app: Express, deps: {
  structured: StructuredSessionManager; sessions: SessionRegistry; config: WandConfig;
  decisions?: PiRecommendationRuntime;
}): void {
  const active = new Set<string>();
  app.post("/api/sessions/:id/pi-settings/recommend", async (req, res) => {
    const id = req.params.id;
    const abort = new AbortController();
    const disconnected = (): void => { if (!res.writableEnded) abort.abort(); };
    let timer: NodeJS.Timeout | undefined;
    let owns = false;
    res.set("Cache-Control", "no-store");
    res.once("close", disconnected);
    try {
      const owner = deps.sessions.ownerOf(id);
      if (!owner) throw new DecisionError("NOT_FOUND", "未找到该会话。", 404);
      if (owner !== "structured" || deps.structured.get(id)?.provider !== "pi") {
        throw new DecisionError("UNSUPPORTED", "推荐仅适用于 Pi 结构化会话。");
      }
      const { settings, resolution } = deps.structured.getPiSettings(id);
      if (deps.structured.get(id)?.archived || resolution.engine !== "cli") {
        throw new DecisionError("UNSUPPORTED", "请使用未归档的 Pi CLI 会话进行资源推荐。");
      }
      const status = deps.decisions?.status();
      if (!deps.decisions || !status?.enabled || !status.supported || !status.configured || settings.localDecision === false) {
        throw new DecisionError("UNAVAILABLE", "本地决策未启用或不可用，原选择未改变。", 503);
      }
      const input = parsePiRecommendationRequest(req.body);
      if (active.has(id)) throw new DecisionError("BUSY", "本会话正在推荐，请等待当前请求完成。", 409);
      active.add(id); owns = true;
      timer = setTimeout(() => abort.abort(), 15_000);
      const inventory = await discoverPiResources(deps.config, deps.structured.get(id)!.cwd);
      resolvePiResourceSelection(inventory, input.candidates);
      const result = await recommendPiResources({ ...input, catalog: inventory.catalog,
        evaluate: (value, caller, signal) => deps.decisions!.evaluate(value, caller, signal),
        caller: `pi-recommend:${id}`, signal: abort.signal });
      const latest = deps.structured.get(id);
      if (!latest || latest.archived || latest.provider !== "pi" || latest.piSettings?.localDecision === false
        || deps.structured.getPiSettings(id).resolution.engine !== "cli") {
        throw new DecisionError("CANCELLED", "会话已变化，请重新打开设置面板。", 409);
      }
      if (abort.signal.aborted) throw new DecisionError("TIMEOUT", "推荐已取消或超时，原选择未改变。", 504);
      if (!res.destroyed) res.json(result);
    } catch (error) {
      if (res.destroyed) return;
      const failure = error instanceof DecisionError ? error
        : new DecisionError("RECOMMEND_FAILED", "推荐失败，请重新打开面板核对资源；原选择未改变。", 400);
      res.status(failure.status).json({ error: failure.message, code: failure.code });
    } finally {
      if (timer) clearTimeout(timer);
      res.off("close", disconnected);
      if (owns) active.delete(id);
    }
  });
}
