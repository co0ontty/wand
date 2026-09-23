import { lstatSync, utimesSync } from "node:fs";
import type net from "node:net";

const CONNECT_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;

/** Bound connect attempts, including sockets that close before the handshake. */
export function waitForDaemonSocket(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onConnect = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); socket.destroy(); reject(error); };
    const onClose = (): void => onError(new Error("Daemon socket closed while connecting"));
    const timer = setTimeout(() => onError(new Error("Daemon socket connect timed out")), CONNECT_TIMEOUT_MS);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

/** Probe the application, not just the fd: a half-open socket may still be writable. */
export function startDaemonHeartbeat(
  socket: net.Socket,
  probe: () => Promise<unknown>,
  options: { socketPath?: string; intervalMs?: number; timeoutMs?: number } = {},
): () => void {
  const { socketPath, intervalMs = HEARTBEAT_INTERVAL_MS, timeoutMs = HEARTBEAT_TIMEOUT_MS } = options;
  // Old daemons have no listener watchdog. Refresh their existing endpoint's
  // timestamps after a successful probe so idle /tmp cleanup won't remove it.
  const identity = (() => {
    if (!socketPath || process.platform === "win32") return null;
    try {
      const stat = lstatSync(socketPath);
      return stat.isSocket() && (typeof process.getuid !== "function" || stat.uid === process.getuid())
        ? stat : null;
    } catch { return null; }
  })();
  let lastTouch = 0;
  let stopped = false;
  let inFlight = false;
  let deadline: NodeJS.Timeout | null = null;
  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
    if (deadline) clearTimeout(deadline);
    socket.off("close", stop);
  };
  const fail = (): void => {
    if (stopped) return;
    stop();
    // Destroy this generation only; its close handler performs normal replay
    // and reconnect. Never retry mutating RPCs or terminate the daemon.
    socket.destroy(new Error("Daemon heartbeat failed; reconnecting"));
  };
  const timer = setInterval(() => {
    if (stopped || inFlight || socket.destroyed) return;
    inFlight = true;
    deadline = setTimeout(fail, timeoutMs);
    deadline.unref();
    void Promise.resolve().then(() => stopped ? undefined : probe()).then(() => {
      if (deadline) clearTimeout(deadline);
      deadline = null;
      inFlight = false;
      if (stopped || !identity || !socketPath || Date.now() - lastTouch < 60_000) return;
      try {
        const stat = lstatSync(socketPath);
        if (stat.dev === identity.dev && stat.ino === identity.ino) {
          const now = new Date();
          utimesSync(socketPath, now, now);
          lastTouch = Date.now();
        }
      } catch { /* The owning daemon repairs a missing path; never replace it here. */ }
    }, fail);
  }, intervalMs);
  timer.unref();
  socket.once("close", stop);
  return stop;
}
