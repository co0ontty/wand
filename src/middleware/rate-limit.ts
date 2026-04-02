/**
 * Login rate limiter — tracks failed attempts per IP.
 * In-memory only; resets on process restart.
 */

const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 10; // 10 attempts per window

interface RateRecord {
  count: number;
  resetAt: number;
}

const loginAttempts = new Map<string, RateRecord>();

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (!record || now > record.resetAt) {
    return true;
  }

  return record.count < RATE_LIMIT_MAX;
}

export function recordFailedLogin(ip: string): void {
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return;
  }

  record.count++;
}

export function resetRateLimit(ip: string): void {
  loginAttempts.delete(ip);
}

export function cleanupRateLimiter(): void {
  const now = Date.now();
  for (const [ip, record] of loginAttempts.entries()) {
    if (now > record.resetAt) {
      loginAttempts.delete(ip);
    }
  }
}

// Cleanup expired entries every 5 minutes
setInterval(cleanupRateLimiter, 5 * 60 * 1000);
