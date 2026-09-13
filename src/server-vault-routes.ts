/**
 * 浏览器扩展密码库 HTTP 路由（`/api/browser-extension/*`）。
 *
 * 挂在 `requireAuth` + `requirePasswordVault` scope 之后，因此这里的 handler
 * 不再自己鉴权。原来它们挤在 `server.ts` 组合根中间，把启动逻辑切成了两半；
 * 独立成模块后组合根只剩下顺序清晰的装配。
 */

import type { Express } from "express";

import {
  buildPasswordSecurityReport,
  generatePassword,
  generateTotpCode,
  normalizePasswordItemType,
  type PasswordVaultItemFilter,
  type PasswordVaultItemInput,
} from "./password-manager.js";
import { firstQueryStringValue, sendRouteError } from "./server-request.js";
import { resolveRequestServerUrl } from "./server-app-connect.js";
import type { WandStorage } from "./storage.js";
import type { WandConfig } from "./types.js";

export interface VaultRoutesDependencies {
  storage: WandStorage;
  config: WandConfig;
  useHttps: boolean;
}

export function registerVaultRoutes(app: Express, deps: VaultRoutesDependencies): void {
  const { storage, config, useHttps } = deps;

  app.get("/api/browser-extension/status", (req, res) => {
    res.json({
      ok: true,
      serverUrl: resolveRequestServerUrl(req, config, useHttps),
      features: {
        loginAutofill: true,
        saveLogins: true,
        federatedLoginMemory: true,
        passwordGenerator: true,
        totp: true,
        cardsAndIdentities: true,
        vaults: true,
        securityReport: true,
        passkeys: "webauthn-proxy",
      },
    });
  });

  app.get("/api/browser-extension/vaults", (_req, res) => {
    res.json({ vaults: storage.listPasswordVaults() });
  });

  app.post("/api/browser-extension/vaults", (req, res) => {
    try {
      const vault = storage.createPasswordVault((req.body as { name?: unknown }).name);
      res.status(201).json({ vault });
    } catch (error) {
      sendRouteError(res, error, "无法创建 vault。");
    }
  });

  app.get("/api/browser-extension/items", (req, res) => {
    const filter: PasswordVaultItemFilter = {
      q: firstQueryStringValue(req.query.q),
      url: firstQueryStringValue(req.query.url),
      vaultId: firstQueryStringValue(req.query.vaultId),
      type: req.query.type ? normalizePasswordItemType(firstQueryStringValue(req.query.type)) : undefined,
      limit: req.query.limit ? Number(firstQueryStringValue(req.query.limit)) : undefined,
    };
    res.json({ items: storage.listPasswordItems(filter) });
  });

  app.post("/api/browser-extension/items", (req, res) => {
    try {
      const item = storage.createPasswordItem(req.body as PasswordVaultItemInput);
      res.status(201).json({ item });
    } catch (error) {
      sendRouteError(res, error, "无法保存条目。");
    }
  });

  app.get("/api/browser-extension/items/:id", (req, res) => {
    const item = storage.getPasswordItem(req.params.id);
    if (!item) {
      res.status(404).json({ error: "条目不存在。" });
      return;
    }
    res.json({ item });
  });

  app.put("/api/browser-extension/items/:id", (req, res) => {
    try {
      const item = storage.updatePasswordItem(req.params.id, req.body as PasswordVaultItemInput);
      if (!item) {
        res.status(404).json({ error: "条目不存在。" });
        return;
      }
      res.json({ item });
    } catch (error) {
      sendRouteError(res, error, "无法更新条目。");
    }
  });

  app.delete("/api/browser-extension/items/:id", (req, res) => {
    if (!storage.deletePasswordItem(req.params.id)) {
      res.status(404).json({ error: "条目不存在。" });
      return;
    }
    res.json({ ok: true });
  });

  app.post("/api/browser-extension/items/:id/use", (req, res) => {
    const item = storage.touchPasswordItem(req.params.id);
    if (!item) {
      res.status(404).json({ error: "条目不存在。" });
      return;
    }
    res.json({ item });
  });

  app.get("/api/browser-extension/generator/password", (req, res) => {
    res.json({
      password: generatePassword({
        length: Number(firstQueryStringValue(req.query.length)),
        digits: firstQueryStringValue(req.query.digits) !== "false",
        symbols: firstQueryStringValue(req.query.symbols) !== "false",
      }),
    });
  });

  app.post("/api/browser-extension/totp/preview", (req, res) => {
    try {
      const { secret, digits, period } = req.body as { secret?: string; digits?: number; period?: number };
      if (!secret) {
        res.status(400).json({ error: "缺少 TOTP secret。" });
        return;
      }
      res.json({
        code: generateTotpCode(secret, Date.now(), digits ?? 6, period ?? 30),
        period: period ?? 30,
      });
    } catch (error) {
      sendRouteError(res, error, "无法生成 TOTP。");
    }
  });

  app.get("/api/browser-extension/security-report", (_req, res) => {
    res.json({ report: buildPasswordSecurityReport(storage.listPasswordItems({ includeArchived: false, limit: 200 })) });
  });
}
