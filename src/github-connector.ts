import type { WandStorage } from "./storage.js";

export const GITHUB_PROVIDER = "github";
export const GITHUB_API_URL = "https://api.github.com";
export const GITHUB_REQUEST_TIMEOUT_MS = 15_000;

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

export interface GithubRequestOptions {
  token?: string;
  apiUrl?: string;
  timeoutMs?: number;
}

type ConnectorSnapshot = {
  meta: ReturnType<WandStorage["getConnectorMeta"]>;
  token: string | null;
};

let connectEpoch = 0;
let connectAbort: AbortController | null = null;

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

function requestTimeoutError(): Error {
  const error = new Error("GitHub API 请求超时。") as Error & { status?: number };
  error.status = 504;
  return error;
}

/** Reject when the timeout fires, even if a transport resolves after aborting. */
function timeoutRejection(timeout: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (timeout.aborted) {
      reject(requestTimeoutError());
      return;
    }
    timeout.addEventListener("abort", () => reject(requestTimeoutError()), { once: true });
  });
}

function snapshotConnector(storage: WandStorage): ConnectorSnapshot {
  return {
    meta: storage.getConnectorMeta(GITHUB_PROVIDER),
    token: storage.getConnectorToken(GITHUB_PROVIDER),
  };
}

export async function githubRequest<T = unknown>(
  storage: WandStorage,
  pathname: string,
  init: RequestInit = {},
  options?: GithubRequestOptions,
): Promise<GithubApiResponse<T>> {
  const token = options?.token?.trim() || connectorToken(storage);
  const apiUrl = normalizeApiUrl(options?.apiUrl ?? storage.getConnectorMeta(GITHUB_PROVIDER)?.apiUrl ?? GITHUB_API_URL);
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", "wand-github-connector");
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const timeoutMs = options?.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await Promise.race([
      fetch(`${apiUrl}${apiPath(pathname)}`, { ...init, headers, signal }),
      timeoutRejection(timeout),
    ]);
  } catch (error) {
    if (timeout.aborted && !init.signal?.aborted) throw requestTimeoutError();
    throw error;
  }

  const raw = await response.text();
  let data: unknown = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw.slice(0, 2000); }
  if (!response.ok) {
    const message = data && typeof data === "object" && "message" in data && typeof data.message === "string"
      ? data.message
      : `GitHub API 请求失败（${response.status}）。`;
    const requestError = new Error(message) as Error & { status?: number };
    requestError.status = response.status;
    throw requestError;
  }
  return { data: data as T, headers: response.headers };
}

function parseScopes(headers: Headers): string[] {
  return (headers.get("x-oauth-scopes") || "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function restoreConnector(storage: WandStorage, snapshot: ConnectorSnapshot): void {
  if (snapshot.meta?.connectedAt && snapshot.token) {
    storage.saveConnector(GITHUB_PROVIDER, {
      token: snapshot.token,
      apiUrl: snapshot.meta.apiUrl,
      username: snapshot.meta.username,
      markConnected: true,
    });
    return;
  }
  storage.deleteConnector(GITHUB_PROVIDER);
}

interface ConnectAttempt {
  epoch: number;
  token: string;
  apiUrl: string;
  wrote: boolean;
  previous: ConnectorSnapshot;
}

/** Undo this attempt's own connector write, without clobbering a newer connect. */
function rollbackOwnConnectWrite(storage: WandStorage, attempt: ConnectAttempt): void {
  if (attempt.epoch !== connectEpoch || !attempt.wrote) return;
  const current = snapshotConnector(storage);
  const wroteThisAttempt = current.token === attempt.token && current.meta?.apiUrl === attempt.apiUrl;
  if (!wroteThisAttempt) return;
  restoreConnector(storage, attempt.previous);
}

export async function connectGithub(
  storage: WandStorage,
  token: string,
  apiUrl?: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<GithubConnectorStatus> {
  const normalizedToken = token.trim();
  if (!normalizedToken) throw new Error("GitHub Token 不能为空。");
  const targetApiUrl = normalizeApiUrl(apiUrl);
  const previous = snapshotConnector(storage);
  const epoch = ++connectEpoch;
  connectAbort?.abort();
  const abort = new AbortController();
  connectAbort = abort;
  const signal = options?.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  let wrote = false;

  try {
    const profile = await githubRequest<{ login?: unknown }>(storage, "/user", { signal }, {
      token: normalizedToken,
      apiUrl: targetApiUrl,
      timeoutMs: options?.timeoutMs,
    });
    const username = typeof profile.data.login === "string" ? profile.data.login : "";
    if (!username) throw new Error("GitHub 返回的账号信息无效。");
    if (epoch !== connectEpoch) throw new Error("GitHub 连接请求已过期。");
    const scopes = parseScopes(profile.headers);
    const meta = storage.saveConnector(GITHUB_PROVIDER, {
      token: normalizedToken,
      apiUrl: targetApiUrl,
      username,
      markConnected: true,
    });
    wrote = true;
    if (epoch !== connectEpoch) throw new Error("GitHub 连接请求已过期。");
    return { ...getGithubConnectorStatus(storage), ...meta, provider: "github", connected: true, scopes };
  } catch (error) {
    rollbackOwnConnectWrite(storage, {
      epoch,
      token: normalizedToken,
      apiUrl: targetApiUrl,
      wrote,
      previous,
    });
    throw error;
  } finally {
    if (connectAbort === abort) connectAbort = null;
  }
}

