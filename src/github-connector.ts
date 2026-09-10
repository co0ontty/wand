import type { WandStorage } from "./storage.js";

export const GITHUB_PROVIDER = "github";
export const GITHUB_API_URL = "https://api.github.com";

export interface GithubConnectorStatus {
  provider: "github";
  connected: boolean;
  apiUrl: string | null;
  username: string | null;
  connectedAt: string | null;
  updatedAt: string | null;
  scopes: string[];
}

export interface GithubApiResponse<T> {
  data: T;
  headers: Headers;
}

function normalizeApiUrl(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : GITHUB_API_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("GitHub API 地址无效。");
  }
  const local = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    throw new Error("GitHub API 地址必须使用 HTTPS（本地测试可使用 HTTP）。");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function getGithubApiUrl(storage: WandStorage): string {
  return normalizeApiUrl(storage.getConnectorMeta(GITHUB_PROVIDER)?.apiUrl || GITHUB_API_URL);
}

export function getGithubConnectorStatus(storage: WandStorage): GithubConnectorStatus {
  const meta = storage.getConnectorMeta(GITHUB_PROVIDER);
  const token = storage.getConnectorToken(GITHUB_PROVIDER);
  return {
    provider: "github",
    connected: Boolean(token && meta?.connectedAt),
    apiUrl: meta?.apiUrl || null,
    username: meta?.username || null,
    connectedAt: meta?.connectedAt || null,
    updatedAt: meta?.updatedAt || null,
    scopes: [],
  };
}

function connectorToken(storage: WandStorage): string {
  const token = storage.getConnectorToken(GITHUB_PROVIDER)?.trim();
  if (!token) throw new Error("GitHub 尚未连接，请先在设置中保存 Token。");
  return token;
}

function apiPath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname.includes("\\") || pathname.includes("..")) {
    throw new Error("GitHub API 路径无效。");
  }
  return pathname;
}

export async function githubRequest<T = unknown>(
  storage: WandStorage,
  pathname: string,
  init: RequestInit = {},
): Promise<GithubApiResponse<T>> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", "wand-github-connector");
  headers.set("Authorization", `Bearer ${connectorToken(storage)}`);
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const response = await fetch(`${getGithubApiUrl(storage)}${apiPath(pathname)}`, { ...init, headers });
  const raw = await response.text();
  let data: unknown = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw.slice(0, 2000); }
  if (!response.ok) {
    const message = data && typeof data === "object" && "message" in data && typeof data.message === "string"
      ? data.message
      : `GitHub API 请求失败（${response.status}）。`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return { data: data as T, headers: response.headers };
}

export async function connectGithub(
  storage: WandStorage,
  token: string,
  apiUrl?: string,
): Promise<GithubConnectorStatus> {
  const normalizedToken = token.trim();
  if (!normalizedToken) throw new Error("GitHub Token 不能为空。");
  const targetApiUrl = normalizeApiUrl(apiUrl);
  const previous = storage.getConnectorMeta(GITHUB_PROVIDER);
  const previousToken = storage.getConnectorToken(GITHUB_PROVIDER);
  storage.saveConnector(GITHUB_PROVIDER, { token: normalizedToken, apiUrl: targetApiUrl, markConnected: false });
  try {
    const profile = await githubRequest<{ login?: unknown }>(storage, "/user");
    const username = typeof profile.data.login === "string" ? profile.data.login : "";
    if (!username) throw new Error("GitHub 返回的账号信息无效。");
    const scopes = (profile.headers.get("x-oauth-scopes") || "")
      .split(",").map((scope) => scope.trim()).filter(Boolean);
    const meta = storage.saveConnector(GITHUB_PROVIDER, {
      apiUrl: targetApiUrl,
      username,
      markConnected: true,
    });
    return { ...getGithubConnectorStatus(storage), ...meta, provider: "github", connected: true, scopes };
  } catch (error) {
    if (previous?.connectedAt && previousToken) {
      storage.saveConnector(GITHUB_PROVIDER, {
        token: previousToken,
        apiUrl: previous.apiUrl,
        username: previous.username,
        markConnected: true,
      });
    } else {
      storage.deleteConnector(GITHUB_PROVIDER);
    }
    throw error;
  }
}

export function githubStatusWithScopes(storage: WandStorage, scopes: string[] = []): GithubConnectorStatus {
  return { ...getGithubConnectorStatus(storage), scopes };
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}
