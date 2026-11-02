/** Owned by the persistent structured host. Server detach never closes Codex's RPC transport. */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { createUtf8TextDecoder } from "./structured-exec-host.js";
import { MAX_PROTOCOL_LINE_BYTES } from "./bounded-process-output.js";
import { codexControlDirectory, type CodexControlInput } from "./codex-app-control.js";
import { codexLocalImageInputs } from "./structured-attachment-input.js";
import { codexRpcError } from "./codex-app-error.js";

interface Launch {
  file: string; sessionId: string; requestId: string; inputMessageId: string;
  prompt: string; threadId: string | null; cwd: string; model?: string;
  developerInstructions?: string; effort?: string | null; sandbox: string;
  /** Wand 上传附件里的图片路径：走 Codex 原生 localImage 输入，而不是只发一行路径文本。 */
  images?: string[];
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let launch: Launch | undefined;
for await (const line of input) { launch = JSON.parse(line) as Launch; break; }
input.close();
if (!launch) throw new Error("Missing Codex bridge launch");
const config = launch;
const directory = codexControlDirectory(config.sessionId, config.requestId);
mkdirSync(directory, { mode: 0o700 });
const emit = (event: Record<string, unknown>): void => { process.stdout.write(JSON.stringify(event) + "\n"); };
const receipt = (id: string, value: unknown): void => {
  const file = path.join(directory, id + ".json");
  writeFileSync(file + ".tmp", JSON.stringify(value), { mode: 0o600 });
  renameSync(file + ".tmp", file);
};
const child = spawn(config.file, ["app-server", "--listen", "stdio://", "--enable", "default_mode_request_user_input"], {
  cwd: config.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"],
});
let sequence = 0;
let threadId = "";
let turnId = "";
let finished = false;
let interrupted = false;
let stopping = false;
let failed = false;
let controls = 0;
let turnRequested = false;
let startup: ReturnType<typeof setTimeout> | undefined;
const requests = new Map<number, { method: string; resolve(value: any): void; reject(error: Error): void; accepted?: () => void; timer: ReturnType<typeof setTimeout> }>();
const questions = new Map<string, { rpcId: string | number; params: any }>();
const resolutions = new Map<string, () => void>();
const wire = (value: unknown): void => { child.stdin.write(JSON.stringify(value) + "\n"); };
/** Codex `UserInput`：正文文本 + 上传附件里的原生图片（localImage）。 */
const userInput = (text: string, images?: readonly string[]): unknown[] => [
  { type: "text", text, text_elements: [] },
  ...codexLocalImageInputs(images),
];
const request = (method: string, params: unknown, accepted?: () => void): Promise<any> => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => {
    requests.delete(id);
    reject(new Error(`Codex ${method} confirmation timed out`));
  }, 30_000);
  requests.set(id, { method, resolve, reject, accepted, timer });
  wire({ id, method, params });
});
const close = (): void => {
  if (!finished || controls || stopping) return;
  stopping = true;
  server.close();
  rmSync(path.join(directory, "control.sock"), { force: true });
  child.stdin.end();
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  timer.unref();
};
const fail = (error: Error): void => {
  if (!turnRequested) emit({ type: "wand_codex_rejected",
    ...((error as { retryForbidden?: boolean }).retryForbidden ? { retryForbidden: true } : {}),
  });
  if (!failed && !finished) emit({ type: "turn.failed", error: { message: error.message } });
  failed = true;
  finished = true;
  close();
};
child.once("error", fail);
child.stdin.on("error", fail);
child.stderr.on("data", chunk => process.stderr.write(chunk));
child.once("close", (code) => {
  if (startup) clearTimeout(startup);
  for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error("Codex app-server exited")); }
  requests.clear();
  if (!finished) fail(new Error(`Codex app-server exited before turn completion (${code})`));
  process.exitCode = failed ? 1 : 0;
});

const server = createServer(socket => {
  socket.setEncoding("utf8");
  socket.setTimeout(30_000, () => socket.destroy());
  let buffer = "";
  let received = false;
  socket.on("error", () => {});
  socket.on("data", chunk => {
    if (received) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) { socket.destroy(); return; }
    if (!buffer.includes("\n")) return;
    received = true;
    void (async () => {
      let command: CodexControlInput | undefined;
      let claimed = false;
      controls++;
      try {
        command = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (!command || !/^[a-f0-9-]{36}$/i.test(command.id) || typeof command.text !== "string" || !command.text.trim()) throw new Error("Invalid Codex input");
        if (finished || !turnId || controls > 1) throw new Error("Codex 当前回合已结束或另一个输入正在交接。");
        const question = command.questionId ? questions.get(command.questionId) : undefined;
        if (command.questionId && !question) throw new Error("该问题已经失效，请刷新会话。");
        if (!command.questionId && questions.size) throw new Error("请先回答当前 Codex 问题。");
        receipt(command.id, { state: "claimed" });
        claimed = true;
        const commit = (): void => {
          receipt(command!.id, { state: "committed", text: command!.text });
          emit({ type: "wand_input_committed", questionId: command!.questionId,
            message: { id: command!.id, text: command!.text, boundaryId: config.requestId, incarnationId: config.requestId } });
        };
        if (question) {
          const lines = question.params.questions.length === 1 ? [command.text.trim()] : command.text.trim().split("\n");
          if (lines.length !== question.params.questions.length) throw Object.assign(new Error("请逐题回答，每题一行。"), { definiteRejection: true });
          const answers = Object.fromEntries(question.params.questions.map((q: any, index: number) => [q.id, { answers: [lines[index]] }]));
          const resolved = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { resolutions.delete(String(question.rpcId)); reject(new Error("Codex 回答确认超时。")); }, 30_000);
            resolutions.set(String(question.rpcId), () => { clearTimeout(timer); commit(); resolve(); });
          });
          wire({ id: question.rpcId, result: { answers } });
          await resolved;
          questions.delete(command.questionId!);
        } else {
          await request("turn/steer", { threadId, expectedTurnId: turnId, clientUserMessageId: command.id,
            input: userInput(command.text, command.images) }, commit);
        }
        socket.end(JSON.stringify({ ok: true }) + "\n");
      } catch (error) {
        const rejected = !claimed || (error as any).definiteRejection === true;
        if (command && /^[a-f0-9-]{36}$/i.test(command.id) && rejected) receipt(command.id, { state: "rejected" });
        socket.end(JSON.stringify({ ok: false, rejected, error: (error as Error).message }) + "\n");
      } finally { controls--; close(); }
    })();
  });
});
server.on("error", fail);
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path.join(directory, "control.sock"), resolve); });
chmodSync(path.join(directory, "control.sock"), 0o600);

const applyLine = (line: string): void => {
  try {
    const event = JSON.parse(line);
    if (event.id !== undefined && !event.method) {
      const pending = requests.get(event.id);
      if (pending) {
        requests.delete(event.id); clearTimeout(pending.timer);
        if (event.error) pending.reject(codexRpcError(pending.method, event.error, config.threadId));
        else { pending.accepted?.(); pending.resolve(event.result); }
      }
      return;
    }
    const params = event.params ?? {};
    if (event.id !== undefined && event.method) {
      if (event.method === "item/tool/requestUserInput" || event.method === "tool/requestUserInput") {
        if (params.threadId !== threadId || !Array.isArray(params.questions) || params.questions.some((q: any) => q.isSecret)) {
          wire({ id: event.id, error: { code: -32602, message: "Unsupported Codex question scope or secret input" } });
          return;
        }
        const id = `codex-question:${config.requestId}:${event.id}`;
        questions.set(id, { rpcId: event.id, params });
        emit({ type: "wand_codex_question", id, questions: params.questions });
      } else {
        // Do not widen filesystem/network/tool approvals while adapting protocols.
        wire({ id: event.id, error: { code: -32601, message: `Wand does not support ${event.method}` } });
      }
      return;
    }
    if (params.threadId && threadId && params.threadId !== threadId) return;
    if (event.method === "serverRequest/resolved") {
      resolutions.get(String(params.requestId))?.();
      resolutions.delete(String(params.requestId));
      for (const [id, question] of questions) {
        if (String(question.rpcId) === String(params.requestId)) {
          questions.delete(id);
          emit({ type: "wand_codex_question_resolved", id });
        }
      }
    }
    if (event.method === "turn/started") {
      turnId = params.turn?.id ?? turnId;
      if (startup) clearTimeout(startup);
      emit({ type: "wand_input_ready", id: config.inputMessageId });
      emit({ type: "wand_input_boundary", id: config.requestId });
    }
    emit({ type: "wand_codex_event", event });
    if (event.method === "turn/completed" && params.turn?.id === turnId) {
      finished = true;
      failed = params.turn.status === "failed";
      close();
    }
  } catch (error) { fail(error as Error); }
};
const decoder = createUtf8TextDecoder();
let carry = "";
child.stdout.on("data", chunk => {
  carry += decoder.write(chunk);
  let end: number;
  while ((end = carry.indexOf("\n")) >= 0) {
    const line = carry.slice(0, end); carry = carry.slice(end + 1);
    if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) { fail(new Error("Codex protocol line exceeds limit")); return; }
    if (line.trim()) applyLine(line);
  }
  if (Buffer.byteLength(carry) > MAX_PROTOCOL_LINE_BYTES) { carry = ""; fail(new Error("Codex protocol line exceeds limit")); }
});
child.stdout.on("end", () => {
  if (carry.trim()) fail(new Error("Codex app-server protocol ended with an incomplete message"));
});

try {
  startup = setTimeout(() => fail(new Error("Codex App Server startup timed out")), 60_000);
  await request("initialize", { clientInfo: { name: "wand", version: "1.0.0" }, capabilities: { experimentalApi: true } });
  wire({ method: "initialized" });
  const settings = { cwd: config.cwd, model: config.model, approvalPolicy: "never", sandbox: config.sandbox,
    developerInstructions: config.developerInstructions };
  const thread = await request(config.threadId ? "thread/resume" : "thread/start",
    // Wand already owns the displayed transcript; resuming only needs metadata and live state.
    { ...settings, ...(config.threadId ? { threadId: config.threadId, excludeTurns: true } : {}) });
  threadId = thread.thread.id;
  emit({ type: "thread.started", thread_id: threadId });
  if (!interrupted) {
    turnRequested = true;
    const started = await request("turn/start", { threadId, clientUserMessageId: config.inputMessageId,
      input: userInput(config.prompt, config.images), effort: config.effort });
    turnId = started.turn.id;
  }
} catch (error) { fail(error as Error); }

for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  if (interrupted) return;
  interrupted = true;
  if (turnId && !finished) void request("turn/interrupt", { threadId, turnId }).catch(fail);
  else { finished = true; close(); }
});
