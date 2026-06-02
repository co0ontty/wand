import { WandStorage } from "./storage.js";
/**
 * Cookie 名按 scheme 隔离 —— 解决浏览器 Strict Secure Cookies 在 HTTPS↔HTTP 切换时
 * "新 Set-Cookie 被同名 Secure 旧 cookie 静默丢弃"导致登录后立刻 401 的问题。
 *
 *   - HTTPS 模式：`__Host-wand_session`（强制 Secure + Path=/，安全性更高）
 *   - HTTP 模式：`wand_session_local`（独立名字，不会被 HTTPS 留下的 Secure cookie 拦截）
 *   - `wand_session`：legacy 名字。HTTPS 模式下仍写一份用于兼容老 macOS APP（写死了找
 *     `wand_session`），同时让升级前的老登录态在过渡期不被踢。
 *
 * 读取顺序按"当前 scheme 主名字 → legacy"逐项 fallback。
 */
export declare const SESSION_COOKIE_HTTPS = "__Host-wand_session";
export declare const SESSION_COOKIE_HTTP = "wand_session_local";
export declare const SESSION_COOKIE_LEGACY = "wand_session";
/** 解析 Cookie 头，按候选名字顺序返回第一个匹配到的 token 值。 */
export declare function readSessionCookie(req: {
    headers: {
        cookie?: string;
    };
}, useHttps: boolean): string | undefined;
export declare function createSession(): string;
export declare function validateSession(token: string | undefined): boolean;
export declare function revokeSession(token: string | undefined): void;
export declare function setAuthStorage(nextStorage: WandStorage): void;
