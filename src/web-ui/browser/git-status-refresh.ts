/**
 * 顶栏 git 徽章的刷新节拍。
 *
 * 徽章只在切换会话时取一次快照的话，agent（或裸 shell、外部编辑器）改完文件后
 * 它会一直停在「工作区干净」。这里给出两条互补的刷新来源：
 *  - 回合结束 / 进程退出这类「刚干完活」的信号 → 合并成一次刷新；
 *  - 可见前台的兜底轮询 → 覆盖没有可用信号的场景。
 *
 * 纯计时逻辑单独放这里，便于在 Node 里注入假计时器做行为测试。
 */

export interface GitStatusRefreshTimers<Handle = ReturnType<typeof globalThis.setTimeout>> {
  setTimeout(handler: () => void, timeout: number): Handle;
  clearTimeout(handle: Handle): void;
  setInterval(handler: () => void, timeout: number): Handle;
  clearInterval(handle: Handle): void;
}

export interface GitStatusRefreshOptions<Handle = ReturnType<typeof globalThis.setTimeout>> {
  /** 成串到达的「这一轮干完了」信号合并成一次刷新。 */
  coalesceMs: number;
  /** 没有可用信号时的兜底轮询间隔。 */
  pollMs: number;
  /** 当前选中会话；null 表示没有可刷新的会话。 */
  selectedSessionId(): string | null;
  /** 页面不可见时不轮询：后台标签页的定时器会被节流，也没人在看。 */
  hidden(): boolean;
  refresh(sessionId: string): void;
  timers?: GitStatusRefreshTimers<Handle>;
}

export interface GitStatusRefreshController {
  /** 工作区可能变了 → 合并成一次刷新。 */
  schedule(): void;
  startPolling(): void;
  /** 登出 / 拆壳时停掉兜底轮询，避免未登录状态下继续打接口。 */
  stop(): void;
}

const defaultTimers: GitStatusRefreshTimers = {
  setTimeout: (handler, timeout) => globalThis.setTimeout(handler, timeout),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
  setInterval: (handler, timeout) => globalThis.setInterval(handler, timeout),
  clearInterval: (handle) => globalThis.clearInterval(handle),
};

export function createGitStatusRefresh<Handle = ReturnType<typeof globalThis.setTimeout>>(
  options: GitStatusRefreshOptions<Handle>,
): GitStatusRefreshController {
  const timers = options.timers ?? (defaultTimers as unknown as GitStatusRefreshTimers<Handle>);
  let refreshTimer: Handle | null = null;
  let pollTimer: Handle | null = null;

  function schedule(): void {
    // 已经排了一次就不再往后推：连续信号应当尽快刷新，而不是无限顺延。
    if (refreshTimer !== null || !options.selectedSessionId()) return;
    refreshTimer = timers.setTimeout(() => {
      refreshTimer = null;
      const sessionId = options.selectedSessionId();
      if (sessionId) options.refresh(sessionId);
    }, options.coalesceMs);
  }

  function startPolling(): void {
    if (pollTimer !== null) return;
    pollTimer = timers.setInterval(() => {
      if (options.hidden()) return;
      const sessionId = options.selectedSessionId();
      if (sessionId) options.refresh(sessionId);
    }, options.pollMs);
  }

  function stop(): void {
    if (refreshTimer !== null) {
      timers.clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (pollTimer !== null) {
      timers.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  return { schedule, startPolling, stop };
}
