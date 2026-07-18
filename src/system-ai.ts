import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SessionProvider, SystemAiConfig, SystemAiProtocol } from "./types.js";

const SYSTEM_AI_TIMEOUT_MS = 60_000;

export class SystemAiError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "SystemAiError";
  }
}

export function normalizeSystemAiConfig(value: unknown, fallback?: SystemAiConfig): SystemAiConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("systemAi 必须是对象。");
  }
  const raw = value as Partial<SystemAiConfig>;
  const protocol: SystemAiProtocol = raw.protocol === "anthropic" ? "anthropic" : "openai";
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim().replace(/\/+$/, "") : fallback?.baseUrl ?? "";
  if (baseUrl) {
    let parsed: URL;
    try { parsed = new URL(baseUrl); } catch { throw new Error("系统 AI API 地址无效。"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("系统 AI API 地址必须使用 http 或 https。");
  }
  const normalized: SystemAiConfig = {
    enabled: raw.enabled === true,
    protocol,
    baseUrl,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : fallback?.apiKey ?? "",
    model: typeof raw.model === "string" ? raw.model.trim() : fallback?.model ?? "",
    authHeader: raw.authHeader === "x-api-key" ? "x-api-key" : "bearer",
    source: raw.source === "claude" || raw.source === "codex" || raw.source === "opencode" ? raw.source : "custom",
  };
  if (Array.isArray(raw.fallbacks)) {
    normalized.fallbacks = raw.fallbacks
      .map((item, index) => {
        try {
          const itemFallback = fallback?.fallbacks?.[index];
          const profile = normalizeSystemAiConfig(item, itemFallback);
          delete profile.fallbacks;
          return profile;
        } catch {
          return null;
        }
      })
      .filter((item): item is SystemAiConfig => item !== null);
  } else if (fallback?.fallbacks?.length) {
    normalized.fallbacks = fallback.fallbacks.map((item) => ({ ...item, fallbacks: undefined }));
  }
  return normalized;
}

function readJson(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function discoverClaude(home: string): SystemAiConfig | null {
  const settings = readJson(path.join(home, ".claude", "settings.json"));
  const env = settings?.env && typeof settings.env === "object" ? settings.env as Record<string, unknown> : {};
  const apiKey = typeof env.ANTHROPIC_AUTH_TOKEN === "string" ? env.ANTHROPIC_AUTH_TOKEN
    : typeof env.ANTHROPIC_API_KEY === "string" ? env.ANTHROPIC_API_KEY : "";
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : "https://api.anthropic.com";
  const model = typeof settings?.model === "string" ? settings.model : "";
  if (!apiKey || !model) return null;
  return normalizeSystemAiConfig({
    enabled: true, protocol: "anthropic", baseUrl, apiKey, model,
    authHeader: typeof env.ANTHROPIC_AUTH_TOKEN === "string" ? "bearer" : "x-api-key",
    source: "claude",
  });
}

function discoverOpenCode(home: string): SystemAiConfig[] {
  const config = readJson(path.join(home, ".config", "opencode", "opencode.json"));
  const selectedModel = typeof config?.model === "string" ? config.model : "";
  const providerId = selectedModel.split("/", 1)[0] ?? "";
  const providers = config?.provider && typeof config.provider === "object" ? config.provider as Record<string, unknown> : {};
  const orderedProviders = [providerId, ...Object.keys(providers).filter((id) => id !== providerId)];
  const found: SystemAiConfig[] = [];
  for (const id of orderedProviders) {
    const provider = providers[id] && typeof providers[id] === "object" ? providers[id] as Record<string, unknown> : null;
    const options = provider?.options && typeof provider.options === "object" ? provider.options as Record<string, unknown> : {};
    const apiKey = typeof options.apiKey === "string" ? options.apiKey : "";
    const baseUrl = typeof options.baseURL === "string" ? options.baseURL : typeof options.baseUrl === "string" ? options.baseUrl : "";
    const models = provider?.models && typeof provider.models === "object" ? provider.models as Record<string, unknown> : {};
    const configuredModel = id === providerId && selectedModel
      ? (selectedModel.includes("/") ? selectedModel.slice(selectedModel.indexOf("/") + 1) : selectedModel)
      : typeof provider?.model === "string" ? provider.model : Object.keys(models)[0] ?? "";
    if (!apiKey || !baseUrl || !configuredModel) continue;
    found.push(normalizeSystemAiConfig({
      enabled: true,
      protocol: "openai",
      baseUrl,
      apiKey,
      model: configuredModel,
      authHeader: "bearer",
      source: "opencode",
    }));
  }
  return found;
}

function discoverCodex(home: string): SystemAiConfig | null {
  const auth = readJson(path.join(home, ".codex", "auth.json"));
  const apiKey = typeof auth?.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : "";
  if (!apiKey) return null;
  let model = "";
  let baseUrl = "https://api.openai.com";
  try {
    const toml = readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    model = /^model\s*=\s*["']([^"']+)["']/m.exec(toml)?.[1] ?? "";
    baseUrl = /^(?:base_url|baseURL)\s*=\s*["']([^"']+)["']/m.exec(toml)?.[1] ?? baseUrl;
  } catch { /* optional config */ }
  if (!model) return null;
  return normalizeSystemAiConfig({ enabled: true, protocol: "openai", baseUrl, apiKey, model, authHeader: "bearer", source: "codex" });
}

/** Copy every usable direct-API profile from the user's configured CLIs. */
export function discoverCliSystemAiConfigs(preferred?: SessionProvider, home = os.homedir()): SystemAiConfig[] {
  const discoverers = {
    claude: (dir: string) => [discoverClaude(dir)].filter((item): item is SystemAiConfig => item !== null),
    codex: (dir: string) => [discoverCodex(dir)].filter((item): item is SystemAiConfig => item !== null),
    opencode: discoverOpenCode,
  } as const;
  const order: SessionProvider[] = [preferred ?? "claude", "claude", "opencode", "codex"];
  const found: SystemAiConfig[] = [];
  const seen = new Set<string>();
  for (const provider of [...new Set(order)]) {
    if (provider === "grok" || provider === "qoder") continue;
    for (const profile of discoverers[provider](home)) {
      const key = [profile.protocol, profile.baseUrl, profile.apiKey, profile.model].join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(profile);
    }
  }
  return found;
}

/** Backward-compatible first-profile discovery. */
export function discoverCliSystemAiConfig(preferred?: SessionProvider, home = os.homedir()): SystemAiConfig | null {
  return discoverCliSystemAiConfigs(preferred, home)[0] ?? null;
}

/** Return the configured API chain in call order, excluding incomplete entries. */
export function systemAiProfiles(config: SystemAiConfig | undefined, forceEnabled = false): SystemAiConfig[] {
  if (!config || (!forceEnabled && !config.enabled)) return [];
  const candidates = [config, ...(config.fallbacks ?? [])];
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const normalized = normalizeSystemAiConfig({ ...candidate, enabled: true, fallbacks: undefined });
    if (!normalized.baseUrl || !normalized.apiKey || !normalized.model) return [];
    const key = [normalized.protocol, normalized.baseUrl, normalized.apiKey, normalized.model].join("\0");
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
}

function endpoint(baseUrl: string, protocol: SystemAiProtocol): string {
  const url = new URL(baseUrl);
  const pathName = url.pathname.replace(/\/+$/, "");
  const fullSuffix = protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  const shortSuffix = protocol === "anthropic" ? "/messages" : "/chat/completions";
  if (pathName.toLowerCase().endsWith(fullSuffix)) {
    url.pathname = pathName;
  } else if (pathName.toLowerCase().endsWith("/v1")) {
    url.pathname = `${pathName}${shortSuffix}`;
  } else {
    url.pathname = `${pathName}${fullSuffix}`;
  }
  return url.toString();
}

export async function callSystemAiText(prompt: string, config: SystemAiConfig, timeoutMs = SYSTEM_AI_TIMEOUT_MS): Promise<string> {
  const normalized = normalizeSystemAiConfig(config);
  if (!normalized.enabled || !normalized.baseUrl || !normalized.apiKey || !normalized.model) {
    throw new SystemAiError("系统 AI API 配置不完整。", "SYSTEM_AI_CONFIG_INVALID");
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (normalized.protocol === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
    if (normalized.authHeader === "x-api-key") headers["x-api-key"] = normalized.apiKey;
    else headers.authorization = `Bearer ${normalized.apiKey}`;
  } else {
    headers.authorization = `Bearer ${normalized.apiKey}`;
  }
  const body = normalized.protocol === "anthropic"
    ? { model: normalized.model, max_tokens: 2048, messages: [{ role: "user", content: prompt }] }
    : { model: normalized.model, messages: [{ role: "user", content: prompt }], stream: false };
  let response: Response;
  try {
    response = await fetch(endpoint(normalized.baseUrl, normalized.protocol), {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new SystemAiError(timedOut ? "系统 AI API 调用超时。" : `系统 AI API 无法连接：${error instanceof Error ? error.message : String(error)}`, timedOut ? "SYSTEM_AI_TIMEOUT" : "SYSTEM_AI_REQUEST_FAILED");
  }
  const raw = await response.text();
  if (!response.ok) throw new SystemAiError(`系统 AI API 返回 ${response.status}：${raw.slice(0, 500)}`, "SYSTEM_AI_REQUEST_FAILED");
  try {
    const data = JSON.parse(raw) as { content?: Array<{ type?: string; text?: string }>; choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }> };
    if (normalized.protocol === "anthropic") return (data.content ?? []).map((item) => item.text ?? "").join("\n").trim();
    const content = data.choices?.[0]?.message?.content;
    return typeof content === "string" ? content.trim() : Array.isArray(content) ? content.map((item) => item.text ?? "").join("\n").trim() : "";
  } catch {
    throw new SystemAiError("系统 AI API 返回了无法解析的响应。", "SYSTEM_AI_INVALID_RESPONSE");
  }
}

/** Try every configured API in order. Empty responses are treated as unavailable. */
export async function callSystemAiTextWithFallback(
  prompt: string,
  config: SystemAiConfig,
  timeoutMs = SYSTEM_AI_TIMEOUT_MS,
): Promise<string> {
  const profiles = systemAiProfiles(config, true);
  if (!profiles.length) {
    throw new SystemAiError("系统 AI API 配置不完整。", "SYSTEM_AI_CONFIG_INVALID");
  }
  const errors: string[] = [];
  for (const profile of profiles) {
    try {
      const text = await callSystemAiText(prompt, profile, timeoutMs);
      if (text.trim()) return text;
      errors.push(`${profile.source ?? "custom"}: 返回空结果`);
    } catch (error) {
      errors.push(`${profile.source ?? "custom"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new SystemAiError(`所有系统 AI API 均不可用：${errors.join("；")}`, "SYSTEM_AI_ALL_FAILED");
}
