import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Separate structured process daemon. v1 PTY socket and wire format are unchanged. */
export const STRUCTURED_RENDER_PROTOCOL_VERSION = 2;
export const STRUCTURED_RENDER_RUN_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const STRUCTURED_RENDER_REPLAY_PAGE_MAX_BYTES = 512 * 1024;

/** Envelope and length-prefixed JSON framing are identical to Render v1. */
export { encodeRenderFrame, decodeRenderFrames } from "./render-protocol.js";
export type { RenderResponse, RenderErrorCode } from "./render-protocol.js";

export interface StructuredRenderRunState {
  runId: string;
  incarnationId: string;
  pid: number;
  status: "running" | "exited";
  exitCode: number | null;
  signal: number | null;
  stdoutSeq: number;
  stderrSeq: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface StructuredRenderSpawnParams {
  runId: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdinData?: string;
}

export interface StructuredRenderSpawnResult {
  state: StructuredRenderRunState;
  isNew: boolean;
}

/** Inventory deliberately carries no raw bytes, prompt, argv, cwd or env. */
export interface StructuredRenderListResult {
  runs: StructuredRenderRunState[];
}

export interface StructuredRenderAttachParams {
  runId: string;
  afterStdoutSeq?: number;
  afterStderrSeq?: number;
  maxBytes?: number;
}

export interface StructuredRenderReplayStream {
  chunks: { seq: number; data: string }[];
  nextSeq: number;
  complete: boolean;
  resetRequired: boolean;
}

export interface StructuredRenderAttachResult {
  state: StructuredRenderRunState;
  stdout: StructuredRenderReplayStream;
  stderr: StructuredRenderReplayStream;
}

export interface StructuredRenderHelloResult {
  version: string;
  protocolVersion: number;
  pid: number;
  startedAt: string;
  runs: number;
}

export interface StructuredRenderStatsResult {
  runs: number;
  runningRuns: number;
  retainedLogBytes: number;
  rssBytes: number;
}

export type StructuredRenderEvent =
  | { event: "stream"; runId: string; incarnationId: string;
      stream: "stdout" | "stderr"; seq: number; data: string }
  | { event: "exit"; runId: string; incarnationId: string;
      exitCode: number | null; signal: number | null }
  | { event: "reconcile"; runIds: string[] };

export type StructuredRenderMethod =
  | "hello" | "ping" | "list" | "spawn" | "attach" | "interrupt" | "forget" | "stats" | "shutdown";

export interface StructuredRenderRequest {
  id: number;
  token: string;
  protocolVersion: number;
  method: StructuredRenderMethod;
  params?: Record<string, unknown>;
}

export interface StructuredRenderPaths {
  socketPath: string;
  tokenPath: string;
  pidPath: string;
  metaPath: string;
}

/** Mirrors Rust normalized_absolute() and config_suffix(), in an independent namespace. */
export function structuredRenderPaths(configPath: string): StructuredRenderPaths {
  const absolute = path.resolve(configPath);
  let resolved = absolute;
  try { resolved = realpathSync(absolute); } catch { /* config may not exist yet */ }
  const suffix = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  const dir = path.dirname(resolved);
  const uid = (() => {
    try { return os.userInfo().uid; } catch { return 0; }
  })();
  return {
    socketPath: path.join("/tmp", `wand-structured-render-${uid}-${suffix}.sock`),
    tokenPath: path.join(dir, `.structured-render-${suffix}.token`),
    pidPath: path.join(dir, `.structured-render-${suffix}.pid`),
    metaPath: path.join(dir, `.structured-render-${suffix}.json`),
  };
}
