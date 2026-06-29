import { getSettings, saveSettings, apiFetch } from "./api.js";
import { DEFAULT_BASE_URL, normalizeBaseUrl } from "../shared/url-tools.mjs";

var els = {
  baseUrl: document.getElementById("baseUrl"),
  password: document.getElementById("password"),
  passkeyProxyEnabled: document.getElementById("passkeyProxyEnabled"),
  loginButton: document.getElementById("loginButton"),
  testButton: document.getElementById("testButton"),
  lockButton: document.getElementById("lockButton"),
  status: document.getElementById("status"),
  passkeyStatus: document.getElementById("passkeyStatus")
};

init();

async function init() {
  var settings = await getSettings().catch(function () {
    return { baseUrl: DEFAULT_BASE_URL, appToken: "" };
  });
  els.baseUrl.value = settings.baseUrl || DEFAULT_BASE_URL;
  els.passkeyProxyEnabled.checked = settings.passkeyProxyEnabled !== false;
  setStatus(settings.appToken ? "Connected." : "Locked.", settings.appToken ? "ok" : "");
  await refreshPasskeyState();
  els.loginButton.addEventListener("click", login);
  els.testButton.addEventListener("click", testConnection);
  els.lockButton.addEventListener("click", lock);
  els.baseUrl.addEventListener("change", function () {
    saveSettings({ baseUrl: normalizeBaseUrl(els.baseUrl.value) });
  });
  els.passkeyProxyEnabled.addEventListener("change", async function () {
    await send({ type: "save-settings", settings: { passkeyProxyEnabled: els.passkeyProxyEnabled.checked } });
    await refreshPasskeyState();
  });
}

async function login() {
  try {
    setStatus("Signing in...");
    var response = await send({ type: "login", baseUrl: els.baseUrl.value, password: els.password.value });
    if (!response.ok) throw new Error(response.error || "Login failed.");
    els.password.value = "";
    setStatus("Connected.", "ok");
    await refreshPasskeyState();
  } catch (error) {
    setStatus(error.message || "Login failed.", "error");
  }
}

async function testConnection() {
  try {
    await saveSettings({ baseUrl: normalizeBaseUrl(els.baseUrl.value) });
    var status = await apiFetch("/api/browser-extension/status");
    setStatus(status.ok ? "Connection works." : "Connection failed.", status.ok ? "ok" : "error");
    await refreshPasskeyState();
  } catch (error) {
    setStatus(error.message || "Connection failed.", "error");
  }
}

async function lock() {
  await saveSettings({ appToken: "" });
  setStatus("Locked.");
  await refreshPasskeyState();
}

function setStatus(message, kind) {
  els.status.textContent = message;
  els.status.className = "status";
  if (kind) els.status.classList.add(kind);
}

async function refreshPasskeyState() {
  var response = await send({ type: "passkey-proxy-state" }).catch(function (error) {
    return { ok: false, error: error.message || String(error) };
  });
  if (!response.ok) {
    setPasskeyStatus(response.error || "Passkey proxy unavailable.", "error");
    return;
  }
  var proxy = response.passkeyProxy || {};
  if (!proxy.supported) {
    setPasskeyStatus("Passkey proxy is not supported by this browser.", "error");
  } else if (!proxy.enabled) {
    setPasskeyStatus("Passkey proxy is disabled.");
  } else if (proxy.attached) {
    setPasskeyStatus("Passkey proxy is active.", "ok");
  } else {
    setPasskeyStatus(proxy.lastError || "Passkey proxy is not attached.", "error");
  }
}

function setPasskeyStatus(message, kind) {
  els.passkeyStatus.textContent = message;
  els.passkeyStatus.className = "status";
  if (kind) els.passkeyStatus.classList.add(kind);
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}
