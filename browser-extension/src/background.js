import { apiFetch, getSettings, loginToWand, saveSettings } from "./api.js";
import { generatePassword } from "../shared/password-tools.mjs";
import { DEFAULT_BASE_URL, pageTitleFallback } from "../shared/url-tools.mjs";
import {
  createPasskeyCredential,
  getPasskeyAssertion,
  parseWebAuthnRequestJson,
  passkeyMatchesRequest,
  webAuthnDomException
} from "../shared/webauthn-tools.mjs";

const DISABLED_ORIGINS_KEY = "wand.disabledOrigins";
var passkeyProxyState = {
  supported: !!chrome.webAuthenticationProxy,
  attached: false,
  enabled: true,
  lastError: ""
};
var canceledWebAuthnRequests = new Set();

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "wand-generate-password",
      title: "Generate Wand password",
      contexts: ["editable"]
    });
  });

  if (details.reason === "install") {
    saveSettings({ baseUrl: DEFAULT_BASE_URL, passkeyProxyEnabled: true })
      .then(() => chrome.runtime.openOptionsPage())
      .catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "wand-generate-password" || !tab?.id) return;
  const password = generatePassword({ length: 24 });
  await chrome.tabs.sendMessage(tab.id, { type: "wand-fill-generated-password", password }).catch(() => {});
});

if (chrome.webAuthenticationProxy) {
  chrome.webAuthenticationProxy.onCreateRequest.addListener((requestInfo) => {
    handlePasskeyCreateRequest(requestInfo);
  });
  chrome.webAuthenticationProxy.onGetRequest.addListener((requestInfo) => {
    handlePasskeyGetRequest(requestInfo);
  });
  chrome.webAuthenticationProxy.onIsUvpaaRequest.addListener((requestInfo) => {
    completeIsUvpaaRequest(requestInfo.requestId, passkeyProxyState.attached);
  });
  chrome.webAuthenticationProxy.onRequestCanceled.addListener((requestId) => {
    canceledWebAuthnRequests.add(requestId);
  });
  chrome.webAuthenticationProxy.onRemoteSessionStateChange.addListener(() => {
    ensurePasskeyProxyAttachment().catch(() => {});
  });
}

ensurePasskeyProxyAttachment().catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "get-settings":
      return { settings: await getSettings() };
    case "save-settings":
      await saveSettings(message.settings || {});
      await ensurePasskeyProxyAttachment();
      return {};
    case "login":
      return { login: await loginAndAttach(message.baseUrl, message.password) };
    case "status": {
      const status = await apiFetch("/api/browser-extension/status");
      await ensurePasskeyProxyAttachment();
      return { ...status, passkeyProxy: await getPasskeyProxyState() };
    }
    case "vaults":
      return await apiFetch("/api/browser-extension/vaults");
    case "items-for-url": {
      const response = await apiFetch(`/api/browser-extension/items?url=${encodeURIComponent(message.url)}&limit=20`);
      return { ...response, items: sanitizeItemsForUi(response.items || []) };
    }
    case "search-items":
      return await searchItems(message);
    case "create-item":
      return await apiFetch("/api/browser-extension/items", {
        method: "POST",
        body: JSON.stringify(message.item)
      });
    case "update-item":
      return await apiFetch(`/api/browser-extension/items/${encodeURIComponent(message.id)}`, {
        method: "PUT",
        body: JSON.stringify(message.item)
      });
    case "touch-item":
      return await apiFetch(`/api/browser-extension/items/${encodeURIComponent(message.id)}/use`, { method: "POST" });
    case "open-and-fill":
      return await openAndFill(message.item);
    case "delete-item":
      return await apiFetch(`/api/browser-extension/items/${encodeURIComponent(message.id)}`, { method: "DELETE" });
    case "security-report":
      return await apiFetch("/api/browser-extension/security-report");
    case "generate-password":
      return { password: generatePassword(message.options || {}) };
    case "preview-totp":
      return await apiFetch("/api/browser-extension/totp/preview", {
        method: "POST",
        body: JSON.stringify({ secret: message.secret })
      });
    case "capture-login":
      return await captureLogin(message, sender);
    case "capture-federated-login":
      return await captureFederatedLogin(message, sender);
    case "fill-active-tab":
      return await fillActiveTab(message.item);
    case "site-settings":
      return await getSiteSettings(message.url || sender.tab?.url);
    case "toggle-site-disabled":
      return await toggleSiteDisabled(message.url || sender.tab?.url);
    case "passkey-proxy-state":
      return { passkeyProxy: await getPasskeyProxyState() };
    default:
      throw new Error("Unsupported Wand extension message.");
  }
}

async function loginAndAttach(baseUrl, password) {
  const login = await loginToWand(baseUrl, password);
  await ensurePasskeyProxyAttachment();
  return login;
}

async function searchItems(message) {
  const params = new URLSearchParams();
  if (message.q) params.set("q", message.q);
  if (message.url) params.set("url", message.url);
  if (message.type) params.set("type", message.type);
  params.set("limit", String(message.limit || 50));
  const response = await apiFetch(`/api/browser-extension/items?${params.toString()}`);
  return { ...response, items: sanitizeItemsForUi(response.items || []) };
}

function sanitizeItemsForUi(items) {
  return items.map((item) => {
    if (item.type !== "passkey") return item;
    const fields = { ...(item.fields || {}) };
    delete fields.privateKeyJwk;
    delete fields.publicKeyJwk;
    delete fields.publicKeyRaw;
    delete fields.publicKeyCose;
    return { ...item, fields };
  });
}

async function captureLogin(message, sender) {
  const url = sender.tab?.url || message.url;
  const username = String(message.username || "").trim();
  const password = String(message.password || "").trim();
  if (!url || !password) return { skipped: true };
  const existing = await apiFetch(`/api/browser-extension/items?url=${encodeURIComponent(url)}&type=login&limit=20`);
  const duplicate = (existing.items || []).find((item) => item.username === username);
  if (duplicate) {
    await apiFetch(`/api/browser-extension/items/${encodeURIComponent(duplicate.id)}`, {
      method: "PUT",
      body: JSON.stringify({ ...duplicate, password, urls: duplicate.urls?.length ? duplicate.urls : [url] })
    });
    return { item: duplicate, updated: true };
  }
  const item = {
    type: "login",
    title: message.title || pageTitleFallback(url),
    username,
    password,
    urls: [url],
    fields: {},
    tags: ["browser-extension"]
  };
  return await apiFetch("/api/browser-extension/items", {
    method: "POST",
    body: JSON.stringify(item)
  });
}

async function captureFederatedLogin(message, sender) {
  const url = sender.tab?.url || message.url;
  const provider = String(message.provider || "").trim().toLowerCase();
  if (!url || !provider) return { skipped: true };
  const existing = await apiFetch(`/api/browser-extension/items?url=${encodeURIComponent(url)}&type=login&limit=50`);
  const duplicate = (existing.items || []).find((item) => item.fields?.providerLogin === provider);
  if (duplicate) return { item: duplicate, skipped: true };
  const item = {
    type: "login",
    title: `${pageTitleFallback(url)} (${provider})`,
    urls: [url],
    fields: {
      providerLogin: provider
    },
    tags: ["browser-extension", "federated-login"]
  };
  return await apiFetch("/api/browser-extension/items", {
    method: "POST",
    body: JSON.stringify(item)
  });
}

async function fillActiveTab(item) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  await chrome.tabs.sendMessage(tab.id, { type: "wand-fill-item", item });
  if (item?.id) {
    await apiFetch(`/api/browser-extension/items/${encodeURIComponent(item.id)}/use`, { method: "POST" }).catch(() => {});
  }
  return {};
}

async function openAndFill(item) {
  const url = item?.urls?.[0];
  if (!url) throw new Error("Item has no website URL.");
  const tab = await chrome.tabs.create({ url });
  await waitForTabLoaded(tab.id);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "wand-fill-item", item });
      if (item.id) {
        await apiFetch(`/api/browser-extension/items/${encodeURIComponent(item.id)}/use`, { method: "POST" }).catch(() => {});
      }
      return {};
    } catch {
      await delay(200);
    }
  }
  throw new Error("Opened the site, but the content script was not ready to fill.");
}

function waitForTabLoaded(tabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(cleanup, 8000);
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") cleanup();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") cleanup();
    }).catch(() => cleanup());
  });
}

async function getSiteSettings(url) {
  const origin = originForUrl(url);
  if (!origin) return { disabled: false };
  const data = await chrome.storage.local.get({ [DISABLED_ORIGINS_KEY]: {} });
  return { disabled: data[DISABLED_ORIGINS_KEY]?.[origin] === true, origin };
}

async function toggleSiteDisabled(url) {
  const origin = originForUrl(url);
  if (!origin) throw new Error("No active website.");
  const data = await chrome.storage.local.get({ [DISABLED_ORIGINS_KEY]: {} });
  const disabled = { ...(data[DISABLED_ORIGINS_KEY] || {}) };
  disabled[origin] = disabled[origin] !== true;
  await chrome.storage.local.set({ [DISABLED_ORIGINS_KEY]: disabled });
  return { origin, disabled: disabled[origin] === true };
}

function originForUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensurePasskeyProxyAttachment() {
  const proxy = chrome.webAuthenticationProxy;
  passkeyProxyState.supported = !!proxy;
  if (!proxy) {
    passkeyProxyState.attached = false;
    passkeyProxyState.lastError = "chrome.webAuthenticationProxy is unavailable in this browser.";
    return passkeyProxyState;
  }

  const settings = await getSettings();
  passkeyProxyState.enabled = settings.passkeyProxyEnabled !== false;
  if (!settings.appToken || !passkeyProxyState.enabled) {
    if (passkeyProxyState.attached) {
      await proxy.detach().catch(() => {});
    }
    passkeyProxyState.attached = false;
    passkeyProxyState.lastError = "";
    return passkeyProxyState;
  }

  try {
    const attachError = await proxy.attach();
    passkeyProxyState.attached = !attachError;
    passkeyProxyState.lastError = attachError || "";
  } catch (error) {
    passkeyProxyState.attached = false;
    passkeyProxyState.lastError = error?.message || String(error);
  }
  return passkeyProxyState;
}

async function getPasskeyProxyState() {
  await ensurePasskeyProxyAttachment();
  return { ...passkeyProxyState };
}

async function handlePasskeyCreateRequest(requestInfo) {
  try {
    await ensurePasskeyProxyAttachment();
    if (!passkeyProxyState.attached) {
      await completeCreateError(requestInfo.requestId, "NotAllowedError", passkeyProxyState.lastError || "Wand passkey proxy is not attached.");
      return;
    }
    const options = parseWebAuthnRequestJson(requestInfo.requestDetailsJson);
    const existing = await findPasskeysForRp(options.rp?.id || options.rpId);
    const excludeCredentials = Array.isArray(options.excludeCredentials) ? options.excludeCredentials : [];
    const excluded = existing.find((item) => {
      const credentialId = item.fields?.credentialId;
      return credentialId && excludeCredentials.some((credential) => credential?.id === credentialId);
    });
    if (excluded) {
      await completeCreateError(requestInfo.requestId, "InvalidStateError", "A matching Wand passkey already exists.");
      return;
    }
    const created = await createPasskeyCredential(options);
    if (canceledWebAuthnRequests.has(requestInfo.requestId)) return;
    await apiFetch("/api/browser-extension/items", {
      method: "POST",
      body: JSON.stringify(created.item)
    });
    await chrome.webAuthenticationProxy.completeCreateRequest({
      requestId: requestInfo.requestId,
      responseJson: JSON.stringify(created.response)
    });
  } catch (error) {
    await completeCreateError(requestInfo.requestId, "NotAllowedError", error.message || String(error));
  } finally {
    canceledWebAuthnRequests.delete(requestInfo.requestId);
  }
}

async function handlePasskeyGetRequest(requestInfo) {
  try {
    await ensurePasskeyProxyAttachment();
    if (!passkeyProxyState.attached) {
      await completeGetError(requestInfo.requestId, "NotAllowedError", passkeyProxyState.lastError || "Wand passkey proxy is not attached.");
      return;
    }
    const options = parseWebAuthnRequestJson(requestInfo.requestDetailsJson);
    const candidates = await findPasskeysForRp(options.rpId);
    const item = candidates.find((candidate) => passkeyMatchesRequest(candidate, options));
    if (!item) {
      await completeGetError(requestInfo.requestId, "NotAllowedError", "No matching Wand passkey was found.");
      return;
    }
    const assertion = await getPasskeyAssertion(options, item);
    if (canceledWebAuthnRequests.has(requestInfo.requestId)) return;
    await apiFetch(`/api/browser-extension/items/${encodeURIComponent(item.id)}`, {
      method: "PUT",
      body: JSON.stringify({
        ...item,
        fields: {
          ...item.fields,
          signCount: String(assertion.signCount)
        }
      })
    });
    await chrome.webAuthenticationProxy.completeGetRequest({
      requestId: requestInfo.requestId,
      responseJson: JSON.stringify(assertion.response)
    });
  } catch (error) {
    await completeGetError(requestInfo.requestId, "NotAllowedError", error.message || String(error));
  } finally {
    canceledWebAuthnRequests.delete(requestInfo.requestId);
  }
}

async function findPasskeysForRp(rpId) {
  const q = String(rpId || "").trim().toLowerCase();
  if (!q) return [];
  const response = await apiFetch(`/api/browser-extension/items?type=passkey&q=${encodeURIComponent(q)}&limit=100`);
  return (response.items || []).filter((item) => item.fields?.rpId === q);
}

async function completeCreateError(requestId, name, message) {
  if (canceledWebAuthnRequests.has(requestId)) return;
  await chrome.webAuthenticationProxy.completeCreateRequest({
    requestId,
    error: webAuthnDomException(name, message)
  }).catch(() => {});
}

async function completeGetError(requestId, name, message) {
  if (canceledWebAuthnRequests.has(requestId)) return;
  await chrome.webAuthenticationProxy.completeGetRequest({
    requestId,
    error: webAuthnDomException(name, message)
  }).catch(() => {});
}

async function completeIsUvpaaRequest(requestId, isUvpaa) {
  await chrome.webAuthenticationProxy.completeIsUvpaaRequest({
    requestId,
    isUvpaa
  }).catch(() => {});
}
