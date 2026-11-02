/**
 * MCP Apps 面板宿主探针（子进程）。
 *
 * MCP Apps 的界面是一份 `ui://` 资源（HTML），只能通过持有 thread 的 app-server 读取；
 * 面板里的交互按钮又要回到同一条 MCP 连接上调用工具。因此面板打开时起一个只读探针：
 *   initialize → thread/resume(excludeTurns) → mcp/resource/read → 常驻等待 tools/call
 * 探针不启动任何模型回合，空闲超时或宿主关闭时退出。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { createUtf8TextDecoder } from "./structured-exec-host.js";
import { MAX_PROTOCOL_LINE_BYTES } from "./bounded-process-output.js";
import { codexRpcError } from "./codex-app-error.js";

interface Launch {
  file: string;
  threadId: string;
  cwd: string;
  server: string;
  uri: string;
  originCallId?: string;
  idleTimeoutMs?: number;
}

interface CallMessage {
  id: string;
  method: "tool/call" | "close";
  tool?: string;
  arguments?: unknown;
}

const emit = (event: Record<string, unknown>): void => { process.stdout.write(JSON.stringify(event) + "\n"); };

let launch: Launch | undefined;
let launchReady = false;
let announceLaunch!: () => void;
const launchPromise = new Promise<void>((resolve) => { announceLaunch = resolve; });

let sequence = 0;
let threadId = "";
let closed = false;
let launched = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, { method: string; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let child: ChildProcessWithoutNullStreams | undefined;
const wire = (value: unknown): void => { child?.stdin?.write(JSON.stringify(value) + "\n"); };
const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`Codex ${method} 超时`));
  }, 30_000);
  pending.set(id, { method, resolve, reject, timer });
  wire({ id, method, params });
});

const shutdown = (): void => {
  if (closed) return;
  closed = true;
  if (idleTimer) clearTimeout(idleTimer);
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("面板已关闭")); }
  pending.clear();
  try { child?.stdin?.end(); } catch { /* already gone */ }
  child?.kill("SIGTERM");
  const force = setTimeout(() => child?.kill("SIGKILL"), 2000);
  force.unref();
};

/** 空闲回收：面板没人用时不长期占用 app-server。 */
const armIdle = (): void => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { emit({ type: "closed", reason: "idle" }); shutdown(); },
    Math.max(60_000, Math.min(30 * 60_000, launch?.idleTimeoutMs ?? 10 * 60_000)));
  idleTimer.unref();
};

/** 面板侧调用工具：转发到同一条 MCP 连接，不经过模型。 */
async function handleCall(message: CallMessage): Promise<void> {
  if (closed) return;
  if (typeof message.tool !== "string" || !message.tool.trim()) {
    emit({ id: message.id, error: "工具名无效" });
    return;
  }
  armIdle();
  try {
    const result = await request("mcpServer/tool/call", {
      threadId, server: launch?.server, tool: message.tool,
      arguments: message.arguments ?? {},
    });
    const content = Array.isArray(result?.content) ? result.content : [];
    emit({
      id: message.id,
      result: {
        content,
        ...(result?.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        ...(typeof result?.isError === "boolean" ? { isError: result.isError } : {}),
      },
    });
  } catch (error) {
    emit({ id: message.id, error: (error as Error).message });
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  if (!launchReady) {
    launch = JSON.parse(line) as Launch;
    launchReady = true;
    announceLaunch();
    return;
  }
  let message: CallMessage;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.method === "tool/call" && typeof message.id === "string") { void handleCall(message); return; }
  if (message?.method === "close") shutdown();
});
input.on("close", () => shutdown());

await launchPromise;
const config = launch!;
child = spawn(config.file, ["app-server", "--listen", "stdio://"], {
  cwd: config.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"],
}) as ChildProcessWithoutNullStreams;

child.on("error", (error) => { emit({ type: "error", message: error.message }); shutdown(); });
child.once("close", () => {
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("app-server 已退出")); }
  pending.clear();
  if (!closed) { closed = true; emit({ type: "closed", reason: "exit" }); }
});
child.stderr.on("data", () => {});

const decoder = createUtf8TextDecoder();
let carry = "";
child.stdout.on("data", (chunk) => {
  carry += decoder.write(chunk);
  let end: number;
  while ((end = carry.indexOf("\n")) >= 0) {
    const line = carry.slice(0, end);
    carry = carry.slice(end + 1);
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) { emit({ type: "error", message: "协议行超出上限" }); shutdown(); return; }
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.id !== undefined && event.method === undefined) {
      const call = pending.get(event.id);
      if (!call) continue;
      pending.delete(event.id);
      clearTimeout(call.timer);
      if (event.error) {
        const error = codexRpcError(call.method, event.error, config.threadId);
        call.reject(Object.assign(error, { unsupported: !error.retryForbidden }));
      }
      else call.resolve(event.result);
    }
  }
  if (Buffer.byteLength(carry) > MAX_PROTOCOL_LINE_BYTES) { carry = ""; emit({ type: "error", message: "协议行超出上限" }); shutdown(); }
});

try {
  armIdle();
  await request("initialize", { clientInfo: { name: "wand", version: "1.0.0" }, capabilities: { experimentalApi: true } });
  wire({ method: "initialized" });
  const resumed = await request("thread/resume", { threadId: config.threadId, cwd: config.cwd, excludeTurns: true });
  threadId = resumed?.thread?.id ?? config.threadId;
  const read = await request("mcpServer/resource/read", {
    threadId, server: config.server, uri: config.uri,
    ...(config.originCallId ? { originCallId: config.originCallId } : {}),
  });
  const contents = Array.isArray(read?.contents) ? read.contents : [];
  const first = contents.find((entry: any) => entry && typeof entry.text === "string" && entry.text.length > 0);
  if (!first) {
    emit({ type: "unsupported", message: "该插件没有返回可渲染的界面资源。" });
    shutdown();
  } else {
    launched = true;
    emit({
      type: "resource",
      mimeType: typeof first.mimeType === "string" ? first.mimeType : "text/html",
      html: first.text,
      uri: typeof first.uri === "string" ? first.uri : config.uri,
      originCallId: read?.originCallId ?? config.originCallId ?? null,
    });
  }
} catch (error) {
  if (!launched) {
    emit({ type: (error as { unsupported?: boolean }).unsupported ? "unsupported" : "error", message: (error as Error).message });
    shutdown();
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => shutdown());
