import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createRestartOverlayController,
  RESTART_DEADLINE_MS,
  RESTART_MAX_ATTEMPTS,
  RESTART_POLL_INTERVAL_MS,
  RESTART_PROBE_TIMEOUT_MS,
} from "../src/web-ui/react/restart-overlay/controller.ts";
import { MemoryRestartOverlayRepository } from "../src/web-ui/react/restart-overlay/memory-repository.ts";
import {
  evaluateRestartReadiness,
  normalizeRestartVersion,
  restartOverlayPresentation,
} from "../src/web-ui/react/restart-overlay/model.ts";
import {
  HttpRestartOverlayRepository,
  normalizeRestartOverlayConfig,
  RestartOverlayRepositoryError,
} from "../src/web-ui/react/restart-overlay/repository.ts";
import type {
  RestartOverlayClock,
  RestartOverlayRepository,
  RestartOverlayRepositoryOptions,
  RestartOverlaySnapshot,
} from "../src/web-ui/react/restart-overlay/types.ts";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class FakeRestartClock implements RestartOverlayClock {
  readonly delays: number[] = [];
  readonly timeoutDelays: number[] = [];
  private nextId = 0;
  private now = 0;
  private callbacks = new Map<number, {
    callback: () => void | Promise<void>;
    delayMs: number;
    dueAt: number;
    repeating: boolean;
  }>();

  setInterval(callback: () => void | Promise<void>, delayMs: number): unknown {
    const id = ++this.nextId;
    this.delays.push(delayMs);
    this.callbacks.set(id, {
      callback,
      delayMs,
      dueAt: this.now + delayMs,
      repeating: true,
    });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.callbacks.delete(Number(handle));
  }

  setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown {
    const id = ++this.nextId;
    this.timeoutDelays.push(delayMs);
    this.callbacks.set(id, {
      callback,
      delayMs,
      dueAt: this.now + delayMs,
      repeating: false,
    });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(Number(handle));
  }

  async advanceBy(durationMs: number): Promise<void> {
    const target = this.now + durationMs;
    while (true) {
      const dueAt = Math.min(
        ...[...this.callbacks.values()]
          .map((timer) => timer.dueAt)
          .filter((time) => time <= target),
      );
      if (!Number.isFinite(dueAt)) break;
      this.now = dueAt;
      const dueIds = [...this.callbacks.entries()]
        .filter(([, timer]) => timer.dueAt === dueAt)
        .map(([id]) => id)
        .sort((left, right) => left - right);
      for (const id of dueIds) {
        const timer = this.callbacks.get(id);
        if (!timer || timer.dueAt !== dueAt) continue;
        if (timer.repeating) timer.dueAt += timer.delayMs;
        else this.callbacks.delete(id);
        await timer.callback();
        await Promise.resolve();
      }
    }
    this.now = target;
    await Promise.resolve();
  }

  async tick(): Promise<void> {
    await this.advanceBy(RESTART_POLL_INTERVAL_MS);
  }

  get activeCount(): number {
    return this.callbacks.size;
  }
}

class NeverResolvingRestartRepository implements RestartOverlayRepository {
  readonly calls: AbortSignal[] = [];

  loadConfig(options: RestartOverlayRepositoryOptions = {}): Promise<never> {
    if (options.signal) this.calls.push(options.signal);
    return new Promise(() => {});
  }
}

function snapshot(overrides: Partial<RestartOverlaySnapshot> = {}): RestartOverlaySnapshot {
  return {
    open: true,
    mode: "restart",
    phase: "waiting",
    currentVersion: "",
    latestVersion: "",
    target: { previousInstanceId: "old", expectedVersion: "2.0.0" },
    attempts: 1,
    maxAttempts: RESTART_MAX_ATTEMPTS,
    readiness: {
      ready: false,
      instanceReady: false,
      versionReady: false,
      currentInstanceId: "old",
      currentVersion: "1.0.0",
    },
    lastError: "",
    revision: 1,
    ...overrides,
  };
}

test("version normalization and readiness preserve the legacy double gate", () => {
  assert.equal(normalizeRestartVersion(" v2.3.4+debug.123 "), "2.3.4");
  assert.equal(normalizeRestartVersion("2.3.4-beta.1+sha"), "2.3.4-beta.1");
  assert.equal(normalizeRestartVersion(null), "");

  assert.deepEqual(evaluateRestartReadiness(
    { previousInstanceId: "old", expectedVersion: "v2.0.0+build" },
    { serverInstanceId: "new", packageVersion: "2.0.0+local", currentVersion: "9.0.0" },
  ), {
    ready: true,
    instanceReady: true,
    versionReady: true,
    currentInstanceId: "new",
    currentVersion: "2.0.0",
  });
  assert.equal(evaluateRestartReadiness(
    { previousInstanceId: "old", expectedVersion: "2.0.0" },
    { serverInstanceId: "old", packageVersion: "2.0.0", currentVersion: "2.0.0" },
  ).ready, false);
  assert.equal(evaluateRestartReadiness(
    { previousInstanceId: "old", expectedVersion: "2.0.0" },
    { serverInstanceId: "new", packageVersion: "1.9.0", currentVersion: "1.9.0" },
  ).ready, false);
});

test("presentation exposes update, polling, mismatch, ready, and timeout live states", () => {
  assert.deepEqual(restartOverlayPresentation(snapshot({
    mode: "auto-update",
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    attempts: 0,
  })), {
    title: "自动更新中",
    description: "1.0.0 → 2.0.0\n正在下载并安装新版本，完成后将自动重启。",
    liveStatus: "正在等待更新完成并重启服务…",
  });
  assert.match(restartOverlayPresentation(snapshot({ phase: "checking" })).liveStatus, /正在检查服务状态/);
  assert.match(restartOverlayPresentation(snapshot({
    readiness: {
      ready: false,
      instanceReady: true,
      versionReady: false,
      currentInstanceId: "new",
      currentVersion: "1.0.0",
    },
  })).liveStatus, /新服务已启动.*版本 2\.0\.0/);
  assert.match(restartOverlayPresentation(snapshot({ phase: "ready" })).liveStatus, /均已就绪/);
  assert.match(restartOverlayPresentation(snapshot({ phase: "timed-out" })).liveStatus, /手动刷新/);
  assert.match(restartOverlayPresentation(snapshot({ lastError: "offline" })).liveStatus, /服务暂不可用/);
});

test("HTTP restart repository preserves the authenticated config contract", async () => {
  const calls: Array<{ input: string; init: RequestInit }> = [];
  const abort = new AbortController();
  const repository = new HttpRestartOverlayRepository((async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    calls.push({ input: String(input), init });
    return json({
      serverInstanceId: "instance-2",
      packageVersion: "2.0.0",
      currentVersion: "2.0.0+display",
      ignored: true,
    });
  }) as typeof fetch);

  assert.deepEqual(await repository.loadConfig({ signal: abort.signal }), {
    serverInstanceId: "instance-2",
    packageVersion: "2.0.0",
    currentVersion: "2.0.0+display",
  });
  assert.equal(calls[0].input, "/api/config");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.signal, abort.signal);
  assert.equal(calls[0].init.method, undefined);
  assert.deepEqual(normalizeRestartOverlayConfig(null), {
    serverInstanceId: "",
    packageVersion: "",
    currentVersion: "",
  });
});

test("HTTP restart repository surfaces HTTP, JSON, and server errors", async () => {
  const denied = new HttpRestartOverlayRepository((async () => (
    json({ error: "not authenticated" }, 401)
  )) as typeof fetch);
  await assert.rejects(
    () => denied.loadConfig(),
    (error: unknown) => error instanceof RestartOverlayRepositoryError
      && error.status === 401
      && error.message === "not authenticated",
  );

  const malformed = new HttpRestartOverlayRepository((async () => (
    new Response("not-json", { status: 503 })
  )) as typeof fetch);
  await assert.rejects(
    () => malformed.loadConfig(),
    (error: unknown) => error instanceof RestartOverlayRepositoryError && error.status === 503,
  );
});

test("memory restart repository repeats its final immutable step and honors abort", async () => {
  const repository = new MemoryRestartOverlayRepository([
    { serverInstanceId: "old", packageVersion: "1.0.0", currentVersion: "1.0.0" },
    { serverInstanceId: "new", packageVersion: "2.0.0", currentVersion: "2.0.0" },
  ]);
  const first = await repository.loadConfig();
  first.serverInstanceId = "mutated";
  assert.equal(repository.steps[0] instanceof Error ? "" : repository.steps[0].serverInstanceId, "old");
  assert.equal((await repository.loadConfig()).serverInstanceId, "new");
  assert.equal((await repository.loadConfig()).serverInstanceId, "new");
  assert.equal(repository.calls.length, 3);

  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    () => repository.loadConfig({ signal: abort.signal }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});

test("auto-update polling requires both a new instance and the expected version", async () => {
  const clock = new FakeRestartClock();
  const repository = new MemoryRestartOverlayRepository([
    { serverInstanceId: "new", packageVersion: "1.0.0", currentVersion: "1.0.0" },
    { serverInstanceId: "old", packageVersion: "v2.0.0+build", currentVersion: "2.0.0" },
    { serverInstanceId: "new", packageVersion: "v2.0.0+build", currentVersion: "2.0.0" },
  ]);
  let reloads = 0;
  const controller = createRestartOverlayController({
    repository,
    clock,
    reloadPage: () => { reloads += 1; },
  });
  const revisions: number[] = [];
  const unsubscribe = controller.subscribe(() => revisions.push(controller.getSnapshot().revision));

  controller.showAutoUpdate("1.0.0", "v2.0.0+remote", "old");
  assert.equal(controller.isOpen(), true);
  assert.deepEqual(clock.delays, [RESTART_POLL_INTERVAL_MS]);
  assert.deepEqual(clock.timeoutDelays, [RESTART_DEADLINE_MS]);
  assert.equal(controller.getSnapshot().target.expectedVersion, "2.0.0");

  await clock.tick();
  assert.equal(controller.getSnapshot().readiness.instanceReady, true);
  assert.equal(controller.getSnapshot().readiness.versionReady, false);
  assert.equal(reloads, 0);
  await clock.tick();
  assert.equal(controller.getSnapshot().readiness.instanceReady, false);
  assert.equal(controller.getSnapshot().readiness.versionReady, true);
  assert.equal(reloads, 0);
  await clock.tick();
  assert.equal(controller.getSnapshot().phase, "ready");
  assert.equal(controller.getSnapshot().attempts, 3);
  assert.equal(clock.activeCount, 0);
  assert.equal(reloads, 1);
  assert.ok(revisions.length >= 7);

  unsubscribe();
  controller.dispose();
});

test("plain restart polling accepts any version after the process instance changes", async () => {
  const clock = new FakeRestartClock();
  const repository = new MemoryRestartOverlayRepository([
    { serverInstanceId: "new", packageVersion: "9.9.9", currentVersion: "9.9.9" },
  ]);
  let reloads = 0;
  const controller = createRestartOverlayController({
    repository,
    clock,
    reloadPage: () => { reloads += 1; },
  });
  controller.showRestart("old", null);
  assert.equal(controller.getSnapshot().target.expectedVersion, "");
  await clock.tick();
  assert.equal(reloads, 1);
  assert.equal(controller.getSnapshot().phase, "ready");
  controller.dispose();
});

test("fake timer reaches 180 probes, keeps the overlay open, and enables manual refresh", async () => {
  const clock = new FakeRestartClock();
  const repository = new MemoryRestartOverlayRepository([new Error("offline")]);
  let reloads = 0;
  const controller = createRestartOverlayController({
    repository,
    clock,
    reloadPage: () => { reloads += 1; },
  });
  controller.showRestart("old", "2.0.0");

  for (let attempt = 0; attempt < RESTART_MAX_ATTEMPTS; attempt += 1) {
    await clock.tick();
  }
  assert.equal(repository.calls.length, RESTART_MAX_ATTEMPTS);
  assert.equal(controller.getSnapshot().attempts, RESTART_MAX_ATTEMPTS);
  assert.equal(controller.getSnapshot().phase, "timed-out");
  assert.equal(controller.isOpen(), true);
  assert.equal(clock.activeCount, 0);
  assert.equal(reloads, 0);
  await clock.tick();
  assert.equal(repository.calls.length, RESTART_MAX_ATTEMPTS);
  controller.manualRefresh();
  assert.equal(reloads, 1);
  assert.equal("close" in controller, false);
  controller.dispose();
});

test("wall-clock deadline times out a never-settling repository and keeps manual refresh available", async () => {
  const clock = new FakeRestartClock();
  const repository = new NeverResolvingRestartRepository();
  let reloads = 0;
  const controller = createRestartOverlayController({
    repository,
    clock,
    reloadPage: () => { reloads += 1; },
  });
  controller.showRestart("old", "2.0.0");

  await clock.advanceBy(RESTART_DEADLINE_MS);

  assert.equal(repository.calls.length, RESTART_MAX_ATTEMPTS);
  assert.ok(repository.calls.every((signal) => signal.aborted));
  assert.equal(controller.getSnapshot().attempts, RESTART_MAX_ATTEMPTS);
  assert.equal(controller.getSnapshot().phase, "timed-out");
  assert.equal(controller.isOpen(), true);
  assert.equal(clock.activeCount, 0);
  assert.ok(clock.timeoutDelays.includes(RESTART_PROBE_TIMEOUT_MS));
  assert.equal(reloads, 0);

  controller.manualRefresh();
  assert.equal(reloads, 1);
  controller.dispose();
});

test("a new presentation aborts an unresolved probe and clears the previous generation timers", async () => {
  const clock = new FakeRestartClock();
  const firstSignals: AbortSignal[] = [];
  let calls = 0;
  const repository: RestartOverlayRepository = {
    loadConfig(options = {}) {
      calls += 1;
      if (calls === 1) {
        if (options.signal) firstSignals.push(options.signal);
        return new Promise(() => {});
      }
      return Promise.resolve({
        serverInstanceId: "new",
        packageVersion: "3.0.0",
        currentVersion: "3.0.0",
      });
    },
  };
  let reloads = 0;
  const controller = createRestartOverlayController({
    repository,
    clock,
    reloadPage: () => { reloads += 1; },
  });
  controller.showAutoUpdate("1.0.0", "2.0.0", "old");
  await clock.tick();
  assert.equal(firstSignals.length, 1);
  assert.equal(firstSignals[0].aborted, false);
  controller.showRestart("old", "3.0.0");
  assert.equal(firstSignals[0].aborted, true);
  assert.equal(clock.activeCount, 2);
  assert.deepEqual(clock.delays, [RESTART_POLL_INTERVAL_MS, RESTART_POLL_INTERVAL_MS]);
  await clock.tick();
  assert.equal(reloads, 1);
  assert.equal(controller.getSnapshot().latestVersion, "3.0.0");
  assert.equal(clock.activeCount, 0);
  controller.dispose();
});

test("restart host is non-dismissable, live, safe-area aware, and mobile responsive", () => {
  const host = readFileSync(
    new URL("../src/web-ui/react/restart-overlay/host.tsx", import.meta.url),
    "utf8",
  );
  const styles = readFileSync(
    new URL("../src/web-ui/react/restart-overlay/styles.ts", import.meta.url),
    "utf8",
  );
  assert.match(host, /<WandDialogSurface/);
  assert.match(host, /dismissable=\{false\}/);
  assert.match(host, /onOpenChange=\{\(\) => \{\}\}/);
  assert.match(host, /aria-live=/);
  assert.match(host, /role=\{snapshot\.phase === "timed-out" \? "alert" : "status"\}/);
  assert.match(host, /controller\.manualRefresh\(\)/);
  assert.ok(!host.includes("onClick={() => controller.dispose"));
  assert.ok(!host.includes("fetch("));
  assert.match(styles, /var\(--wand-safe-top\)/);
  assert.match(styles, /var\(--wand-safe-right\)/);
  assert.match(styles, /var\(--wand-safe-bottom\)/);
  assert.match(styles, /var\(--wand-safe-left\)/);
  assert.match(styles, /@media \(max-width: 600px\)/);
  assert.match(styles, /wand-restart-header > \.wand-ui-button[\s\S]*display: none/);
});
