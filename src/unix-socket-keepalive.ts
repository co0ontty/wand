import { lstatSync, utimesSync } from "node:fs";
import type net from "node:net";

import { getErrorMessage } from "./error-utils.js";

/** Restore only a missing endpoint; existing connections and their owners stay alive. */
export function keepUnixSocketAlive(
  server: net.Server,
  socketPath: string,
  onListening: () => void,
  intervalMs = 1_000,
): () => void {
  if (process.platform === "win32") return () => {};
  let identity = lstatSync(socketPath);
  let recovering = false;
  let binding = false;
  let stopped = false;
  let lastTouch = Date.now();
  let warned = false;
  const report = (error: unknown): void => {
    if (warned) return;
    warned = true;
    process.stderr.write(`[wand] Socket recovery failed: ${getErrorMessage(error)}\n`);
  };
  const onError = (error: Error): void => {
    if (!recovering) return;
    binding = false;
    report(error);
  };
  const onListeningAgain = (): void => {
    if (!binding) return;
    binding = false;
    if (stopped) { server.close(); return; }
    try {
      onListening();
      identity = lstatSync(socketPath);
      lastTouch = Date.now();
      recovering = false;
      warned = false;
      process.stderr.write("[wand] Restored missing Unix socket; existing sessions preserved.\n");
    } catch (error) { report(error); }
  };
  server.on("error", onError);
  server.on("listening", onListeningAgain);
  const timer = setInterval(() => {
    if (stopped || binding) return;
    try {
      const current = lstatSync(socketPath);
      // Never touch a replacement file/socket owned by another listener.
      if (current.dev === identity.dev && current.ino === identity.ino
        && Date.now() - lastTouch >= 60_000) {
        const now = new Date();
        utimesSync(socketPath, now, now);
        lastTouch = Date.now();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { report(error); return; }
    }
    if (!server.listening && !recovering) return;
    recovering = true;
    binding = true;
    // close() stops accepting immediately; do not await existing connections,
    // which must remain usable while this same server binds a new endpoint.
    if (server.listening) server.close();
    try {
      server.listen(socketPath);
    } catch (error) { binding = false; report(error); }
  }, intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    // Keep the listener through an in-flight bind so shutdown cannot recreate
    // a reachable endpoint after the caller has closed the daemon.
    if (binding) server.once("listening", () => server.close());
    server.off("listening", onListeningAgain);
    server.off("error", onError);
  };
}
