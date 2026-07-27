import { evaluateRestartReadiness, normalizeRestartVersion } from "./model";
import { httpRestartOverlayRepository } from "./repository";
import type {
  RestartOverlayClock,
  RestartOverlayController,
  RestartOverlayControllerDependencies,
  RestartOverlayMode,
  RestartOverlaySnapshot,
} from "./types";

export const RESTART_POLL_INTERVAL_MS = 2_000;
export const RESTART_MAX_ATTEMPTS = 180;
export const RESTART_PROBE_TIMEOUT_MS = RESTART_POLL_INTERVAL_MS;
export const RESTART_DEADLINE_MS = RESTART_POLL_INTERVAL_MS * RESTART_MAX_ATTEMPTS;

type Listener = () => void;

function blankSnapshot(revision = 0): RestartOverlaySnapshot {
  return {
    open: false,
    mode: "restart",
    phase: "idle",
    currentVersion: "",
    latestVersion: "",
    target: { previousInstanceId: "", expectedVersion: "" },
    attempts: 0,
    maxAttempts: RESTART_MAX_ATTEMPTS,
    readiness: {
      ready: false,
      instanceReady: false,
      versionReady: false,
      currentInstanceId: "",
      currentVersion: "",
    },
    lastError: "",
    revision,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "服务尚未就绪。";
}

function normalizedText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Owns the full restart state machine. Callers only choose a presentation;
 * polling, readiness gates, timeout, cancellation, and reload stay internal.
 */
export function createRestartOverlayController(
  dependencies: RestartOverlayControllerDependencies,
): RestartOverlayController {
  let snapshot = blankSnapshot();
  let pollTimer: unknown = null;
  let deadlineTimer: unknown = null;
  let probeTimer: unknown = null;
  let request: AbortController | null = null;
  let generation = 0;
  const listeners = new Set<Listener>();

  function publish(patch: Partial<Omit<RestartOverlaySnapshot, "revision">>): void {
    snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 };
    for (const listener of listeners) listener();
  }

  function stopPollTimer(): void {
    if (pollTimer === null) return;
    dependencies.clock.clearInterval(pollTimer);
    pollTimer = null;
  }

  function stopDeadlineTimer(): void {
    if (deadlineTimer === null) return;
    dependencies.clock.clearTimeout(deadlineTimer);
    deadlineTimer = null;
  }

  function stopProbeTimer(): void {
    if (probeTimer === null) return;
    dependencies.clock.clearTimeout(probeTimer);
    probeTimer = null;
  }

  function abortProbe(reason = new DOMException("Restart probe cancelled.", "AbortError")): void {
    stopProbeTimer();
    const activeRequest = request;
    request = null;
    activeRequest?.abort(reason);
  }

  function stopSchedule(): void {
    stopPollTimer();
    stopDeadlineTimer();
  }

  function stopPolling(): void {
    stopSchedule();
    abortProbe();
  }

  function timeOut(runGeneration: number): void {
    if (
      runGeneration !== generation
      || !snapshot.open
      || snapshot.phase === "ready"
      || snapshot.phase === "timed-out"
    ) return;
    stopSchedule();
    abortProbe();
    publish({ phase: "timed-out" });
  }

  function failReload(error: unknown): void {
    publish({
      phase: "timed-out",
      lastError: errorMessage(error),
    });
  }

  function reloadPage(): void {
    try {
      dependencies.reloadPage();
    } catch (error) {
      failReload(error);
    }
  }

  async function poll(runGeneration: number): Promise<void> {
    if (
      runGeneration !== generation
      || !snapshot.open
      || snapshot.phase === "timed-out"
      || snapshot.phase === "ready"
    ) return;

    // The interval is also a hard boundary for the preceding probe. This keeps
    // the historic one-probe-per-2s cadence even when a repository ignores its
    // AbortSignal and never settles.
    if (request !== null) {
      abortProbe(new DOMException("Restart probe timed out.", "TimeoutError"));
    }

    const abort = new AbortController();
    request = abort;
    const attempt = snapshot.attempts + 1;
    publish({ phase: "checking", attempts: attempt, lastError: "" });

    let removeAbortListener = (): void => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const handleAbort = (): void => {
        removeAbortListener();
        reject(abort.signal.reason instanceof Error
          ? abort.signal.reason
          : new DOMException("Restart probe cancelled.", "AbortError"));
      };
      removeAbortListener = () => abort.signal.removeEventListener("abort", handleAbort);
      abort.signal.addEventListener("abort", handleAbort, { once: true });
    });
    probeTimer = dependencies.clock.setTimeout(() => {
      if (runGeneration !== generation || request !== abort) return;
      abort.abort(new DOMException("Restart probe timed out.", "TimeoutError"));
    }, RESTART_PROBE_TIMEOUT_MS);

    let becameReady = false;
    try {
      const config = await Promise.race([
        dependencies.repository.loadConfig({ signal: abort.signal }),
        aborted,
      ]);
      if (
        abort.signal.aborted
        || runGeneration !== generation
        || request !== abort
        || !snapshot.open
      ) return;
      const readiness = evaluateRestartReadiness(snapshot.target, config);
      becameReady = readiness.ready;
      publish({
        phase: readiness.ready ? "ready" : "waiting",
        readiness,
        lastError: "",
      });
      if (readiness.ready) {
        stopSchedule();
        reloadPage();
      }
    } catch (error) {
      if (
        runGeneration !== generation
        || request !== abort
        || !snapshot.open
      ) return;
      if (abort.signal.aborted && abort.signal.reason instanceof DOMException) {
        if (abort.signal.reason.name !== "TimeoutError") return;
        publish({ phase: "waiting", lastError: "服务状态检查超时，正在重试。" });
      } else {
        publish({ phase: "waiting", lastError: errorMessage(error) });
      }
    } finally {
      removeAbortListener();
      if (request === abort) {
        stopProbeTimer();
        request = null;
      }
    }

    if (
      !becameReady
      && runGeneration === generation
      && snapshot.open
      && attempt >= RESTART_MAX_ATTEMPTS
    ) {
      timeOut(runGeneration);
    }
  }

  function begin(
    mode: RestartOverlayMode,
    currentVersion: string,
    latestVersion: string,
    previousInstanceId?: string | null,
    expectedVersion?: string | null,
  ): void {
    generation += 1;
    stopPolling();
    const target = {
      previousInstanceId: normalizedText(previousInstanceId),
      expectedVersion: normalizeRestartVersion(expectedVersion),
    };
    snapshot = {
      open: true,
      mode,
      phase: "waiting",
      currentVersion: normalizedText(currentVersion),
      latestVersion: normalizedText(latestVersion),
      target,
      attempts: 0,
      maxAttempts: RESTART_MAX_ATTEMPTS,
      readiness: {
        ready: false,
        instanceReady: !target.previousInstanceId,
        versionReady: !target.expectedVersion,
        currentInstanceId: "",
        currentVersion: "",
      },
      lastError: "",
      revision: snapshot.revision + 1,
    };
    for (const listener of listeners) listener();
    const runGeneration = generation;
    pollTimer = dependencies.clock.setInterval(
      () => { void poll(runGeneration); },
      RESTART_POLL_INTERVAL_MS,
    );
    deadlineTimer = dependencies.clock.setTimeout(
      () => timeOut(runGeneration),
      RESTART_DEADLINE_MS,
    );
  }

  return {
    showRestart(previousInstanceId, expectedVersion): void {
      begin(
        "restart",
        "",
        normalizedText(expectedVersion),
        previousInstanceId,
        expectedVersion,
      );
    },

    showAutoUpdate(currentVersion, latestVersion, previousInstanceId): void {
      begin(
        "auto-update",
        currentVersion,
        latestVersion,
        previousInstanceId,
        latestVersion,
      );
    },

    manualRefresh(): void {
      if (!snapshot.open) return;
      reloadPage();
    },

    isOpen(): boolean {
      return snapshot.open;
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot(): RestartOverlaySnapshot {
      return snapshot;
    },

    dispose(): void {
      generation += 1;
      stopPolling();
      if (!snapshot.open && snapshot.phase === "idle") return;
      snapshot = blankSnapshot(snapshot.revision + 1);
      for (const listener of listeners) listener();
    },
  };
}

const browserClock: RestartOverlayClock = {
  setInterval(callback, delayMs): unknown {
    return globalThis.setInterval(() => { void callback(); }, delayMs);
  },
  clearInterval(handle): void {
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>);
  },
  setTimeout(callback, delayMs): unknown {
    return globalThis.setTimeout(() => { void callback(); }, delayMs);
  },
  clearTimeout(handle): void {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export const restartOverlayController = createRestartOverlayController({
  repository: httpRestartOverlayRepository,
  clock: browserClock,
  reloadPage: () => globalThis.location.reload(),
});

export function showRestart(
  previousInstanceId?: string | null,
  expectedVersion?: string | null,
): void {
  restartOverlayController.showRestart(previousInstanceId, expectedVersion);
}

export function showAutoUpdate(
  currentVersion: string,
  latestVersion: string,
  previousInstanceId?: string | null,
): void {
  restartOverlayController.showAutoUpdate(currentVersion, latestVersion, previousInstanceId);
}

declare global {
  interface Window {
    __wandReactRestartOverlay?: RestartOverlayController;
  }
}
