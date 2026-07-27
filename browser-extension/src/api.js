import { DEFAULT_BASE_URL, normalizeBaseUrl } from "../shared/url-tools.mjs";

export const STORAGE_KEYS = {
  baseUrl: "wand.baseUrl",
  appToken: "wand.appToken",
  passkeyProxyEnabled: "wand.passkeyProxyEnabled"
};

export function extensionStorage() {
  if (globalThis.chrome?.storage?.local) return globalThis.chrome.storage.local;
  throw new Error("Browser extension storage is unavailable.");
}

export async function getSettings() {
  const data = await extensionStorage().get({
    [STORAGE_KEYS.baseUrl]: DEFAULT_BASE_URL,
    [STORAGE_KEYS.appToken]: "",
    [STORAGE_KEYS.passkeyProxyEnabled]: true
  });
  return {
    baseUrl: normalizeBaseUrl(data[STORAGE_KEYS.baseUrl]),
    appToken: data[STORAGE_KEYS.appToken] || "",
    passkeyProxyEnabled: data[STORAGE_KEYS.passkeyProxyEnabled] !== false
  };
}

export async function saveSettings(settings) {
  const payload = {};
  if (settings.baseUrl !== undefined) payload[STORAGE_KEYS.baseUrl] = normalizeBaseUrl(settings.baseUrl);
  if (settings.appToken !== undefined) payload[STORAGE_KEYS.appToken] = settings.appToken || "";
  if (settings.passkeyProxyEnabled !== undefined) payload[STORAGE_KEYS.passkeyProxyEnabled] = settings.passkeyProxyEnabled !== false;
  await extensionStorage().set(payload);
}

export async function loginToWand(baseUrl, password) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const response = await fetch(`${normalizedBase}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, client: "browser-extension" })
  });
  const data = await readJson(response);
  if (!response.ok || !data.appToken) {
    throw new Error(data.error || "Login failed.");
  }
  await saveSettings({ baseUrl: normalizedBase, appToken: data.appToken });
  return { baseUrl: normalizedBase, appToken: data.appToken, serverUrl: data.serverUrl };
}

export async function apiFetch(path, options = {}) {
  const settings = await getSettings();
  if (!settings.appToken) {
    throw new Error("Wand extension is locked. Sign in from Options.");
  }
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
    Authorization: `Bearer ${settings.appToken}`
  };
  const response = await fetch(`${settings.baseUrl}${path}`, {
    ...options,
    headers
  });
  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(data.error || `Request failed with ${response.status}.`);
  }
  return data;
}

export async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}
