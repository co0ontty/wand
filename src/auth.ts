import crypto from "node:crypto";

const sessions = new Map<string, number>();
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

export function createSession(): string {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function validateSession(token: string | undefined): boolean {
  if (!token) {
    return false;
  }

  const expiresAt = sessions.get(token);
  if (!expiresAt) {
    return false;
  }

  if (expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }

  return true;
}

export function revokeSession(token: string | undefined): void {
  if (token) {
    sessions.delete(token);
  }
}
