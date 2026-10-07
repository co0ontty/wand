import assert from "node:assert/strict";
import test from "node:test";
import {
  SILENCE_NOTICE_MS,
  computeRunningPhase,
  formatMinutes,
  isRunningNow,
  lastActivityAtMs,
  runStatusText,
  runningStatusText,
  silenceDurationMs,
  silenceNotice,
  turnStartedAtMs,
} from "../src/web-ui/running-activity.js";

const NOW = Date.parse("2026-10-07T04:00:00.000Z");
const started = new Date(NOW - 90_000).toISOString();
const justNow = new Date(NOW - 5_000).toISOString();

test("running reads come only from server anchors, never a local clock", () => {
  assert.equal(turnStartedAtMs({ structuredState: { inFlight: true } }), null);
  assert.equal(turnStartedAtMs({ structuredState: { inFlight: true, turnStartedAt: started } }), NOW - 90_000);
  // PTY 侧锚点在快照顶层。
  assert.equal(turnStartedAtMs({ turnStartedAt: started }), NOW - 90_000);
  assert.equal(lastActivityAtMs({ structuredState: { lastActivityAt: justNow } }), NOW - 5_000);
  assert.equal(runningStatusText({ structuredState: { inFlight: true } }, NOW), "正在执行");
  assert.ok(!runningStatusText({ structuredState: { inFlight: true } }, NOW).includes("已运行"));
});

test("phases advance received → executing → waiting and collapse when not running", () => {
  assert.equal(computeRunningPhase({ status: "idle", queuedMessages: ["下一句"] }), "received");
  assert.equal(computeRunningPhase({ structuredState: { inFlight: true } }), "executing");
  assert.equal(computeRunningPhase({ structuredState: { inFlight: true }, permissionBlocked: true }), "waiting");
  assert.equal(computeRunningPhase({ structuredState: { inFlight: true }, pendingEscalation: {} }), "waiting");
  // 裸 shell 的 status 恒为 running，没有 ptyRunning 就不许说「正在执行」。
  assert.equal(computeRunningPhase({ status: "running" }), "idle");
  assert.equal(computeRunningPhase({ status: "running", ptyRunning: true }), "executing");
  for (const settled of [
    undefined,
    { archived: true, structuredState: { inFlight: true } },
    { status: "idle", structuredState: { inFlight: false } },
    { status: "failed", structuredState: { inFlight: false } },
  ]) {
    assert.equal(computeRunningPhase(settled), "idle");
    assert.equal(runningStatusText(settled, NOW), "");
  }
});

test("silence only surfaces after the threshold and stops at once when the turn ends", () => {
  const silent = { structuredState: { inFlight: true, turnStartedAt: started, lastActivityAt: new Date(NOW - SILENCE_NOTICE_MS - 1).toISOString() } };
  assert.equal(silenceNotice(silent, NOW), "仍在运行 · 已 1 分钟无新消息");
  assert.ok(runningStatusText(silent, NOW).includes("已运行 1 分"));
  const talking = { structuredState: { inFlight: true, turnStartedAt: started, lastActivityAt: justNow } };
  assert.equal(silenceNotice(talking, NOW), null);
  // 结束收敛：即使 lastActivityAt 很旧，也不许再说「仍在运行」。
  assert.equal(silenceNotice({ ...talking, status: "idle", structuredState: { inFlight: false } }, NOW), null);
  assert.equal(silenceDurationMs({ structuredState: { inFlight: true } }, NOW), 0);
});

test("team run text keeps the same semantics and collapses on terminal statuses", () => {
  assert.equal(isRunningNow({ status: "running" }), true);
  assert.equal(isRunningNow({ status: "awaiting_approval" }), true);
  assert.equal(runStatusText({ status: "awaiting_approval", startedAt: started }, NOW), "等待你的输入 · 已运行 1 分钟");
  assert.equal(runStatusText({ status: "running", startedAt: started }, NOW), "正在执行 · 已运行 1 分钟");
  for (const terminal of ["done", "failed", "stopped"] as const) {
    assert.equal(isRunningNow({ status: terminal, lastActivityAt: started }), false);
    assert.equal(runStatusText({ status: terminal, lastActivityAt: started }, NOW), "");
  }
  assert.equal(runStatusText({ status: "running" }, NOW), "正在执行");
});

test("elapsed reads stay in natural language across magnitudes", () => {
  assert.equal(formatMinutes(500), "0 秒");
  assert.equal(formatMinutes(59_000), "59 秒");
  assert.equal(formatMinutes(60_000), "1 分钟");
  assert.equal(formatMinutes(3_600_000), "1 小时");
  assert.equal(formatMinutes(3_720_000), "1 小时 2 分钟");
});
