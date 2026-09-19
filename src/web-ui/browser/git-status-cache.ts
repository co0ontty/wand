/**
 * 逐会话记住最近一次 git 状态。
 *
 * 两个作用：
 *  - 切会话时先用缓存顶上，徽章不会先消失再出现（慢仓库首次取数要 1~2s）；
 *  - 按「请求发起时刻」排序，晚到的旧响应不会盖掉更新的快照，也不会把别的
 *    会话的结果写到当前会话上。
 *
 * 纯逻辑，便于在 Node 里直接测。
 */

interface CacheEntry<T> {
  status: T;
  requestedAt: number;
}

export interface GitStatusCache<T> {
  /**
   * 记下一次取数结果。返回 true 表示这份结果比同一会话已有的缓存更新（或首次）。
   */
  accept(sessionId: string, status: T, requestedAt: number): boolean;
  /** 某个会话当前缓存的状态；没有则 null。 */
  peek(sessionId: string | null): T | null;
  forget(sessionId: string): void;
}

export function createGitStatusCache<T>(): GitStatusCache<T> {
  const entries = new Map<string, CacheEntry<T>>();
  return {
    accept(sessionId, status, requestedAt) {
      if (!sessionId || !status) return false;
      const previous = entries.get(sessionId);
      // 相等时刻按「后到的算」处理：同一次请求重复落地不必丢弃。
      if (previous && requestedAt < previous.requestedAt) return false;
      entries.set(sessionId, { status, requestedAt });
      return true;
    },
    peek(sessionId) {
      if (!sessionId) return null;
      return entries.get(sessionId)?.status ?? null;
    },
    forget(sessionId) {
      entries.delete(sessionId);
    },
  };
}
