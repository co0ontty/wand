import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Express, Request, RequestHandler } from "express";

import { buildChildEnv } from "./env-utils.js";
import { getErrorMessage } from "./error-utils.js";
import { asyncRoute } from "./express-async.js";
import {
  getProviderDefaultModels,
  PREFERENCE_KEYS,
  saveConfig,
  validateCommitAiConfig,
  writePreferenceToStorage,
} from "./config.js";
import { getCachedModels, refreshModels, type ModelRefreshOptions } from "./models.js";
import { DEPLOYMENT_CONFIG_KEYS, type RuntimeConfigState } from "./runtime-config.js";
import type { WandStorage } from "./storage.js";
import type { WandConfig } from "./types.js";
import { discoverCliSystemAiConfigs, normalizeSystemAiConfig } from "./system-ai.js";

interface SettingsDistributionPayload {
  androidApk: Record<string, unknown>;
  macosDmg: Record<string, unknown>;
}

interface SettingsBuildInfo {
  commit: string | null;
  builtAt: string | null;
  channel: string | null;
}

export interface ServerSettingsRoutesDependencies {
  storage: WandStorage;
  config: WandConfig;
  runtimeConfig: RuntimeConfigState;
  configPath: string;
  configDir: string;
  requireAdmin: RequestHandler;
  requireAdminOrSessionPreferences: RequestHandler;
  packageInfo: { version: string; name: string; nodeVersion: string; repoUrl: string };
  buildInfo: SettingsBuildInfo;
  getCachedUpdateInfo(): { updateAvailable: boolean; latest: string | null } | null;
  getUpdateChannel(): "stable" | "beta";
  getDistributionSettings(): Promise<SettingsDistributionPayload>;
  getModelRefreshOptions(): ModelRefreshOptions;
  resolveAppConnectCode(req: Request): { code: string; url: string };
}

function publicConfig(config: WandConfig): Record<string, unknown> {
  const { password: _password, appSecret: _appSecret, ...safe } = config;
  const defaultModels = getProviderDefaultModels(config);
  return {
    ...safe,
    systemAi: publicSystemAi(safe.systemAi),
    defaultModel: defaultModels.claude,
    defaultCodexModel: defaultModels.codex,
    defaultOpenCodeModel: defaultModels.opencode,
    defaultGrokModel: defaultModels.grok,
    defaultQoderModel: defaultModels.qoder,
    defaultModels,
  };
}

function publicSystemAi(systemAi: WandConfig["systemAi"]): Record<string, unknown> | undefined {
  if (!systemAi) return undefined;
  return {
    ...systemAi,
    apiKey: "",
    hasApiKey: Boolean(systemAi.apiKey),
    fallbacks: systemAi.fallbacks?.map((profile) => ({
      ...profile,
      apiKey: "",
      hasApiKey: Boolean(profile.apiKey),
      fallbacks: undefined,
    })),
  };
}

function publicDistributionInfo(distribution: SettingsDistributionPayload): SettingsDistributionPayload {
  const androidApk = { ...distribution.androidApk };
  const macosDmg = { ...distribution.macosDmg };
  // These server filesystem paths are useful to administrators, but the About
  // panel only needs versions, sizes, and download URLs.
  delete androidApk.apkDir;
  delete macosDmg.dmgDir;
  return { androidApk, macosDmg };
}

export function registerSettingsRoutes(app: Express, deps: ServerSettingsRoutesDependencies): void {
  const {
    storage,
    config,
    runtimeConfig,
    configPath,
    configDir,
    requireAdmin,
    requireAdminOrSessionPreferences,
  } = deps;

  app.get("/api/settings/about", asyncRoute(async (_req, res) => {
    const distribution = publicDistributionInfo(await deps.getDistributionSettings());
    const cachedUpdate = deps.getCachedUpdateInfo();
    res.json({
      settingsAccess: "read-only",
      version: deps.packageInfo.version,
      packageName: deps.packageInfo.name,
      nodeVersion: deps.packageInfo.nodeVersion,
      repoUrl: deps.packageInfo.repoUrl,
      updateAvailable: cachedUpdate?.updateAvailable ?? false,
      latestVersion: cachedUpdate?.latest ?? null,
      updateChannel: deps.getUpdateChannel(),
      build: {
        ...deps.buildInfo,
        shortCommit: deps.buildInfo.commit ? deps.buildInfo.commit.slice(0, 7) : null,
      },
      ...distribution,
    });
  }));

  app.get("/api/settings", requireAdmin, asyncRoute(async (_req, res) => {
    const desiredConfig = runtimeConfig.desiredSnapshot();
    const distribution = await deps.getDistributionSettings();
    const cachedUpdate = deps.getCachedUpdateInfo();
    res.json({
      settingsAccess: "admin",
      version: deps.packageInfo.version,
      packageName: deps.packageInfo.name,
      nodeVersion: deps.packageInfo.nodeVersion,
      repoUrl: deps.packageInfo.repoUrl,
      config: publicConfig(desiredConfig),
      desiredConfig: publicConfig(desiredConfig),
      activeConfig: publicConfig(config),
      restartRequired: runtimeConfig.hasPendingRestart(),
      hasCert: existsSync(path.join(configDir, "server.key")) && existsSync(path.join(configDir, "server.crt")),
      updateAvailable: cachedUpdate?.updateAvailable ?? false,
      latestVersion: cachedUpdate?.latest ?? null,
      updateChannel: deps.getUpdateChannel(),
      build: {
        ...deps.buildInfo,
        shortCommit: deps.buildInfo.commit ? deps.buildInfo.commit.slice(0, 7) : null,
      },
      autoUpdate: {
        web: storage.getConfigValue("autoUpdateWeb") === "true",
        apk: storage.getConfigValue("autoUpdateApk") === "true",
        dmg: storage.getConfigValue("autoUpdateDmg") === "true",
        cli: storage.getConfigValue("autoUpdateProviderClis") === "true",
      },
      ...distribution,
    });
  }));

  app.get("/api/settings/env-preview", (req, res, next) => {
    if (req.query.reveal === "1") return requireAdmin(req, res, next);
    next();
  }, (req, res) => {
    const inheritEnv = config.inheritEnv !== false;
    const env = buildChildEnv(inheritEnv, {
      WAND_MODE: "<runtime>",
      WAND_AUTO_CONFIRM: "<runtime>",
      WAND_AUTO_EDIT: "<runtime>",
    });
    const reveal = req.query.reveal === "1" || req.query.reveal === "true";
    const sensitivePattern = /(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|COOKIE|SESSION)/i;
    const entries = Object.keys(env).sort().map((name) => {
      const raw = env[name] ?? "";
      const sensitive = sensitivePattern.test(name);
      const placeholder = raw.startsWith("<") && raw.endsWith(">");
      return {
        name,
        value: sensitive && !reveal && !placeholder ? "***" : raw,
        length: raw.length,
        sensitive,
      };
    });
    res.json({ inheritEnv, total: entries.length, reveal, entries });
  });

  app.post("/api/settings/system-ai/import", requireAdmin, (req, res) => {
    const body = (req.body ?? {}) as { source?: unknown };
    const source = body.source === "codex" || body.source === "opencode" || body.source === "claude"
      ? body.source
      : config.commitCli;
    const imported = discoverCliSystemAiConfigs(source);
    if (!imported.length) {
      res.status(404).json({ error: "没有在已配置的 CLI 文件中找到可直连的 API 地址、密钥和模型。" });
      return;
    }
    const candidate = runtimeConfig.createCandidate();
    writePreferenceToStorage(candidate, storage, "systemAi", {
      ...imported[0],
      enabled: candidate.systemAi?.enabled === true,
      fallbacks: imported.slice(1),
    });
    runtimeConfig.commit(candidate, new Set(["systemAi"]));
    res.json({ ok: true, count: imported.length, systemAi: (publicConfig(candidate).systemAi) });
  });

  app.get("/api/app-connect-code", requireAdmin, (req, res) => {
    res.json(deps.resolveAppConnectCode(req));
  });

  app.post("/api/settings/config", requireAdminOrSessionPreferences, asyncRoute(async (req, res) => {
    const body = req.body as Partial<WandConfig> & {
      defaultModels?: { claude?: unknown; codex?: unknown; opencode?: unknown; grok?: unknown; qoder?: unknown };
      systemAi?: Record<string, unknown>;
    };
    const previousDesiredConfig = runtimeConfig.desiredSnapshot();
    const candidateConfig = runtimeConfig.createCandidate();
    const stagedPreferences: Array<{ key: string; value: unknown }> = [];
    const stagedPreferenceFields = new Set<(typeof PREFERENCE_KEYS)[number]>();
    const stagingStorage = {
      setPreference(key: string, value: unknown): void { stagedPreferences.push({ key, value }); },
    } as unknown as WandStorage;
    const stagePreference = (field: (typeof PREFERENCE_KEYS)[number], value: unknown): void => {
      writePreferenceToStorage(candidateConfig, stagingStorage, field, value, {
        deferCommitAiValidation: true,
      });
      stagedPreferenceFields.add(field);
    };
    let touchedDeployField = false;
    try {
      for (const field of DEPLOYMENT_CONFIG_KEYS) {
        if (!(field in body) || body[field] === undefined) continue;
        if (field === "port") {
          const port = Number(body.port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`无效端口号: ${body.port}`);
          candidateConfig.port = port;
        } else if (field === "https") {
          if (typeof body.https !== "boolean") throw new Error("https 必须是布尔值。");
          candidateConfig.https = body.https;
        } else if (field === "host") {
          if (typeof body.host !== "string" || !body.host.trim()) throw new Error("host 不能为空。");
          candidateConfig.host = body.host.trim();
        } else if (field === "shell") {
          if (typeof body.shell !== "string" || !body.shell.trim()) throw new Error("shell 不能为空。");
          candidateConfig.shell = body.shell.trim();
        }
        touchedDeployField = true;
      }
      if (body.defaultModels !== undefined) {
        if (!body.defaultModels || typeof body.defaultModels !== "object" || Array.isArray(body.defaultModels)) {
          throw new Error("defaultModels 必须是对象。");
        }
        if (Object.hasOwn(body.defaultModels, "claude")) stagePreference("defaultModel", body.defaultModels.claude);
        if (Object.hasOwn(body.defaultModels, "codex")) stagePreference("defaultCodexModel", body.defaultModels.codex);
        if (Object.hasOwn(body.defaultModels, "opencode")) stagePreference("defaultOpenCodeModel", body.defaultModels.opencode);
        if (Object.hasOwn(body.defaultModels, "grok")) stagePreference("defaultGrokModel", body.defaultModels.grok);
        if (Object.hasOwn(body.defaultModels, "qoder")) stagePreference("defaultQoderModel", body.defaultModels.qoder);
      }
      if (body.systemAi !== undefined) {
        if (!body.systemAi || typeof body.systemAi !== "object" || Array.isArray(body.systemAi)) {
          throw new Error("systemAi 必须是对象。");
        }
        const previous = candidateConfig.systemAi;
        const apiKey = typeof body.systemAi.apiKey === "string" && body.systemAi.apiKey.trim()
          ? body.systemAi.apiKey.trim()
          : previous?.apiKey ?? "";
        const submittedFallbacks = Array.isArray(body.systemAi.fallbacks)
          ? body.systemAi.fallbacks.map((item, index) => {
            const raw = item && typeof item === "object" && !Array.isArray(item) ? item as unknown as Record<string, unknown> : {};
            const prior = previous?.fallbacks?.[index];
            const fallbackApiKey = typeof raw.apiKey === "string" && raw.apiKey.trim() ? raw.apiKey.trim() : prior?.apiKey ?? "";
            return { ...prior, ...raw, apiKey: fallbackApiKey, fallbacks: undefined };
          })
          : previous?.fallbacks;
        stagePreference("systemAi", normalizeSystemAiConfig({ ...previous, ...body.systemAi, apiKey, fallbacks: submittedFallbacks }, previous));
      }
      for (const field of PREFERENCE_KEYS) {
        if (field === "systemAi") continue;
        const value = (body as Record<string, unknown>)[field];
        if (!(field in body) || value === undefined) continue;
        stagePreference(field, value);
      }
      validateCommitAiConfig(candidateConfig);
    } catch (error) {
      res.status(400).json({ error: getErrorMessage(error, "配置校验失败。") });
      return;
    }

    if (!touchedDeployField && stagedPreferences.length === 0) {
      res.status(400).json({ error: "没有可更新的配置字段。" });
      return;
    }
    let deployConfigWritten = false;
    try {
      if (touchedDeployField) {
        await saveConfig(configPath, candidateConfig);
        deployConfigWritten = true;
      }
      if (stagedPreferences.length > 0) {
        storage.transaction(() => {
          for (const mutation of stagedPreferences) storage.setPreference(mutation.key, mutation.value);
        });
      }
      runtimeConfig.commit(candidateConfig, stagedPreferenceFields);
      res.json({
        ok: true,
        config: publicConfig(candidateConfig),
        desiredConfig: publicConfig(candidateConfig),
        activeConfig: publicConfig(config),
        restartRequired: runtimeConfig.hasPendingRestart(),
      });
    } catch (error) {
      if (deployConfigWritten) {
        try { await saveConfig(configPath, previousDesiredConfig); } catch { /* preserve original */ }
      }
      res.status(500).json({ error: getErrorMessage(error, "保存配置失败。") });
    }
  }));

  app.get("/api/models", (_req, res) => {
    const cached = getCachedModels(deps.getModelRefreshOptions());
    const defaults = getProviderDefaultModels(config);
    res.json({
      ...cached,
      defaultModel: defaults.claude,
      defaultCodexModel: defaults.codex,
      defaultOpenCodeModel: defaults.opencode,
      defaultGrokModel: defaults.grok,
      defaultQoderModel: defaults.qoder,
      defaultModels: defaults,
    });
  });

  app.post("/api/models/refresh", asyncRoute(async (_req, res) => {
    try {
      const refreshed = await refreshModels({ ...deps.getModelRefreshOptions(), verifyClaudeCandidates: true });
      const defaults = getProviderDefaultModels(config);
      res.json({
        ...refreshed,
        defaultModel: defaults.claude,
        defaultCodexModel: defaults.codex,
        defaultOpenCodeModel: defaults.opencode,
        defaultGrokModel: defaults.grok,
        defaultQoderModel: defaults.qoder,
        defaultModels: defaults,
      });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "刷新模型列表失败。") });
    }
  }));

  app.post("/api/settings/upload-cert", requireAdmin, asyncRoute(async (req, res) => {
    const { key, cert } = req.body as { key?: string; cert?: string };
    if (!key || !cert) {
      res.status(400).json({ error: "请提供 key 和 cert 内容。" });
      return;
    }
    if (!key.includes("-----BEGIN") || !cert.includes("-----BEGIN")) {
      res.status(400).json({ error: "证书内容格式无效，请上传 PEM 格式的文件。" });
      return;
    }
    try {
      writeFileSync(path.join(configDir, "server.key"), key, { mode: 0o600 });
      writeFileSync(path.join(configDir, "server.crt"), cert, { mode: 0o600 });
      res.json({ ok: true, restartRequired: true });
    } catch (error) {
      res.status(500).json({ error: getErrorMessage(error, "保存证书失败。") });
    }
  }));
}
