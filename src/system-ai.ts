import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { SessionProvider, SystemAiConfig, SystemAiProtocol } from "./types.js";

const SYSTEM_AI_TIMEOUT_MS = 60_000;
const SYSTEM_AI_ROUTE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

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
    id: typeof raw.id === "string" && SYSTEM_AI_ROUTE_ID_PATTERN.test(raw.id.trim())
      ? raw.id.trim()
      : fallback?.id ?? randomUUID(),
    enabled: raw.enabled === true,
    protocol,
    baseUrl,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : fallback?.apiKey ?? "",
    model: typeof raw.model === "string" ? raw.model.trim() : fallback?.model ?? "",
    authHeader: raw.authHeader === "x-api-key" ? "x-api-key" : "bearer",
    source: raw.source === "claude" || raw.source === "codex" || raw.source === "opencode" || raw.source === "grok"
      ? raw.source
      : "custom",
  };
  if (Array.isArray(raw.fallbacks)) {
    normalized.fallbacks = raw.fallbacks
      .map((item) => {
        try {
          const itemId = item && typeof item === "object" && !Array.isArray(item)
            && typeof (item as Partial<SystemAiConfig>).id === "string"
            ? (item as Partial<SystemAiConfig>).id!.trim()
            : "";
          const itemFallback = itemId
            ? fallback?.fallbacks?.find((profile) => profile.id === itemId)
            : undefined;
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

function tryNormalizeSystemAiConfig(value: unknown): SystemAiConfig | null {
  try {
    return normalizeSystemAiConfig(value);
  } catch {
    // A stale or partially edited tool profile must not prevent the remaining
    // APIs—or the final current-session CLI fallback—from being tried.
    return null;
  }
}

function systemAiProfileKey(profile: SystemAiConfig): string {
  // Credential is intentionally part of runtime dedupe: if a stored key is
  // stale but a tool config has already rotated it, the discovered route must
  // remain available later in the same fallback chain. Import handles that
  // case separately by refreshing the stored route in place.
  return [
    profile.protocol,
    profile.baseUrl,
    profile.apiKey,
    profile.model,
    profile.authHeader ?? "bearer",
  ].join("\0");
}

function readJson(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseTomlString(raw: string): string | null {
  const value = raw.trim();
  if (value.startsWith('"')) {
    const quoted = /^"(?:\\.|[^"\\])*"/.exec(value)?.[0];
    if (!quoted) return null;
    try {
      const parsed = JSON.parse(quoted);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end < 0 ? null : value.slice(1, end);
  }
  return null;
}

function readTomlStringSections(filePath: string): Map<string, Map<string, string>> | null {
  if (!existsSync(filePath)) return null;
  try {
    const sections = new Map<string, Map<string, string>>();
    let section = "";
    sections.set(section, new Map());
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const sectionMatch = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
      if (sectionMatch) {
        section = sectionMatch[1]!.trim();
        if (!sections.has(section)) sections.set(section, new Map());
        continue;
      }
      const assignment = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
      if (!assignment) continue;
      const value = parseTomlString(assignment[2]!);
      if (value !== null) sections.get(section)!.set(assignment[1]!, value);
    }
    return sections;
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
  return tryNormalizeSystemAiConfig({
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
    const profile = tryNormalizeSystemAiConfig({
      enabled: true,
      protocol: "openai",
      baseUrl,
      apiKey,
      model: configuredModel,
      authHeader: "bearer",
      source: "opencode",
    });
    if (profile) found.push(profile);
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
  return tryNormalizeSystemAiConfig({ enabled: true, protocol: "openai", baseUrl, apiKey, model, authHeader: "bearer", source: "codex" });
}

function discoverGrok(home: string): SystemAiConfig[] {
  const sections = readTomlStringSections(path.join(home, ".grok", "config.toml"));
  if (!sections) return [];
  const defaultProfile = sections.get("models")?.get("default") ?? "";
  const modelSections = [...sections.entries()].filter(([name]) => name.startsWith("model."));
  const orderedSections = [
    ...modelSections.filter(([name]) => name === `model.${defaultProfile}`),
    ...modelSections.filter(([name]) => name !== `model.${defaultProfile}`),
  ];
  const found: SystemAiConfig[] = [];
  for (const [section, values] of orderedSections) {
    if (values.get("api_backend")?.trim().toLowerCase() !== "chat_completions") continue;
    const apiKey = values.get("api_key") ?? "";
    const baseUrl = values.get("base_url") ?? "";
    const model = values.get("model") ?? section.slice("model.".length);
    if (!apiKey || !baseUrl || !model) continue;
    const profile = tryNormalizeSystemAiConfig({
      enabled: true,
      protocol: "openai",
      baseUrl,
      apiKey,
      model,
      authHeader: "bearer",
      source: "grok",
    });
    if (profile) found.push(profile);
  }
  return found;
}

/** Copy every usable direct-API profile from the user's configured CLIs. */
export function discoverCliSystemAiConfigs(preferred?: SessionProvider, home = os.homedir()): SystemAiConfig[] {
  const discoverers = {
    claude: (dir: string) => [discoverClaude(dir)].filter((item): item is SystemAiConfig => item !== null),
    codex: (dir: string) => [discoverCodex(dir)].filter((item): item is SystemAiConfig => item !== null),
    opencode: discoverOpenCode,
    grok: discoverGrok,
  } as const;
  const order: SessionProvider[] = [preferred ?? "claude", "claude", "opencode", "grok", "codex"];
  const found: SystemAiConfig[] = [];
  const seen = new Set<string>();
  for (const provider of [...new Set(order)]) {
    if (provider === "qoder" || provider === "pi") continue;
    let discovered: SystemAiConfig[];
    try {
      discovered = discoverers[provider](home);
    } catch {
      continue;
    }
    for (const profile of discovered) {
      const key = systemAiProfileKey(profile);
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
    const normalized = tryNormalizeSystemAiConfig({ ...candidate, enabled: true, fallbacks: undefined });
    if (!normalized) return [];
    if (!normalized.baseUrl || !normalized.apiKey || !normalized.model) return [];
    const key = systemAiProfileKey(normalized);
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
}

/**
 * Flatten and combine direct-API groups in caller-defined priority order.
 * Later groups are appended after earlier groups and duplicate routes are skipped.
 */
export function mergeSystemAiConfigs(
  ...groups: Array<SystemAiConfig | SystemAiConfig[] | undefined>
): SystemAiConfig | undefined {
  const profiles: SystemAiConfig[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const config of Array.isArray(group) ? group : group ? [group] : []) {
      for (const profile of systemAiProfiles(config, true)) {
        const key = systemAiProfileKey(profile);
        if (seen.has(key)) continue;
        seen.add(key);
        profiles.push({ ...profile, enabled: true, fallbacks: undefined });
      }
    }
  }
  const [primary, ...fallbacks] = profiles;
  if (!primary) return undefined;
  const merged: SystemAiConfig = { ...primary, enabled: true };
  if (fallbacks.length) merged.fallbacks = fallbacks;
  return merged;
}

function endpoint(baseUrl: string, protocol: SystemAiProtocol): string {
  const url = new URL(baseUrl);
  const pathName = url.pathname.replace(/\/+$/, "");
  const fullSuffix = protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  const shortSuffix = protocol === "anthropic" ? "/messages" : "/chat/completions";
  if (pathName.toLowerCase().endsWith(shortSuffix)) {
    url.pathname = pathName;
  } else if (/\/v\d+(?:\.\d+)?$/i.test(pathName)) {
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
    if (normalized.authHeader === "x-api-key") headers["x-api-key"] = normalized.apiKey;
    else headers.authorization = `Bearer ${normalized.apiKey}`;
  }
  const body = normalized.protocol === "anthropic"
    ? { model: normalized.model, max_tokens: 2048, messages: [{ role: "user", content: prompt }] }
    : {
      model: normalized.model,
      // Quick system tasks should not silently inherit a model's expensive
      // default reasoning level. Settings probes a route with this same
      // payload, so an incompatible endpoint fails visibly before it is used.
      reasoning_effort: "low",
      messages: [{ role: "user", content: prompt }],
      stream: false,
    };
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
