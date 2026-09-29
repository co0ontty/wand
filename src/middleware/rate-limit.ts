/**
 * Login rate limiter — tracks failed admin-password attempts per IP.
 * In-memory only; resets on process restart.
 *
 * Only human-typed passwords count. An app token is a machine-held credential the
 * user cannot "type correctly", so a stale connect code must not lock out the whole
 * shared IP bucket (that is what kept the web console answering 429).
 */

const PASSWORD_WINDOW = 15 * 60 * 1000; // failures are counted over a sliding window
const PASSWORD_MAX = 10; // allowed failures inside the window
const LOCKOUT = 15 * 60 * 1000; // fixed cooldown once the window is exhausted

interface PasswordRecord {
  /** Timestamps of failures inside PASSWORD_WINDOW, oldest first. */
  attempts: number[];
  lockedUntil: number;
}

const passwordAttempts = new Map<string, PasswordRecord>();

export interface LoginLimitState {
  lockedUntil: number;
  /** Seconds to advertise via Retry-After; 0 when not locked. */
  retryAfter: number;
}

function prune(attempts: number[], now: number): number[] {
  const cutoff = now - PASSWORD_WINDOW;
  let start = 0;
  while (start < attempts.length && attempts[start] <= cutoff) start++;
  return start === 0 ? attempts : attempts.slice(start);
}

function lockedState(lockedUntil: number, now: number): LoginLimitState {
  return { lockedUntil, retryAfter: Math.ceil((lockedUntil - now) / 1000) };
}

export function checkPasswordRateLimit(ip: string, now = Date.now()): LoginLimitState | null {
  const record = passwordAttempts.get(ip);
  if (!record) return null;

  if (now < record.lockedUntil) return lockedState(record.lockedUntil, now);

  record.attempts = prune(record.attempts, now);
  if (!record.attempts.length) passwordAttempts.delete(ip);
  return null;
}

/**
 * Records one wrong admin password. Returns the lock that was just imposed, if any.
 * A previous lock that has already expired starts a fresh window instead of being
 * topped up by the first typo after it.
 */
export function recordFailedPassword(ip: string, now = Date.now()): LoginLimitState | null {
  const existing = passwordAttempts.get(ip);
  // A lock that has already expired must not leave its failures behind to tip the new
  // window over the limit on the first typo; `lockedUntil` 0 means "never locked".
  const expiredLock = !!existing && existing.lockedUntil > 0 && now >= existing.lockedUntil;
  const record: PasswordRecord = !existing || expiredLock ? { attempts: [], lockedUntil: 0 } : existing;
  record.attempts = prune(record.attempts, now);
  record.attempts.push(now);

  let lock: LoginLimitState | null = null;
  if (record.attempts.length >= PASSWORD_MAX) {
    record.lockedUntil = now + LOCKOUT;
    record.attempts = [];
    lock = lockedState(record.lockedUntil, now);
  }
  passwordAttempts.set(ip, record);
  return lock;
}

export function resetPasswordRateLimit(ip: string): void {
  passwordAttempts.delete(ip);
}

function cleanupRateLimiter(): void {
  const now = Date.now();
  for (const [ip, record] of passwordAttempts.entries()) {
    record.attempts = prune(record.attempts, now);
    if (!record.attempts.length && now >= record.lockedUntil) {
      passwordAttempts.delete(ip);
    }
  }
}

// Cleanup expired entries every 5 minutes
const rateLimitCleanupTimer = setInterval(cleanupRateLimiter, 5 * 60 * 1000);
rateLimitCleanupTimer.unref();
