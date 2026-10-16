import { createHash, randomBytes } from "node:crypto";
import type { AuthPrincipal } from "./storage.js";
import { HttpError } from "./http-error.js";

export const WEB_LOGIN_TTL_MS = 60_000;
export const WEB_LOGIN_PRINCIPAL: AuthPrincipal = { kind: "connected-app", scopes: ["sessions"] };
export interface WebLoginSubject { sessionId: string | null; employeeId: string | null }
interface Attempt {
  origin: string;
  subject: WebLoginSubject;
  expiresAt: number;
  hash: string | null;
  state: "issued" | "consumed" | "cancelled";
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export function webLoginOrigin(value: unknown): string {
  try {
    if (typeof value !== "string") throw new Error();
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error();
    return url.origin;
  } catch { throw new HttpError(400, "invalid_origin", "登录目标必须是 HTTPS origin（仅回环地址允许 HTTP）。"); }
}

/** Single server owner; no await between checking and removing a ticket. Nothing is persisted. */
export class WebLoginTickets {
  private readonly attempts = new Map<string, Attempt>();
  private readonly grants = new Map<string, WebLoginSubject>();

  /** Dedicated execution proof; not an employee selector, knowledge token or owner password. */
  grant(subject: WebLoginSubject): { proof: string; revoke(): void } {
    if (!subject.sessionId || !subject.employeeId || this.grants.size >= 4096) throw new Error("Web login execution grant unavailable.");
    const proof = `wlp_${randomBytes(32).toString("base64url")}`;
    const digest = hash(proof);
    this.grants.set(digest, { ...subject });
    return { proof, revoke: () => { this.grants.delete(digest); } };
  }

  resolveGrant(proof: unknown): WebLoginSubject | null {
    if (typeof proof !== "string" || !/^wlp_[a-zA-Z0-9_-]{43}$/.test(proof)) return null;
    const subject = this.grants.get(hash(proof));
    return subject ? { ...subject } : null;
  }
  constructor(private readonly now: () => number = Date.now) {}

  issue(requestId: string, origin: string, subject: WebLoginSubject) {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(requestId)) throw new HttpError(400, "invalid_request", "需要独立且稳定的 requestId（16–128 位字母、数字、下划线或连字符）。");
    origin = webLoginOrigin(origin);
    if (!subject.sessionId || !subject.employeeId) throw new HttpError(403, "invalid_subject", "票据登录必须绑定当前员工会话，不能降为无边界的所有者登录。");
    this.prune();
    if (this.attempts.has(requestId)) throw new HttpError(409, "duplicate_request", "此签发请求已处理；票据不会重发，请核对浏览器登录状态或取消原请求。");
    if (this.attempts.size >= 4096) throw new HttpError(429, "ticket_capacity", "登录票据请求过多，请稍后再试。");
    const ticket = `wlt_${randomBytes(32).toString("base64url")}`;
    const attempt: Attempt = { origin, subject: { ...subject }, expiresAt: this.now() + WEB_LOGIN_TTL_MS, hash: hash(ticket), state: "issued" };
    this.attempts.set(requestId, attempt);
    return { ticket, requestId, origin, expiresAt: new Date(attempt.expiresAt).toISOString(), subject: { ...subject }, principal: this.principal(subject) };
  }

  consume(ticket: unknown, origin: string): { principal: AuthPrincipal; subject: WebLoginSubject } {
    if (typeof ticket !== "string" || !/^wlt_[a-zA-Z0-9_-]{43}$/.test(ticket)) throw this.invalid();
    const digest = hash(ticket);
    for (const attempt of this.attempts.values()) {
      if (attempt.hash !== digest) continue;
      if (attempt.state !== "issued" || attempt.expiresAt <= this.now() || attempt.origin !== origin) throw this.invalid();
      // Burn before cookie issuance: any later failure is unknown delivery, never replayable.
      attempt.hash = null;
      attempt.state = "consumed";
      return { principal: this.principal(attempt.subject), subject: { ...attempt.subject } };
    }
    throw this.invalid();
  }

  cancel(requestId: string): void {
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(requestId)) throw new HttpError(400, "invalid_request", "无效 requestId。");
    this.prune();
    const attempt = this.attempts.get(requestId);
    if (attempt?.state === "issued") { attempt.hash = null; attempt.state = "cancelled"; }
    // Cancel may arrive before a delayed issue POST. A tombstone prevents late resurrection.
    if (!attempt && this.attempts.size < 4096) this.attempts.set(requestId, {
      origin: "", subject: { sessionId: null, employeeId: null }, expiresAt: this.now() + WEB_LOGIN_TTL_MS, hash: null, state: "cancelled",
    });
  }
  clear(): void { this.attempts.clear(); this.grants.clear(); }
  private principal(subject: WebLoginSubject): AuthPrincipal {
    return { kind: WEB_LOGIN_PRINCIPAL.kind, scopes: [...WEB_LOGIN_PRINCIPAL.scopes],
      webSession: { sessionId: subject.sessionId!, employeeId: subject.employeeId! } };
  }
  private invalid(): HttpError { return new HttpError(401, "invalid_ticket", "票据无效、已过期、已取消、已使用或不属于当前服务；请核对登录状态，不要自动重试。"); }
  private prune(): void {
    // Keep tombstones beyond ticket TTL so an uncertain/repeated request never mints a second ticket.
    for (const [id, attempt] of this.attempts) if (attempt.expiresAt + 12 * 60 * 60_000 <= this.now()) this.attempts.delete(id);
  }
}
