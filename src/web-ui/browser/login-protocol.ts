/**
 * 登录协议（唯一真源）。
 *
 * 登录页现在是独立入口，不再加载整个控制台 runtime；但「票据识别、429 冷却、
 * Cookie 是否真的存住、证书提示」这套规则只有一份：登录页和会话内重新登录
 * （`browser/session-engine.ts`）都调用这里，不各写一遍。
 *
 * 这里不读写全局 state、不渲染 DOM，也不做页面跳转——调用方决定拿到结果后
 * 是重新加载页面还是就地刷新会话。
 */
import { clearLoginCredential, isWebLoginTicket } from "../login-credential.js";

export type LoginFailureKind =
  /** 服务端明确拒收：凭据错误、票据无效、限流。凭据可以改，也可以等冷却结束重试。 */
  | "rejected"
  /** 登录请求本身没发出去（网络层失败）。 */
  | "offline"
  /** 密码正确但登录态没存住（多为 HTTPS 证书不受信任）。 */
  | "cookie-not-stored"
  /** 票据登录结果未知：可能已经生效，不能自动重试。 */
  | "unknown";

export interface LoginFailure {
  ok: false;
  kind: LoginFailureKind;
  message: string;
  /** 限流时服务端给出的等待秒数。 */
  retryAfterMs?: number;
  /** 凭据是否应该标红（密码错）。 */
  credentialInvalid?: boolean;
}

export interface LoginSuccess {
  ok: true;
  kind?: never;
  message?: never;
  retryAfterMs?: never;
  credentialInvalid?: never;
  /** 登录接口的响应体，调用方按需读取 config 等字段。 */
  config: unknown;
}

export type LoginResult = LoginSuccess | LoginFailure;

export interface LoginOptions {
  /** 网络层异常（fetch reject）时的文案。 */
  networkMessage?: string;
  /** 登录态没存住时的文案。 */
  cookieMessage?: string;
}

/**
 * 提交一次凭据。只发一次请求：票据模式结果未知时不重试，密码模式由用户决定是否再试。
 *
 * 成功判据是「登录 POST 2xx **且** 紧随其后的鉴权请求也 2xx」——不受信任证书下
 * 浏览器会拒存 Secure Cookie，只看登录 POST 会把这种情况误判成成功。
 */
export async function submitLoginCredential(credential: string, options: LoginOptions = {}): Promise<LoginResult> {
  const ticketMode = isWebLoginTicket(credential);
  let response: Response;
  try {
    response = await fetch(ticketMode ? "/api/login/ticket" : "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ticketMode ? { ticket: credential } : { password: credential }),
      credentials: "same-origin",
    });
  } catch {
    // 票据一旦提交过就不能重放：请求可能已经到达服务端，只是回执没回来。
    return {
      ok: false,
      kind: ticketMode ? "unknown" : "offline",
      message: ticketMode
        ? "票据登录结果未知；请先刷新核对登录状态，不要重复提交。"
        : options.networkMessage ?? "登录失败，请检查网络后重试。",
    };
  }

  if (response.status === 429) {
    const body = await response.json().catch(() => null) as { error?: unknown; retryAfter?: unknown } | null;
    const seconds = body && typeof body.retryAfter === "number" ? Math.max(1, Math.ceil(body.retryAfter)) : 0;
    return {
      ok: false, kind: "rejected",
      message: body && typeof body.error === "string" ? body.error : "登录尝试次数过多，请稍后再试。",
      retryAfterMs: seconds ? seconds * 1000 : undefined,
    };
  }

  if (!response.ok) {
    if (ticketMode) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      return { ok: false, kind: "rejected",
        message: body && typeof body.error === "string" ? body.error
          : "票据登录未确认；请先刷新核对登录状态，不要自动重试。" };
    }
    return { ok: false, kind: "rejected", message: "密码错误，请重试。", credentialInvalid: true };
  }

  // 登录 POST 成功。立刻验证登录态是否真的存住。
  let verified: Response;
  try {
    verified = await fetch("/api/config", { credentials: "same-origin" });
  } catch {
    // 登录已经被接受，但回执没拿到：不能断言失败，也不能自动重试。
    return { ok: false, kind: "unknown",
      message: ticketMode ? "票据登录结果未知；请先刷新核对登录状态，不要重复提交。"
        : "登录结果未确认；请先刷新核对登录状态，不要重复提交。" };
  }
  if (!verified.ok) {
    return { ok: false, kind: "cookie-not-stored",
      message: options.cookieMessage ?? "登录状态未能保存，请重试。" };
  }
  const config = await verified.json().catch(() => null);
  return { ok: true, config };
}

/** 提交后清掉输入框里的凭据：票据绝不留存，密码也不在 DOM 里多待。 */
export function clearSubmittedCredential(input: HTMLInputElement | null, credential: string): void {
  if (!input) return;
  if (isWebLoginTicket(credential)) clearLoginCredential(input);
}
