import crypto from "node:crypto";
import { WandStorage } from "./storage.js";

const sessions = new Map<string, number>();
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
let storage: WandStorage | null = null;

// Periodic cleanup every 10 minutes
const sessionCleanupTimer = setInterval(() => {
  cleanupExpiredSessions();
}, 1000 * 60 * 10);
sessionCleanupTimer.unref();

export function createSession(): string {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, expiresAt);
  storage?.saveAuthSession(token, expiresAt);
  return token;
}

export function validateSession(token: string | undefined): boolean {
  if (!token) {
    return false;
  }

  let expiresAt = sessions.get(token);
  if (typeof expiresAt === "undefined") {
    const persisted = storage?.getAuthSession(token);
    if (persisted) {
      sessions.set(token, persisted.expiresAt);
      expiresAt = persisted.expiresAt;
    }
  }

  if (!expiresAt || expiresAt < Date.now()) {
    if (expiresAt) {
      sessions.delete(token);
      storage?.deleteAuthSession(token);
    }
    return false;
  }

  return true;
}

export function revokeSession(token: string | undefined): void {
  if (token) {
    sessions.delete(token);
    storage?.deleteAuthSession(token);
  }
}

export function setAuthStorage(nextStorage: WandStorage): void {
  storage = nextStorage;
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt < now) {
      sessions.delete(token);
    }
  }
  storage?.deleteExpiredAuthSessions(now);
}
