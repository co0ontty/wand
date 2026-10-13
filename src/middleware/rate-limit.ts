/**
 * 认证相关的内存限流器（按 IP）。进程重启即清空。
 *
 * 三个独立桶：
 *   - 密码登录：只计人工输入的错误密码；应用令牌不计入（见 /api/login 注释）。
 *   - Bearer 应用令牌失败：无效或过期的 Authorization 头按 IP 计数，超限后该 IP 的
 *     Bearer 请求直接 429，但不影响已持有有效会话 Cookie 的浏览器。
 *   - 修改密码：每次调用计一次，防止持有管理员会话的脚本高频尝试。
 *
 * 每个桶的 key 数量有上限；超过时先清过期项，仍然超限则淘汰最早插入的 key，
 * 所以伪造大量来源地址不会无限撑大 Map。
 */

const MINUTE = 60 * 1000;

export interface LoginLimitState {
  lockedUntil: number;
  /** Seconds to advertise via Retry-After; 0 when not locked. */
  retryAfter: number;
}

export interface AttemptLimiterOptions {
  /** Failures are counted over a sliding window of this length. */
  windowMs: number;
  /** Failures allowed inside the window before the key is locked. */
  maxAttempts: number;
  /** Fixed cooldown once the window is exhausted. */
  lockoutMs: number;
  /** Upper bound on tracked keys (IPs) for this bucket. */
  maxKeys: number;
}

interface AttemptRecord {
  /** Timestamps of failures inside the window, oldest first. */
  attempts: number[];
  lockedUntil: number;
}

function lockedState(lockedUntil: number, now: number): LoginLimitState {
  return { lockedUntil, retryAfter: Math.ceil((lockedUntil - now) / 1000) };
}

export class AttemptLimiter {
  private readonly records = new Map<string, AttemptRecord>();

  constructor(private readonly options: AttemptLimiterOptions) {}

  /** Returns the active lock for `key`, or null when it may proceed. */
  check(key: string, now = Date.now()): LoginLimitState | null {
    const record = this.records.get(key);
    if (!record) return null;
    if (now < record.lockedUntil) return lockedState(record.lockedUntil, now);
    record.attempts = this.prune(record.attempts, now);
    if (!record.attempts.length && now >= record.lockedUntil) this.records.delete(key);
    return null;
  }

  /** Records one failure. Returns the lock that was just imposed, if any. */
  record(key: string, now = Date.now()): LoginLimitState | null {
    const existing = this.records.get(key);
    // A lock that has already expired must not leave its failures behind to tip the new
    // window over the limit on the first typo; `lockedUntil` 0 means "never locked".
    const expiredLock = !!existing && existing.lockedUntil > 0 && now >= existing.lockedUntil;
    const record: AttemptRecord = !existing || expiredLock ? { attempts: [], lockedUntil: 0 } : existing;
    record.attempts = this.prune(record.attempts, now);
    record.attempts.push(now);

    let lock: LoginLimitState | null = null;
    if (record.attempts.length >= this.options.maxAttempts) {
      record.lockedUntil = now + this.options.lockoutMs;
      record.attempts = [];
      lock = lockedState(record.lockedUntil, now);
    }
    this.store(key, record, now);
    return lock;
  }

  reset(key: string): void {
    this.records.delete(key);
  }

  /** Drops expired entries; called periodically and when the key cap is reached. */
  sweep(now = Date.now()): void {
    for (const [key, record] of this.records) {
      record.attempts = this.prune(record.attempts, now);
      if (!record.attempts.length && now >= record.lockedUntil) this.records.delete(key);
    }
  }

  get size(): number {
    return this.records.size;
  }

  private prune(attempts: number[], now: number): number[] {
    const cutoff = now - this.options.windowMs;
    let start = 0;
    while (start < attempts.length && attempts[start] <= cutoff) start++;
    return start === 0 ? attempts : attempts.slice(start);
  }

  private store(key: string, record: AttemptRecord, now: number): void {
    if (!this.records.has(key) && this.records.size >= this.options.maxKeys) {
      this.sweep(now);
      while (this.records.size >= this.options.maxKeys) {
        const oldest = this.records.keys().next().value;
        if (oldest === undefined) break;
        this.records.delete(oldest);
      }
    }
    // Re-insert so Map iteration order tracks recency for eviction.
    this.records.delete(key);
    this.records.set(key, record);
  }
}

const passwordLimiter = new AttemptLimiter({
  windowMs: 15 * MINUTE,
  maxAttempts: 10,
  lockoutMs: 15 * MINUTE,
  maxKeys: 10_000,
});

const bearerLimiter = new AttemptLimiter({
  windowMs: 10 * MINUTE,
  maxAttempts: 60,
  lockoutMs: 10 * MINUTE,
  maxKeys: 10_000,
});

const setPasswordLimiter = new AttemptLimiter({
  windowMs: 15 * MINUTE,
  maxAttempts: 20,
  lockoutMs: 15 * MINUTE,
  maxKeys: 10_000,
});

export function checkPasswordRateLimit(ip: string, now = Date.now()): LoginLimitState | null {
  return passwordLimiter.check(ip, now);
}

/** Records one wrong admin password. Returns the lock that was just imposed, if any. */
export function recordFailedPassword(ip: string, now = Date.now()): LoginLimitState | null {
  return passwordLimiter.record(ip, now);
}

export function resetPasswordRateLimit(ip: string): void {
  passwordLimiter.reset(ip);
}

export function checkBearerRateLimit(ip: string, now = Date.now()): LoginLimitState | null {
  return bearerLimiter.check(ip, now);
}

export function recordFailedBearer(ip: string, now = Date.now()): LoginLimitState | null {
  return bearerLimiter.record(ip, now);
}

/** Every call counts, successful or not: the endpoint is an admin-only write, not a guess target. */
export function recordSetPasswordAttempt(ip: string, now = Date.now()): LoginLimitState | null {
  return setPasswordLimiter.record(ip, now);
}

export function checkSetPasswordRateLimit(ip: string, now = Date.now()): LoginLimitState | null {
  return setPasswordLimiter.check(ip, now);
}

const rateLimitCleanupTimer = setInterval(() => {
  passwordLimiter.sweep();
  bearerLimiter.sweep();
  setPasswordLimiter.sweep();
}, 5 * MINUTE);
rateLimitCleanupTimer.unref();
