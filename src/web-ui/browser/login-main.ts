/**
 * 匿名登录页入口（`content/login.js`）。
 *
 * 这是登录页**唯一**的脚本：不含 React、AntD、终端或会话代码，所以匿名访客
 * 不再为了一个密码表单下载整个控制台 runtime（实测 Brotli 669KB / 解压 2.2MB，
 * 弱网下光下载约 3.6s）。登录成功后重新加载当前地址，服务端这时才会下发控制台
 * 的 HTML 与 runtime；登录失败/限流/票据未知都在原位给出结果。
 *
 * 登录协议本身在 `login-protocol.ts`，与会话内重新登录共用同一份规则。
 */
import { renderLoginVisual } from "./login-visual.js";
import { renderLoginPageMarkup } from "./login-template.js";
import { renderWandBrandMarkup } from "../brand-identity.js";
import { submitLoginCredential, clearSubmittedCredential } from "./login-protocol.js";

const PASSWORD_ID = "password";
const BUTTON_ID = "login-button";
const ERROR_ID = "login-error";

let pending = false;
let lockUntil = 0;
let lockTicker = 0;

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function showError(message: string): void {
  const error = byId<HTMLElement>(ERROR_ID);
  if (!error) return;
  error.textContent = message;
  error.classList.remove("hidden");
}

function hideError(): void {
  const error = byId<HTMLElement>(ERROR_ID);
  if (!error) return;
  error.textContent = "";
  error.classList.add("hidden");
}

/** 证书不受信任时浏览器会丢弃 Secure Cookie —— 密码正确也存不住登录态。 */
function showCertHint(): void {
  byId<HTMLElement>("login-cert-hint")?.classList.remove("hidden");
  const link = byId<HTMLAnchorElement>("login-cert-http-link");
  if (!link) return;
  link.href = "http://" + location.host + location.pathname;
  link.style.display = location.protocol === "https:" ? "" : "none";
}

function setButtonLabel(label: string, disabled: boolean): void {
  const button = byId<HTMLButtonElement>(BUTTON_ID);
  if (!button) return;
  button.textContent = label;
  button.disabled = disabled;
}

function scheduleLockTick(): void {
  if (lockTicker) return;
  lockTicker = window.setTimeout(function tick() {
    lockTicker = 0;
    const left = Math.ceil((lockUntil - Date.now()) / 1000);
    if (left > 0) {
      scheduleLockTick();
      if (pending) return;
      setButtonLabel("请等待 " + left + "s", true);
      showError("登录尝试次数过多，请等待 " + left + " 秒。");
      return;
    }
    lockUntil = 0;
    setButtonLabel("进入控制台", false);
    showError("现在可以再试一次了。");
  }, 1000);
}

/** 登录成功后服务端已写入会话 Cookie：重新加载当前地址即进入控制台。 */
function enterConsole(): void {
  location.replace(location.pathname + location.search);
}

async function submit(): Promise<void> {
  const password = byId<HTMLInputElement>(PASSWORD_ID);
  const button = byId<HTMLButtonElement>(BUTTON_ID);
  if (!password || !button) return;

  // 冷却未到不发包：服务端会按剩余时间回 429，白烧一次往返。
  const lockedFor = Math.ceil((lockUntil - Date.now()) / 1000);
  if (lockedFor > 0) {
    showError("登录尝试次数过多，请等待 " + lockedFor + " 秒。");
    scheduleLockTick();
    return;
  }
  if (pending) return;

  hideError();
  byId<HTMLElement>("login-cert-hint")?.classList.add("hidden");
  password.dataset.error = "false";
  password.setAttribute("aria-invalid", "false");
  pending = true;
  setButtonLabel("登录中...", true);

  const credential = password.value;
  clearSubmittedCredential(password, credential);
  const result = await submitLoginCredential(credential);
  pending = false;

  if (result.ok) {
    enterConsole();
    return;
  }
  if (result.retryAfterMs) {
    lockUntil = Date.now() + result.retryAfterMs;
    scheduleLockTick();
  }
  if (result.kind === "cookie-not-stored" && location.protocol === "https:") showCertHint();
  if (result.credentialInvalid) {
    password.dataset.error = "true";
    password.setAttribute("aria-invalid", "true");
  }
  showError(result.message);
  setButtonLabel("进入控制台", lockUntil > Date.now());
}

function renderLoginPage(): void {
  const target = document.querySelector<HTMLElement>("[data-login-controls]");
  if (!target) return;
  const brand = renderWandBrandMarkup("brand-logo");
  target.innerHTML = renderLoginPageMarkup(brand, renderLoginVisual(brand));

  const password = byId<HTMLInputElement>(PASSWORD_ID);
  byId<HTMLButtonElement>(BUTTON_ID)?.addEventListener("click", () => { void submit(); });
  byId<HTMLFormElement>("login-form")?.addEventListener("submit", event => {
    event.preventDefault();
    void submit();
  });
  password?.addEventListener("input", () => {
    password.dataset.error = "false";
    password.setAttribute("aria-invalid", "false");
    hideError();
  });
  password?.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); void submit(); }
  });
  password?.focus();
}

renderLoginPage();
