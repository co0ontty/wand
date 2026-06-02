/**
 * Login rate limiter — tracks failed attempts per IP.
 * In-memory only; resets on process restart.
 */
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 10; // 10 attempts per window
const loginAttempts = new Map();
export function checkRateLimit(ip) {
    const now = Date.now();
    const record = loginAttempts.get(ip);
    if (!record || now > record.resetAt) {
        return true;
    }
    return record.count < RATE_LIMIT_MAX;
}
export function recordFailedLogin(ip) {
    const now = Date.now();
    const record = loginAttempts.get(ip);
    if (!record || now > record.resetAt) {
        loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
        return;
    }
    record.count++;
}
export function resetRateLimit(ip) {
    loginAttempts.delete(ip);
}
export function cleanupRateLimiter() {
    const now = Date.now();
    for (const [ip, record] of loginAttempts.entries()) {
        if (now > record.resetAt) {
            loginAttempts.delete(ip);
        }
    }
}
// Cleanup expired entries every 5 minutes
const rateLimitCleanupTimer = setInterval(cleanupRateLimiter, 5 * 60 * 1000);
rateLimitCleanupTimer.unref();
