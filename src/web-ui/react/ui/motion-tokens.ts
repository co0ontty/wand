import * as React from "react";

/**
 * 「结果停留」时长：提交后完成态 / 失败态在原位停多久再恢复或前进。
 * 真值见 docs/motion-design.md:63（Android 同名常量 SEND_SENT_DWELL_MS / SEND_FAILED_DWELL_MS），
 * 两端同值，不即兴。CSS 侧的 --motion-dwell-sent / --motion-dwell-failed 只供样式表引用，
 * 两边不做跨层读取。
 *
 * reduce-motion 不归零这两项：它们是「读结果的等待」，不是位移/缩放/淡入。
 */
/** Hold-to-talk intent threshold, shared with native WandMotion.voiceHoldDelay (not an animation). */
export const VOICE_HOLD_DELAY_MS = 180;
export const MOTION_DWELL_SENT_MS = 720;
export const MOTION_DWELL_FAILED_MS = 1500;

/**
 * 一整句结果文案（批量操作计数、worktree 合并结论、密码修改说明）要在原位读完，
 * 比按钮/标签级的 MOTION_DWELL_SENT_MS 长；刻意仍短于 MOTION_DWELL_FAILED_MS，
 * 保持「失败停留 ≥ 成功」。页面不得再写自己的毫秒。
 */
export const MOTION_DWELL_RESULT_SENTENCE_MS = 1200;

/**
 * 处理中点阵的错峰间隔（不是驻留）：与 content/styles.css 里
 * task-board-processing-dot 的 900ms 周期配套，改这里必须同时核对那条动画。
 */
export const MOTION_PROCESSING_STAGGER_MS = 150;

/** Geometry timing comes only from the existing CSS tokens, with no feature fallback. */
export function readMotionTokenMs(token: "--motion-fast" | "--motion-normal" | "--motion-indicator"): number {
  if (typeof document === "undefined") return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value * (raw.endsWith("ms") ? 1 : 1000) : 0;
}

export function useReducedMotion(): boolean {
  const read = (): boolean => typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [reduced, setReduced] = React.useState(read);
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduced(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}
