import express, { type Express, type RequestHandler } from "express";
import { authenticateBearerAppToken } from "./middleware/auth.js";
import type { ApnsService } from "./apns-service.js";
import type { LiveActivityService } from "./live-activity-service.js";
import { apnsDigest } from "./storage/apns-repository.js";
import type { WandStorage } from "./storage.js";
import type { WandConfig } from "./types.js";

/** Mount before the global API auth gate: PUT requires the app bearer; DELETE has revoke-only authority. */
export function registerApnsRoutes(app: Express, deps: {
  storage: WandStorage; config: WandConfig; service: ApnsService; liveActivity?: LiveActivityService;
}): void {
  const router = express.Router();
  let window = 0, requests = 0;
  const bounded: RequestHandler = (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (Date.now() - window >= 60_000) { window = Date.now(); requests = 0; }
    if (++requests > 120) { res.set("Retry-After", "60").status(429).json({ error: "推送订阅请求过多。" }); return; }
    next();
  };
  router.use(bounded);
  router.put("/subscription", express.json({ limit: "4kb", inflate: false }), (req, res) => {
    if (!authenticateBearerAppToken(req, deps.storage, deps.config)) {
      res.status(401).json({ error: "需要有效的应用连接凭据。", code: "unauthorized" }); return;
    }
    if (!deps.service.available) { res.status(503).json({ error: "服务器尚未配置 APNs。", code: "apns_unavailable" }); return; }
    const { secret, deviceToken, environment, serverId } = req.body ?? {};
    const config = deps.service.configuration!;
    if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret)
      || typeof deviceToken !== "string" || !/^[a-f0-9]{32,200}$/.test(deviceToken) || deviceToken.length % 2 !== 0
      || environment !== config.environment || typeof serverId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(serverId)) {
      res.status(400).json({ error: "推送订阅参数或 APNs 环境不匹配。", code: "invalid_apns_subscription" }); return;
    }
    // All connected apps currently share one instance-owner credential (not a multi-user account model).
    // Bind to its digest so password/app-secret rotation revokes every existing subscription at send time.
    const appToken = (req.headers.authorization as string).slice("Bearer ".length).trim();
    try {
      deps.storage.apns.register({ secret, token: deviceToken, environment, topic: config.topic, serverId,
        credentialDigest: apnsDigest(appToken) }, Date.now());
      res.status(200).json({ available: true, leaseSeconds: 14 * 86_400 });
    } catch { res.status(503).json({ error: "推送订阅暂不可用。", code: "apns_storage_unavailable" }); }
  });
  router.delete("/subscription", (req, res) => {
    const header = req.headers.authorization;
    const secret = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!/^[a-f0-9]{64}$/.test(secret)) { res.status(401).json({ error: "需要设备撤销凭据。" }); return; }
    // This opaque, 256-bit capability can only revoke its own device. No login, listing, registration or sending.
    // It remains usable after the profile/app credential is removed or rotated, allowing durable offline retries.
    try { deps.storage.apns.revoke(secret); res.status(204).end(); }
    catch { res.status(503).json({ error: "推送撤销暂不可用。" }); }
  });
  router.put("/live-activity", express.json({ limit: "4kb", inflate: false }), (req, res) => {
    if (!authenticateBearerAppToken(req, deps.storage, deps.config)) {
      res.status(401).json({ error: "需要有效的应用连接凭据。", code: "unauthorized" }); return;
    }
    if (!deps.liveActivity?.available) { res.status(503).json({ error: "服务器尚未配置远程灵动岛。", code: "apns_unavailable" }); return; }
    const { secret, activityId, activityToken, environment, serverId } = req.body ?? {};
    const config = deps.liveActivity.configuration!;
    if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret)
      || typeof activityId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(activityId)
      || typeof activityToken !== "string" || !/^[a-f0-9]{32,512}$/.test(activityToken) || activityToken.length % 2 !== 0
      || environment !== config.environment || typeof serverId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(serverId)) {
      res.status(400).json({ error: "灵动岛订阅参数或推送环境不匹配。", code: "invalid_live_activity_subscription" }); return;
    }
    const appToken = (req.headers.authorization as string).slice(7).trim();
    try {
      deps.storage.liveActivities.register({ secret, activityId, token: activityToken, environment, serverId,
        topic: config.topic, credentialDigest: apnsDigest(appToken) }, Date.now());
      res.json({ available: true, leaseSeconds: 8 * 3600 });
    } catch { res.status(503).json({ error: "灵动岛订阅暂不可用。", code: "apns_storage_unavailable" }); }
  });
  router.delete("/live-activity", (req, res) => {
    const header = req.headers.authorization;
    const secret = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!/^[a-f0-9]{64}$/.test(secret)) { res.status(401).json({ error: "需要活动撤销凭据。" }); return; }
    try { deps.storage.liveActivities.revoke(secret); res.status(204).end(); }
    catch { res.status(503).json({ error: "活动撤销暂不可用。" }); }
  });
  app.use("/api/push/apns", router);
}
