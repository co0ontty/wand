/**
 * 「结果停留」时长：提交后完成态 / 失败态在原位停多久再恢复或前进。
 * 真值见 docs/motion-design.md:63（Android 同名常量 SEND_SENT_DWELL_MS / SEND_FAILED_DWELL_MS），
 * 两端同值，不即兴。CSS 侧的 --motion-dwell-sent / --motion-dwell-failed 只供样式表引用，
 * 两边不做跨层读取。
 *
 * reduce-motion 不归零这两项：它们是「读结果的等待」，不是位移/缩放/淡入。
 */
export const MOTION_DWELL_SENT_MS = 720;
export const MOTION_DWELL_FAILED_MS = 1500;
