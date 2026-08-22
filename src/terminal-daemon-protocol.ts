import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { TerminalSessionState, TerminalSpawnRequest } from "./terminal-host.js";

export const TERMINAL_DAEMON_PROTOCOL_VERSION = 1;

export interface TerminalDaemonPaths {
  socketPath: string;
  tokenPath: string;
  pidPath: string;
}

export type TerminalDaemonRequest = {
  kind: "request";
  id: number;
  token: string;
  protocolVersion: number;
  method: "hello" | "list" | "createOrAttach" | "write" | "resize" | "kill" | "forget";
  params?: Record<string, unknown>;
};

export type TerminalDaemonResponse = {
  kind: "response";
  id: number;
  ok: true;
  result?: unknown;
} | {
  kind: "response";
  id: number;
  ok: false;
  error: string;
};

export type TerminalDaemonEvent = {
  kind: "event";
  event: "data" | "exit";
  sessionId: string;
  incarnationId: string;
  data?: string;
  seq?: number;
  exitCode?: number;
  signal?: number;
};

export interface TerminalDaemonCreateParams extends TerminalSpawnRequest {
  afterSeq?: number;
}

export interface TerminalDaemonAttachPayload {
  state: TerminalSessionState;
  isNew: boolean;
}

export function terminalDaemonPaths(configPath: string): TerminalDaemonPaths {
  const resolved = path.resolve(configPath);
  const suffix = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  const dir = path.dirname(resolved);
  const uid = (() => {
    try { return os.userInfo().uid; } catch { return 0; }
  })();
  return {
    socketPath: process.platform === "win32"
      ? `\\\\.\\pipe\\wand-terminald-${suffix}`
      // Unix-domain socket paths are limited to roughly 100 bytes on macOS.
      // Keep the endpoint short even when the config lives in a deep directory;
      // the per-config secret remains alongside the config with mode 0600.
      : path.join("/tmp", `wand-terminald-${uid}-${suffix}.sock`),
    tokenPath: path.join(dir, `.terminald-${suffix}.token`),
    pidPath: path.join(dir, `.terminald-${suffix}.pid`),
  };
}
