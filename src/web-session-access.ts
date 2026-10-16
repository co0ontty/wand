import type { AuthPrincipal } from "./storage.js";

/** Exact read-only HTTP surface. Everything else, including new routes, stays denied. */
export function webSessionRequestAllowed(principal: AuthPrincipal, method: string, pathname: string): boolean {
  if (!principal.webSession) return true;
  const { sessionId, employeeId } = principal.webSession;
  if (!sessionId || !employeeId || method !== "GET") return false;
  if (["/api/config", "/api/sessions", "/api/session-list"].includes(pathname)) return true;
  const match = /^\/api\/(?:sessions|structured-sessions)\/([^/]+)(?:\/(messages|tool-content\/[^/]+))?$/.exec(pathname);
  try { return !!match && decodeURIComponent(match[1]!) === sessionId; } catch { return false; }
}

export function filterWebSessionList<T extends { id: string; employeeId?: string }>(principal: AuthPrincipal | undefined, sessions: T[]): T[] {
  const subject = principal?.webSession;
  return subject ? sessions.filter(session => session.id === subject.sessionId && session.employeeId === subject.employeeId) : sessions;
}
