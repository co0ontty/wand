/**
 * 「正在执行」的客户端推导：只允许对服务端下发的运行事实与锚点时刻做展示差分。
 * 锚点（turnStartedAt / lastActivityAt）缺失时一律不显示时长，前端不本地起表伪造运行中。
 */

/** 服务端会话快照里本模块关心的字段（structured 与 PTY 共用同一形状）。 */
export interface RunningActivityShape {
  readonly status?: string;
  readonly archived?: boolean;
  readonly permissionBlocked?: boolean;
  readonly pendingEscalation?: unknown;
  readonly queuedMessages?: readonly unknown[] | null;
  /**
   * PTY 本轮是否真在跑（computeRunningSignal().ptyRunning）。
   * 裸 shell 的 status 一直是 running，不带上这个判定会把空闲终端读成「正在执行」。
   */
  readonly ptyRunning?: boolean;
  readonly structuredState?: {
    readonly inFlight?: boolean;
    readonly phase?: string;
    readonly turnStartedAt?: string | null;
    readonly lastActivityAt?: string | null;
  } | null;
  readonly turnStartedAt?: string | null;
  readonly lastActivityAt?: string | null;
}

/** 团队 run / 步骤的对应字段（与 run detail、/live 同语义）。 */
export interface RunningRunShape {
  readonly status?: string;
  readonly startedAt?: string | null;
  readonly turnStartedAt?: string | null;
  readonly lastActivityAt?: string | null;
}

export type RunningPhase = "received" | "executing" | "waiting" | "idle";

/** 静默起显阈值：超过后从「正在执行」升级为「仍在运行 · 已 N 分钟无新消息」。 */
export const SILENCE_NOTICE_MS = 60_000;

const RUNNING_STATUSES = new Set([
  "running", "thinking", "waiting-input", "waiting_input",
  // 团队 run 的等待相位仍是「这一轮没结束」，收敛只发生在 done/failed/stopped。
  "awaiting_approval", "waiting_user",
]);

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/** 本轮开始时刻：只取服务端锚点，缺失返回 null（调用方不得回落到本地挂载时刻）。 */
export function turnStartedAtMs(source: RunningActivityShape | null | undefined): number | null {
  if (!source) return null;
  return parseTime(source.structuredState?.turnStartedAt) ?? parseTime(source.turnStartedAt);
}

/** 最近一次服务端观测到活动的时刻。 */
export function lastActivityAtMs(source: RunningActivityShape | RunningRunShape | null | undefined): number | null {
  if (!source) return null;
  const structured = (source as RunningActivityShape).structuredState?.lastActivityAt;
  return parseTime(structured)
    ?? parseTime((source as RunningActivityShape).lastActivityAt)
    ?? parseTime((source as RunningRunShape).lastActivityAt);
}

export function isRunningNow(source: RunningActivityShape | RunningRunShape | null | undefined): boolean {
  if (!source) return false;
  if ((source as RunningActivityShape).archived) return false;
  const activity = source as RunningActivityShape;
  if (activity.permissionBlocked || activity.pendingEscalation) return true;
  if (activity.structuredState?.inFlight) return true;
  const status = (source as RunningRunShape).status;
  return typeof status === "string" && RUNNING_STATUSES.has(status);
}

/** 会话侧运行事实：structured 看本轮 inFlight，PTY 看 ptyRunning，两者都不看本地计时。 */
export function sessionRunning(source: RunningActivityShape | null | undefined): boolean {
  if (!source || source.archived) return false;
  return Boolean(source.structuredState?.inFlight) || source.ptyRunning === true;
}

/**
 * 分阶段：等待审批/输入 > 已接收排队 > 正在执行 > 结束。
 * 非运行中一律 idle，调用方必须据此立即收敛状态条，不留残留。
 * `runMode` 给团队 run：那里的 status 就是运行事实本身。会话侧不行——裸 shell 的
 * status 恒为 running，必须走 sessionRunning（structured inFlight / PTY ptyRunning）。
 */
export function computeRunningPhase(
  source: RunningActivityShape | null | undefined,
  runMode = false,
): RunningPhase {
  if (!source) return "idle";
  // 排队未空 = 服务端还欠这一轮回复，属于「已接收」；不能被会话级 idle 吞掉。
  if ((source.queuedMessages?.length ?? 0) > 0) return "received";
  if (!(runMode ? isRunningNow(source) : sessionRunning(source))) return "idle";
  if (source.permissionBlocked || source.pendingEscalation) return "waiting";
  return "executing";
}

/** 距最近一次活动已静默多久；锚点缺失或不在运行中时为 0。 */
export function silenceDurationMs(
  source: RunningActivityShape | RunningRunShape | null | undefined,
  nowMs: number,
): number {
  if (!isRunningNow(source) && !sessionRunning(source)) return 0;
  const last = lastActivityAtMs(source);
  if (last === null) return 0;
  return Math.max(0, nowMs - last);
}

/** 静默超阈值时的提示文案；不满足条件返回 null。 */
export function silenceNotice(
  source: RunningActivityShape | RunningRunShape | null | undefined,
  nowMs: number,
  thresholdMs: number = SILENCE_NOTICE_MS,
): string | null {
  const silence = silenceDurationMs(source, nowMs);
  if (silence < thresholdMs) return null;
  return `仍在运行 · 已 ${formatMinutes(silence)}无新消息`;
}

/** 与 formatElapsedShort 不同：面向「已 N 分钟」这类自然语言读数。 */
export function formatMinutes(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`;
}

export const PHASE_LABELS: Readonly<Record<RunningPhase, string>> = {
  received: "已接收",
  executing: "正在执行",
  waiting: "等待你的输入",
  idle: "",
};

/**
 * 状态条的完整文案。运行中恒有文字（阶段 + 已运行时长），静默超阈值时追加无新消息提示，
 * 这样「还在跑」和「已经停了」在界面上一眼可分。
 */
export function runningStatusText(
  source: RunningActivityShape | null | undefined,
  nowMs: number,
  runMode = false,
): string {
  const phase = computeRunningPhase(source, runMode);
  if (phase === "idle") return "";
  const parts = [PHASE_LABELS[phase]];
  const started = turnStartedAtMs(source);
  if (started !== null) parts.push(`已运行 ${formatMinutes(Math.max(0, nowMs - started))}`);
  const silence = silenceNotice(source, nowMs);
  if (silence) parts.push(silence);
  return parts.join(" · ");
}

/** 团队侧文案：run 级锚点，语义与会话侧一致。 */
export function runStatusText(source: RunningRunShape | null | undefined, nowMs: number): string {
  if (!isRunningNow(source)) return "";
  const waiting = source?.status === "awaiting_approval" || source?.status === "waiting_user";
  const parts = [waiting ? PHASE_LABELS.waiting : PHASE_LABELS.executing];
  const started = parseTime(source?.turnStartedAt) ?? parseTime(source?.startedAt);
  if (started !== null) parts.push(`已运行 ${formatMinutes(Math.max(0, nowMs - started))}`);
  const silence = silenceNotice(source, nowMs);
  if (silence) parts.push(silence);
  return parts.join(" · ");
}
