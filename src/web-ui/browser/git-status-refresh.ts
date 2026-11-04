/**
 * 顶栏 git 徽章的刷新节拍。
 *
 * 徽章只在切换会话时取一次快照的话，agent（或裸 shell、外部编辑器）改完文件后
 * 它会一直停在「工作区干净」。回合结束 / 进程退出信号合并成一次刷新。
 * 切换、回前台与提交面板由各入口主动加载；空闲期间不轮询。
 *
 * 纯计时逻辑单独放这里，便于在 Node 里注入假计时器做行为测试。
 */

export interface GitStatusRefreshTimers<Handle = ReturnType<typeof globalThis.setTimeout>> {
  setTimeout(handler: () => void, timeout: number): Handle;
  clearTimeout(handle: Handle): void;
}

export interface GitStatusRefreshOptions<Handle = ReturnType<typeof globalThis.setTimeout>> {
  /** 成串到达的「这一轮干完了」信号合并成一次刷新。 */
  coalesceMs: number;
  /** 当前选中会话；null 表示没有可刷新的会话。 */
  selectedSessionId(): string | null;
  refresh(sessionId: string): void;
  timers?: GitStatusRefreshTimers<Handle>;
}

export interface GitStatusRefreshController {
  /** 工作区可能变了 → 合并成一次刷新。 */
  schedule(): void;
  /** 登出 / 拆壳时取消尚未发出的刷新。 */
  stop(): void;
}

const defaultTimers: GitStatusRefreshTimers = {
  setTimeout: (handler, timeout) => globalThis.setTimeout(handler, timeout),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export function createGitStatusRefresh<Handle = ReturnType<typeof globalThis.setTimeout>>(
  options: GitStatusRefreshOptions<Handle>,
): GitStatusRefreshController {
  const timers = options.timers ?? (defaultTimers as unknown as GitStatusRefreshTimers<Handle>);
  let refreshTimer: Handle | null = null;

  function schedule(): void {
    // 已经排了一次就不再往后推：连续信号应当尽快刷新，而不是无限顺延。
    if (refreshTimer !== null || !options.selectedSessionId()) return;
    refreshTimer = timers.setTimeout(() => {
      refreshTimer = null;
      const sessionId = options.selectedSessionId();
      if (sessionId) options.refresh(sessionId);
    }, options.coalesceMs);
  }

  function stop(): void {
    if (refreshTimer !== null) {
      timers.clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  return { schedule, stop };
}
