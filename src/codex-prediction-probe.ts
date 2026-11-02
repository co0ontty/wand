/**
 * 一次性 Codex 预测探针（子进程）。
 *
 * 为什么单独起进程：Codex 的预测通知只能在持有 thread 的 app-server 里拿到，而 Wand 的
 * 回合进程在 `turn/completed` 后就退出。把预测塞进回合末尾会拖住回合收敛（宿主按进程
 * 退出判定完成），所以预测只在用户显式要求时另起一个只读探针：
 *   initialize → thread/resume(excludeTurns) → thread/prediction/request → 等通知 → 退出。
 *
 * 探针不发 turn/start，也不改任何会话状态；它产生的只是「下一条输入建议」。
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { createUtf8TextDecoder } from "./structured-exec-host.js";
import { MAX_PROTOCOL_LINE_BYTES } from "./bounded-process-output.js";
import { codexRpcError } from "./codex-app-error.js";

interface Launch {
  file: string;
  threadId: string;
  /** 省略时探针自己取最近一个回合（thread/turns/list）。 */
  sourceTurnId?: string;
  cwd: string;
  timeoutMs?: number;
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let launch: Launch | undefined;
for await (const line of input) { launch = JSON.parse(line) as Launch; break; }
input.close();
if (!launch) throw new Error("Missing Codex prediction launch");

const config = launch;
const emit = (event: Record<string, unknown>): void => { process.stdout.write(JSON.stringify(event) + "\n"); };
const child = spawn(config.file, ["app-server", "--listen", "stdio://"], {
  cwd: config.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"],
});

let sequence = 0;
let settled = false;
let threadId = "";
const pending = new Map<number, { method: string; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
const finish = (payload: Record<string, unknown>): void => {
  if (settled) return;
  settled = true;
  clearTimeout(deadline);
  emit(payload);
  child.stdin.end();
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 2000);
  force.unref();
};
const fail = (message: string, unsupported = false): void => finish({ type: unsupported ? "unsupported" : "error", message });
const wire = (value: unknown): void => { child.stdin.write(JSON.stringify(value) + "\n"); };
const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`Codex ${method} 超时`));
  }, 30_000);
  pending.set(id, { method, resolve, reject, timer });
  wire({ id, method, params });
});

const deadline = setTimeout(
  () => fail("预测请求超时，未返回结果。"),
  Math.max(5_000, Math.min(120_000, config.timeoutMs ?? 30_000)),
);
deadline.unref();

const decoder = createUtf8TextDecoder();
let carry = "";
child.stdout.on("data", (chunk) => {
  carry += decoder.write(chunk);
  let end: number;
  while ((end = carry.indexOf("\n")) >= 0) {
    const line = carry.slice(0, end);
    carry = carry.slice(end + 1);
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) { fail("预测协议行超出上限。"); return; }
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
      continue;
    }
    if (event.method === "thread/prediction/updated") {
      const params = event.params ?? {};
      if (threadId && params.threadId && params.threadId !== threadId) continue;
      if (config.sourceTurnId && params.sourceTurnId && params.sourceTurnId !== config.sourceTurnId) continue;
      const result = params.result ?? {};
      if (result.type === "completed") finish({ type: "prediction", text: typeof result.text === "string" ? result.text : "" });
      else fail("预测未能生成。");
    }
  }
  if (Buffer.byteLength(carry) > MAX_PROTOCOL_LINE_BYTES) fail("预测协议行超出上限。");
});
child.stderr.on("data", () => {});
child.once("error", (error) => fail(error.message));
child.once("close", () => {
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("Codex app-server 已退出")); }
  pending.clear();
  if (!settled) fail("Codex app-server 提前退出，未返回预测。");
});

try {
  await request("initialize", { clientInfo: { name: "wand", version: "1.0.0" }, capabilities: { experimentalApi: true } });
  wire({ method: "initialized" });
  const resumed = await request("thread/resume", { threadId: config.threadId, cwd: config.cwd, excludeTurns: true });
  threadId = resumed?.thread?.id ?? config.threadId;
  let sourceTurnId = config.sourceTurnId ?? "";
  if (!sourceTurnId) {
    const turns = await request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
    const latest = Array.isArray(turns?.data) ? turns.data[0] : undefined;
    sourceTurnId = typeof latest?.id === "string" ? latest.id : "";
  }
  if (!sourceTurnId) fail("该会话还没有可预测的回合。", true);
  else await request("thread/prediction/request", { threadId, sourceTurnId });
} catch (error) {
  fail((error as Error).message, (error as { unsupported?: boolean }).unsupported === true);
}
