import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitStatusRefresh,
  type GitStatusRefreshTimers,
} from "../src/web-ui/browser/git-status-refresh.ts";

interface FakeTimer {
  id: number;
  handler: () => void;
  timeout: number;
}

interface FakeClock {
  timers: GitStatusRefreshTimers<number>;
  pending: FakeTimer[];
  intervals: FakeTimer[];
  cleared: number[];
  /** 触发下一个待决的 setTimeout（真实定时器触发后就不再待决）。 */
  fireTimeout(): void;
  fireInterval(): void;
}

function fakeTimers(): FakeClock {
  let nextId = 1;
  const pending: FakeTimer[] = [];
  const intervals: FakeTimer[] = [];
  const cleared: number[] = [];
  return {
    pending,
    intervals,
    cleared,
    fireTimeout() {
      const timer = pending.shift();
      if (!timer) throw new Error("没有待决的 setTimeout");
      timer.handler();
    },
    fireInterval() {
      const timer = intervals[0];
      if (!timer) throw new Error("没有启动轮询");
      timer.handler();
    },
    timers: {
      setTimeout: (handler, timeout) => {
        const timer = { id: nextId++, handler, timeout };
        pending.push(timer);
        return timer.id;
      },
      clearTimeout: (handle) => {
        cleared.push(handle);
        const index = pending.findIndex((timer) => timer.id === handle);
        if (index !== -1) pending.splice(index, 1);
      },
      setInterval: (handler, timeout) => {
        const timer = { id: nextId++, handler, timeout };
        intervals.push(timer);
        return timer.id;
      },
      clearInterval: (handle) => {
        cleared.push(handle);
        const index = intervals.findIndex((timer) => timer.id === handle);
        if (index !== -1) intervals.splice(index, 1);
      },
    },
  };
}

test("回合结束信号合并成一次刷新，且不是一次性的", () => {
  const fake = fakeTimers();
  const refreshed: string[] = [];
  const controller = createGitStatusRefresh({
    coalesceMs: 1200,
    pollMs: 20000,
    selectedSessionId: () => "session-1",
    hidden: () => false,
    refresh: (sessionId) => refreshed.push(sessionId),
    timers: fake.timers,
  });

  controller.schedule();
  controller.schedule();
  controller.schedule();
  assert.equal(fake.pending.length, 1, "连续信号只排一次刷新");
  assert.equal(fake.pending[0].timeout, 1200);

  fake.fireTimeout();
  assert.deepEqual(refreshed, ["session-1"]);

  // 计时器已清空 → 下一轮信号能再排一次（否则每个会话只刷新一次）。
  controller.schedule();
  assert.equal(fake.pending.length, 1);
  fake.fireTimeout();
  assert.deepEqual(refreshed, ["session-1", "session-1"]);
  assert.equal(fake.intervals.length, 0, "schedule 不该顺手开轮询");
});

test("没有选中会话时不排刷新，排上后会话又被切走也不空跑", () => {
  const fake = fakeTimers();
  const refreshed: string[] = [];
  let selected: string | null = null;
  const controller = createGitStatusRefresh({
    coalesceMs: 1200,
    pollMs: 20000,
    selectedSessionId: () => selected,
    hidden: () => false,
    refresh: (sessionId) => refreshed.push(sessionId),
    timers: fake.timers,
  });

  controller.schedule();
  assert.equal(fake.pending.length, 0);
  selected = "session-2";
  controller.schedule();
  assert.equal(fake.pending.length, 1);
  selected = null;
  fake.fireTimeout();
  assert.deepEqual(refreshed, []);
});

test("兜底轮询只在可见且有选中会话时刷新，重复启动只有一个定时器", () => {
  const fake = fakeTimers();
  const refreshed: string[] = [];
  let selected: string | null = "session-3";
  let hidden = false;
  const controller = createGitStatusRefresh({
    coalesceMs: 1200,
    pollMs: 20000,
    selectedSessionId: () => selected,
    hidden: () => hidden,
    refresh: (sessionId) => refreshed.push(sessionId),
    timers: fake.timers,
  });

  controller.startPolling();
  controller.startPolling();
  assert.equal(fake.intervals.length, 1);
  assert.equal(fake.intervals[0].timeout, 20000);

  hidden = true;
  fake.fireInterval();
  assert.deepEqual(refreshed, [], "后台标签页不轮询");

  hidden = false;
  selected = null;
  fake.fireInterval();
  assert.deepEqual(refreshed, []);

  selected = "session-4";
  fake.fireInterval();
  assert.deepEqual(refreshed, ["session-4"]);
});

test("stop 清掉待决刷新与轮询，停掉后再 startPolling 只留一个定时器", () => {
  const fake = fakeTimers();
  const refreshed: string[] = [];
  const controller = createGitStatusRefresh({
    coalesceMs: 1200,
    pollMs: 20000,
    selectedSessionId: () => "session-5",
    hidden: () => false,
    refresh: (sessionId) => refreshed.push(sessionId),
    timers: fake.timers,
  });

  controller.schedule();
  controller.startPolling();
  assert.equal(fake.pending.length, 1);
  assert.equal(fake.intervals.length, 1);

  controller.stop();
  assert.equal(fake.pending.length, 0, "待决刷新要一起清掉，否则登出后还会打一次接口");
  assert.equal(fake.intervals.length, 0);
  assert.deepEqual(refreshed, []);

  // 停掉之后还能重新登录复用：不残留旧定时器，也不会被重建两次。
  controller.startPolling();
  controller.startPolling();
  assert.equal(fake.intervals.length, 1);
  fake.fireInterval();
  assert.deepEqual(refreshed, ["session-5"]);
});
