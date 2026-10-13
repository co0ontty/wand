import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderDiscovery, SessionTimers } from "../src/process-manager-timers.ts";

function fakeClock() {
  const timers: Array<{ at: number; fn: () => void; handle: { unref: () => void; cleared: boolean; unrefCalled: boolean } }> = [];
  let now = 0;
  return {
    now: () => now,
    setTimer(fn: () => void, delay: number) {
      const handle = { cleared: false, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push({ at: now + delay, fn, handle });
      return handle as unknown as NodeJS.Timeout;
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((t) => !t.handle.cleared && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        due.handle.cleared = true;
        due.fn();
      }
      now = target;
    },
    pending: () => timers.filter((t) => !t.handle.cleared).length,
    all: () => timers,
  };
}

function withFakeTimers<T>(clock: ReturnType<typeof fakeClock>, body: () => T): T {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void, delay: number) => clock.setTimer(fn, delay)) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle: { cleared?: boolean }) => { if (handle) (handle as { cleared: boolean }).cleared = true; }) as unknown as typeof clearTimeout;
  try {
    return body();
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

test("ProviderDiscovery stops at the attempt cap with backoff and reports exhaustion once", () => {
  const clock = fakeClock();
  let exhausted: number[] = [];
  const attempts: number[] = [];
  withFakeTimers(clock, () => {
    const discovery = new ProviderDiscovery({
      now: clock.now,
      maxAttempts: 4,
      attempt: () => { attempts.push(clock.now()); return false; },
      onExhausted: (count) => exhausted.push(count),
    });
    discovery.start();
    clock.advance(10 * 60_000);
  });
  assert.equal(attempts.length, 4);
  assert.deepEqual(attempts, [500, 1500, 3500, 7500], "first attempt at 500ms, then 1s, 2s, 4s backoff");
  assert.deepEqual(exhausted, [4]);
});

test("ProviderDiscovery stops once the attempt reports success and never re-arms", () => {
  const clock = fakeClock();
  let calls = 0;
  withFakeTimers(clock, () => {
    const discovery = new ProviderDiscovery({ now: clock.now, attempt: () => { calls += 1; return calls === 2; } });
    discovery.start();
    clock.advance(60_000);
    assert.equal(discovery.active, false);
  });
  assert.equal(calls, 2);
});

test("ProviderDiscovery stops at the wall-clock deadline", () => {
  const clock = fakeClock();
  let calls = 0;
  withFakeTimers(clock, () => {
    const discovery = new ProviderDiscovery({ now: clock.now, deadlineMs: 2_000, attempt: () => { calls += 1; return false; } });
    discovery.start();
    clock.advance(60_000);
  });
  assert.ok(calls >= 1 && calls <= 4, `expected a bounded number of attempts, got ${calls}`);
  assert.ok(calls < 100);
});

test("ProviderDiscovery timers are unref'd and cancel() is idempotent", () => {
  const clock = fakeClock();
  let calls = 0;
  withFakeTimers(clock, () => {
    const discovery = new ProviderDiscovery({ now: clock.now, attempt: () => { calls += 1; return false; } });
    discovery.start();
    assert.equal(clock.all()[0].handle.unrefCalled, true);
    discovery.cancel();
    discovery.cancel();
    clock.advance(60_000);
    assert.equal(discovery.active, false);
  });
  assert.equal(calls, 0);
});

test("SessionTimers.clearAll cancels every discovery and timer in the group", () => {
  const timers = new SessionTimers();
  let calls = 0;
  timers.startDiscovery("claude", () => { calls += 1; return false; });
  timers.startDiscovery("codex", () => { calls += 1; return false; });
  assert.equal(timers.hasDiscovery("claude"), true);
  timers.clearAll();
  assert.equal(timers.hasDiscovery("claude"), false);
  assert.equal(timers.hasDiscovery("codex"), false);
  assert.equal(timers.ptyTurn, null);
  assert.equal(timers.initialInput, null);
});
