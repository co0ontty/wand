import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Render 协议 v1 的 TS 镜像。Rust 单一真源在
 * `render/crates/wand-render-protocol/src/lib.rs`，契约文档在
 * `render/docs/render-protocol.md`（本仓库 `docs/render-protocol.md` 只是指针）。
 *
 * 两侧常量与字段名必须逐一对齐；任一侧改动都要同时提升版本号并更新文档。
 */
export const RENDER_PROTOCOL_VERSION = 1;

/** 单帧上限：`u32` 大端长度前缀 + UTF-8 JSON。 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** 与 `PTY_OUTPUT_MAX_SIZE` 对齐（chunk 窗口 / output 有界）。 */
export const RENDER_PTY_OUTPUT_MAX_CHARS = 200_000;

export type RenderErrorCode =
  | "unauthorized"
  | "badRequest"
  | "notFound"
  | "conflict"
  | "unsupportedMethod"
  | "protocolMismatch"
  | "internal";

export interface RenderRequest {
  id: number;
  token: string;
  protocolVersion: number;
  method: RenderMethod;
  params?: Record<string, unknown>;
}

export type RenderMethod =
  | "hello"
  | "ping"
  | "list"
  | "attach"
  | "createOrAttach"
  | "write"
  | "resize"
  | "kill"
  | "forget"
  | "stats"
  | "shutdown";

export interface RenderResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code: RenderErrorCode; message: string };
}

export type RenderEvent =
  | { event: "data"; sessionId: string; incarnationId: string; data: string; seq: number }
  | { event: "exit"; sessionId: string; incarnationId: string; exitCode: number | null; signal: number | null }
  | { event: "reconcile"; sessionIds: string[] };

export interface RenderHelloResult {
  version: string;
  protocolVersion: number;
  pid: number;
  startedAt: string;
  sessions: number;
}

export interface RenderSessionState {
  sessionId: string;
  incarnationId: string;
  pid: number;
  status: "running" | "exited";
  exitCode: number | null;
  cols: number;
  rows: number;
  seq: number;
  output: string;
  chunks: { data: string; seq: number }[];
  terminalSnapshot: {
    version: number;
    data: string;
    cols: number;
    rows: number;
    pending: ({ type: "data"; data: string } | { type: "resize"; cols: number; rows: number })[];
  } | null;
  launchMarkerToken: string | null;
}

export interface RenderCreateOrAttachParams {
  sessionId: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  name: string;
  cols: number;
  rows: number;
  launchMarkerToken?: string;
  afterSeq?: number;
}

export interface RenderStatsResult {
  uptimeMs: number;
  sessions: number;
  liveBytes: number;
  rssBytes: number;
}

export interface RenderPaths {
  socketPath: string;
  tokenPath: string;
  pidPath: string;
  metaPath: string;
}

/**
 * config 路径的 canonical 形式：`realpathSync` 解析符号链接，失败（文件尚未创建）
 * 才回退纯词法的 `path.resolve`。
 *
 * 两侧必须对同一 config 派生出**同一套**路径，而「同一份 config」在用户那里常常是
 * 经过符号链接的路径（`~/.wand` → 别的卷、`/tmp` → `/private/tmp`、容器挂载点）。
 * 一侧做 realpath、另一侧只做 resolve，就会算出两个 suffix：同一个 config 出现两个
 * Render、两套 PTY 所有权 —— 这正是要靠寻址归一化防住的故障。
 */
function canonicalConfigPath(configPath: string): string {
  const resolved = path.resolve(configPath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Render 的按 config 隔离寻址。
 *
 * 与 legacy `terminald`（`wand-terminald-<uid>-<suffix>.sock` /
 * `.terminald-<suffix>.token`）**刻意使用不同文件名**：升级期两套并存，
 * 但永不互相领养。
 */
export function renderPaths(configPath: string, uidOverride?: number): RenderPaths {
  const resolved = canonicalConfigPath(configPath);
  const suffix = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  const dir = path.dirname(resolved);
  const uid = resolveEndpointUid(uidOverride);
  return {
    // macOS 的 Unix socket 路径上限约 100 字节，所以 socket 放 /tmp 保持短。
    socketPath: path.join("/tmp", `wand-render-${uid}-${suffix}.sock`),
    tokenPath: path.join(dir, `.render-${suffix}.token`),
    pidPath: path.join(dir, `.render-${suffix}.pid`),
    metaPath: path.join(dir, `.render-${suffix}.json`),
  };
}

/**
 * 端点里的 uid 是**跑 daemon 那个用户**的，不是调用者的。
 *
 * `wand service:install` 是拿 sudo 跑的，而 daemon 在 unit/plist 里被钉成 config 的
 * owner；调用方必须显式传 owner uid，否则 root 会算出 `/tmp/wand-render-0-<hash>.sock`
 * 这种永远不存在的路径（2026-09-24 就这么把两个健康 daemon 误判成僵尸杀掉了）。
 */
export function resolveEndpointUid(uidOverride?: number): number {
  if (typeof uidOverride === "number" && Number.isInteger(uidOverride) && uidOverride >= 0) return uidOverride;
  try { return os.userInfo().uid; } catch { return 0; }
}

/** 编码一帧：`u32` 大端长度 + UTF-8 JSON。 */
export function encodeRenderFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`Render frame of ${body.length} bytes exceeds the ${MAX_FRAME_BYTES} byte limit`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * 从累积缓冲区解出所有完整帧。
 *
 * 返回剩余（不完整）字节。长度越界时抛错，调用方应关闭连接。
 */
export function decodeRenderFrames<T>(buffer: Buffer): { frames: T[]; rest: Buffer } {
  const frames: T[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32BE(offset);
    if (length > MAX_FRAME_BYTES) {
      throw new Error(`Render frame length ${length} exceeds the ${MAX_FRAME_BYTES} byte limit`);
    }
    if (buffer.length - offset - 4 < length) break;
    const body = buffer.subarray(offset + 4, offset + 4 + length);
    frames.push(JSON.parse(body.toString("utf8")) as T);
    offset += 4 + length;
  }
  return { frames, rest: offset === 0 ? buffer : buffer.subarray(offset) };
}

/** 是否为 protocol v1 事件帧（无 `id`，带 `event`）。 */
export function isRenderEvent(value: unknown): value is RenderEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.event === "string" && record.id === undefined;
}
