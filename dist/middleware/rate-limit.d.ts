/**
 * Login rate limiter — tracks failed attempts per IP.
 * In-memory only; resets on process restart.
 */
export declare function checkRateLimit(ip: string): boolean;
export declare function recordFailedLogin(ip: string): void;
export declare function resetRateLimit(ip: string): void;
export declare function cleanupRateLimiter(): void;
