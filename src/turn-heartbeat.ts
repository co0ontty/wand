/**
 * 回合静默期心跳：一条回合真的还在跑（structured `inFlight` / PTY `ptyBusy`），但服务端
 * 连续这么久没产生任何事件时，用**现有的 status 事件类型**重发一次权威快照（带上最新的
 * turn 锚点），给客户端「仍在运行、只是这一句很长」的证据。
 *
 * 这里不新增协议、不新增事件类型，也不做无界轮询：
 *   - timer 是会话级的，只在回合在飞期间存在；
 *   - `observe()` 在回合开始和每次观测到活动时重新计时（对齐 process-manager 里
 *     `refreshPtyTurn()` 的既有做法）；
 *   - `cancel()` 在回合结束 / 会话停止、删除时立即撤销；
 *   - `dispose()` 在服务关闭时清干净，不允许任何 timer 跨进程存活；
 *   - 触发一次后由 `notify` 的返回值决定是否续下一个窗口——回合不再在飞就自然停。
 */

/**
 * 静默阈值 30s：大致是用户开始怀疑「是不是卡死了」的时间尺度，同时保证一轮最多触发
 * 两次心跳就把「还在跑」传达出去。注意这与 `ws-broadcast` 的 HEARTBEAT_INTERVAL_MS
 * 不是一回事——那个只探测 socket 连接活性，不携带会话事实。
 */
export const TURN_QUIET_HEARTBEAT_MS = 30_000;

export class TurnQuietHeartbeat {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  constructor(
    /** 重发快照；返回 true 表示这一轮仍在飞，需要继续下一个静默窗口。 */
    private readonly notify: (sessionId: string) => boolean,
    private readonly delayMs = TURN_QUIET_HEARTBEAT_MS,
  ) {}

  /** 观测到活动（回合开始 / 输出 chunk / 状态变化）：把静默窗口往后推。 */
  observe(sessionId: string): void {
    if (this.disposed) return;
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      if (this.disposed) return;
      if (this.notify(sessionId)) this.observe(sessionId);
    }, this.delayMs);
    // 心跳不能让空闲进程 / 测试用例挂在 event loop 上。
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  /** 回合收敛或会话被移除：立即撤销这个会话的静默窗口。 */
  cancel(sessionId: string): void {
    const existing = this.timers.get(sessionId);
    if (!existing) return;
    clearTimeout(existing);
    this.timers.delete(sessionId);
  }

  /** 服务关闭：一次性丢掉所有在飞的窗口，之后不再接受新的 observe。 */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
