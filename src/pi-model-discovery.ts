import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { ClaudeModelInfo } from "./types.js";

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SUPPORTED_APIS = new Set([
  "anthropic-messages",
  "google-generative-ai",
  "openai-completions",
  "openai-responses",
]);
const MAX_PAGES_PER_ENDPOINT = 40;
const MAX_MODELS_PER_ENDPOINT = 2000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

type JsonRecord = Record<string, unknown>;

export interface PiModelEndpointDiscoveryOptions {
  /** Defaults to PI_CODING_AGENT_DIR or ~/.pi/agent. */
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

interface PiEndpoint {
  provider: string;
  api: string;
  baseUrl: string;
  apiKey: string;
  apiKeyUnavailable: boolean;
  headers: Record<string, string>;
}

interface EndpointPage {
  models: ClaudeModelInfo[];
  nextCursor: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveConfigValue(value: unknown, env: NodeJS.ProcessEnv): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("!")) return null;
  const dollarEscape = "\u0000";
  const bangEscape = "\u0001";
  let missingReference = false;
  const expanded = trimmed
    .replace(/\$\$/g, dollarEscape)
    .replace(/\$!/g, bangEscape)
    .replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_match, braced: string | undefined, bare: string | undefined) => {
        const resolved = env[braced ?? bare ?? ""];
        if (resolved === undefined) {
          missingReference = true;
          return "";
        }
        return resolved;
      },
    )
    .replaceAll(dollarEscape, "$")
    .replaceAll(bangEscape, "!");
  return missingReference || !expanded.trim() ? null : expanded;
}

function configuredHeaders(
  value: unknown,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  if (!isRecord(value)) return {};
  const headers: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) continue;
    const headerValue = resolveConfigValue(rawValue, env);
    if (!headerValue || headerValue.length > 16_384 || /[\r\n]/.test(headerValue)) continue;
    headers[name] = headerValue;
  }
  return headers;
}

function endpointUrl(baseUrl: string, api: string): URL | null {
  try {
    const url = new URL(baseUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    const basePath = url.pathname.replace(/\/+$/, "");
    let suffix: string;
    if (api === "anthropic-messages") {
      suffix = /\/v\d+(?:beta)?$/i.test(basePath) ? "models" : "v1/models";
    } else if (api === "google-generative-ai") {
      suffix = /\/v\d+(?:beta)?$/i.test(basePath) ? "models" : "v1beta/models";
    } else {
      suffix = "models";
    }
    url.pathname = `${basePath}/${suffix}`.replace(/\/{2,}/g, "/");
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function providerEndpoints(
  providersValue: unknown,
  env: NodeJS.ProcessEnv,
): PiEndpoint[] {
  if (!isRecord(providersValue)) return [];
  const endpoints: PiEndpoint[] = [];
  for (const [provider, rawProvider] of Object.entries(providersValue)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider) || !isRecord(rawProvider)) continue;
    const providerApi = typeof rawProvider.api === "string" ? rawProvider.api.trim() : "";
    const providerBaseUrl = typeof rawProvider.baseUrl === "string" ? rawProvider.baseUrl.trim() : "";
    const providerApiKey = resolveConfigValue(rawProvider.apiKey, env) ?? "";
    const providerKeyConfigured = typeof rawProvider.apiKey === "string" && !!rawProvider.apiKey.trim();
    const providerHeaders = configuredHeaders(rawProvider.headers, env);
    const models = Array.isArray(rawProvider.models) ? rawProvider.models : [];
    const endpointConfigs: Array<{
      api: string;
      baseUrl: string;
      apiKey: string;
      apiKeyUnavailable: boolean;
      headers: Record<string, string>;
    }> = [{
      api: providerApi,
      baseUrl: providerBaseUrl,
      apiKey: providerApiKey,
      apiKeyUnavailable: providerKeyConfigured && !providerApiKey,
      headers: providerHeaders,
    }];
    for (const model of models) {
      if (!isRecord(model)) continue;
      const api = typeof model.api === "string" && model.api.trim() ? model.api.trim() : providerApi;
      const baseUrl = typeof model.baseUrl === "string" && model.baseUrl.trim()
        ? model.baseUrl.trim()
        : providerBaseUrl;
      const rawModelApiKey = model.apiKey;
      const modelApiKey = resolveConfigValue(rawModelApiKey, env);
      const apiKey = modelApiKey ?? providerApiKey;
      const apiKeyUnavailable = typeof rawModelApiKey === "string" && !!rawModelApiKey.trim()
        ? !modelApiKey
        : providerKeyConfigured && !providerApiKey;
      const headers = { ...providerHeaders, ...configuredHeaders(model.headers, env) };
      if (
        api !== providerApi || baseUrl !== providerBaseUrl || apiKey !== providerApiKey
        || JSON.stringify(headers) !== JSON.stringify(providerHeaders)
      ) {
        endpointConfigs.push({ api, baseUrl, apiKey, apiKeyUnavailable, headers });
      }
    }
    const seen = new Set<string>();
    for (const config of endpointConfigs) {
      if (!SUPPORTED_APIS.has(config.api) || !config.baseUrl || config.apiKeyUnavailable) continue;
      const url = endpointUrl(config.baseUrl, config.api);
      if (!url) continue;
      // Keep this key in memory only; never log or persist endpoint credentials.
      const signature = `${config.api}\n${url.href}\n${config.apiKey}\n${JSON.stringify(config.headers)}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      endpoints.push({ provider, ...config });
    }
  }
  return endpoints;
}

function asModelId(value: unknown, api: string): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (api === "google-generative-ai") return trimmed.replace(/^models\//, "");
  return trimmed;
}

function parseEndpointPage(api: string, body: unknown, provider: string): EndpointPage {
  if (!isRecord(body)) return { models: [], nextCursor: "" };
  const rows = Array.isArray(body.data)
    ? body.data
    : Array.isArray(body.models) ? body.models : [];
  const models: ClaudeModelInfo[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = asModelId(api === "google-generative-ai" ? row.name : row.id, api);
    const qualifiedId = `${provider}/${id}`;
    if (!id || id.length > 128 || !MODEL_ID_PATTERN.test(id) || !MODEL_ID_PATTERN.test(qualifiedId)) continue;
    const displayName = typeof row.display_name === "string" ? row.display_name.trim()
      : typeof row.displayName === "string" ? row.displayName.trim()
        : typeof row.name === "string" && api !== "google-generative-ai" ? row.name.trim() : "";
    models.push({
      id: qualifiedId,
      label: displayName && displayName !== id ? `${displayName} · ${qualifiedId}` : qualifiedId,
    });
  }
  let nextCursor = "";
  if (api === "google-generative-ai") {
    nextCursor = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
  } else if (body.has_more === true) {
    const lastRow = rows.at(-1);
    const lastRowId = isRecord(lastRow) && typeof lastRow.id === "string" ? lastRow.id : "";
    nextCursor = typeof body.last_id === "string" ? body.last_id : lastRowId;
  }
  return { models, nextCursor };
}

function pageUrl(endpoint: PiEndpoint, cursor: string): URL | null {
  const url = endpointUrl(endpoint.baseUrl, endpoint.api);
  if (!url) return null;
  if (cursor) {
    const key = endpoint.api === "google-generative-ai" ? "pageToken"
      : endpoint.api === "anthropic-messages" ? "after_id" : "after";
    url.searchParams.set(key, cursor);
  }
  return url;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: URL,
  headers: Record<string, string>,
): Promise<unknown | null> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) return null;
    return JSON.parse(text) as unknown;
  } catch {
    // Provider errors can echo private endpoint URLs or request credentials. Discovery is
    // best-effort, so keep failures private and leave the Pi CLI catalog available.
    return null;
  }
}

async function fetchEndpointModels(
  endpoint: PiEndpoint,
  fetchImpl: typeof fetch,
): Promise<ClaudeModelInfo[]> {
  const result: ClaudeModelInfo[] = [];
  const seen = new Set<string>();
  let cursor = "";
  for (let page = 0; page < MAX_PAGES_PER_ENDPOINT && result.length < MAX_MODELS_PER_ENDPOINT; page++) {
    const url = pageUrl(endpoint, cursor);
    if (!url) break;
    const headers = { ...endpoint.headers };
    if (endpoint.apiKey) {
      if (endpoint.api === "google-generative-ai") headers["x-goog-api-key"] = endpoint.apiKey;
      else if (endpoint.api === "anthropic-messages") {
        headers["x-api-key"] = endpoint.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else headers.authorization = `Bearer ${endpoint.apiKey}`;
    }
    const body = await fetchJson(fetchImpl, url, headers);
    if (!body) break;
    const parsed = parseEndpointPage(endpoint.api, body, endpoint.provider);
    for (const model of parsed.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      result.push(model);
      if (result.length >= MAX_MODELS_PER_ENDPOINT) break;
    }
    if (!parsed.nextCursor || parsed.nextCursor === cursor) break;
    cursor = parsed.nextCursor;
  }
  return result;
}

/**
 * Discovers additional chat model IDs exposed by the API endpoints configured in Pi's models.json.
 * The endpoint's key stays in memory and is never returned, logged, or persisted in the model catalog.
 */
export async function discoverPiEndpointModels(
  options: PiModelEndpointDiscoveryOptions = {},
): Promise<ClaudeModelInfo[]> {
  const env = options.env ?? process.env;
  const agentDir = options.agentDir?.trim()
    || env.PI_CODING_AGENT_DIR?.trim()
    || path.join(env.HOME?.trim() || homedir(), ".pi", "agent");
  let config: unknown;
  try {
    const contents = await readFile(path.join(path.resolve(agentDir), "models.json"), "utf8");
    config = JSON.parse(contents) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(config)) return [];
  const endpoints = providerEndpoints(config.providers, env);
  if (!endpoints.length) return [];
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const lists = await Promise.all(endpoints.map((endpoint) => fetchEndpointModels(endpoint, fetchImpl)));
  const result: ClaudeModelInfo[] = [];
  const seen = new Set<string>();
  for (const models of lists) {
    for (const model of models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      result.push(model);
    }
  }
  return result;
}
