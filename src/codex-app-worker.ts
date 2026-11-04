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
import { isTransportFailure } from "./structured-failure.js";
import { createCodexStderrReader } from "./codex-stderr.js";

export interface CodexAppLaunch {
  file: string; sessionId: string; requestId: string; inputMessageId: string;
  prompt: string; threadId: string | null; cwd: string; model?: string;
  developerInstructions?: string; effort?: string | null; sandbox: "danger-full-access" | "workspace-write" | "read-only";
  /** Wand 上传附件里的图片路径：走 Codex 原生 localImage 输入，而不是只发一行路径文本。 */
  images?: string[];
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let launch: CodexAppLaunch | undefined;
for await (const line of input) { launch = JSON.parse(line) as CodexAppLaunch; break; }
input.close();
if (!launch) throw new Error("Missing Codex bridge launch");
const config = launch;
const directory = codexControlDirectory(config.sessionId, config.requestId);
mkdirSync(directory, { mode: 0o700 });
const emit = (event: Record<string, unknown>): void => { process.stdout.write(JSON.stringify({ ...event, requestId: config.requestId }) + "\n"); };
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
let childExited = false;
let startup: ReturnType<typeof setTimeout> | undefined;
let interruptTimer: ReturnType<typeof setTimeout> | undefined;
const requests = new Map<number, { method: string; resolve(value: any): void; reject(error: Error): void; accepted?: (value: any) => void; timer: ReturnType<typeof setTimeout> }>();
const questions = new Map<string, { rpcId: string | number; params: any }>();
const resolutions = new Map<string, { complete(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
const seenInputs = new Set<string>();
const rpcKey = (id: string | number): string => `${typeof id}:${id}`;
const wire = (value: unknown): void => { child.stdin.write(JSON.stringify(value) + "\n"); };
/** Codex `UserInput`：正文文本 + 上传附件里的原生图片（localImage）。 */
const userInput = (text: string, images?: readonly string[]): unknown[] => [
  { type: "text", text, text_elements: [] },
  ...codexLocalImageInputs(images),
];
const request = (method: string, params: unknown, accepted?: (value: any) => void): Promise<any> => new Promise((resolve, reject) => {
  if (childExited || stopping) { reject(new Error("Codex app-server is no longer connected")); return; }
  const id = ++sequence;
  const timer = setTimeout(() => {
    requests.delete(id);
    reject(new Error(`Codex ${method} confirmation timed out`));
  }, 30_000);
  requests.set(id, { method, resolve, reject, accepted, timer });
  try { wire({ id, method, params }); }
  catch (error) { clearTimeout(timer); requests.delete(id); reject(error as Error); }
});
const close = (): void => {
  if (!finished || controls || stopping) return;
  stopping = true;
  if (startup) clearTimeout(startup);
  if (interruptTimer) clearTimeout(interruptTimer);
  server.close();
  rmSync(path.join(directory, "control.sock"), { force: true });
  if (childExited) return;
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  timer.unref();
};
const fail = (error: Error): void => {
  if (failed) return;
  if (!turnRequested || (!turnId && (error as { definiteRejection?: boolean }).definiteRejection)) emit({ type: "wand_codex_rejected",
    ...((error as { retryForbidden?: boolean }).retryForbidden ? { retryForbidden: true } : {}),
  });
  if (!failed && !finished) emit({ type: "turn.failed", error: { message: error.message } });
  failed = true;
  finished = true;
  for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
  requests.clear();
  for (const pending of resolutions.values()) { clearTimeout(pending.timer); pending.reject(error); }
  resolutions.clear();
  close();
};
child.once("error", fail);
child.stdin.on("error", fail);
const stderrDecoder = createUtf8TextDecoder();
const stderrReader = createCodexStderrReader(text => { process.stderr.write(text); });
child.stderr.on("data", chunk => stderrReader.push(stderrDecoder.write(chunk)));
child.once("close", (code) => {
  stderrReader.push(stderrDecoder.end());
  stderrReader.finish();
  childExited = true;
  if (startup) clearTimeout(startup);
  for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(new Error("Codex app-server exited")); }
  requests.clear();
  for (const pending of resolutions.values()) { clearTimeout(pending.timer); pending.reject(new Error("Codex app-server exited before answering was confirmed")); }
  resolutions.clear();
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
      let duplicate = false;
      controls++;
      try {
        command = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (!command || !/^[a-f0-9-]{36}$/i.test(command.id) || typeof command.text !== "string" || !command.text.trim()) throw new Error("Invalid Codex input");
        duplicate = seenInputs.has(command.id);
        if (duplicate) throw new Error("Codex 该输入已经交接，请核对原回执，勿重复提交。");
        if (finished || interrupted || !turnId || controls > 1) throw new Error("Codex 当前回合已结束或另一个输入正在交接。");
        if (command.images !== undefined && (!Array.isArray(command.images) || command.images.some(image => typeof image !== "string"))) throw new Error("Invalid Codex images");
        const question = command.questionId ? questions.get(command.questionId) : undefined;
        if (command.questionId && !question) throw new Error("该问题已经失效，请刷新会话。");
        if (!command.questionId && questions.size) throw new Error("请先回答当前 Codex 问题。");
        let answers: Record<string, { answers: string[] }> | undefined;
        if (question) {
          if (command.images?.length) throw new Error("Codex 问题回答不支持图片，请用文字逐题回答。");
          const lines = question.params.questions.length === 1 ? [command.text.trim()] : command.text.trim().split(/\r?\n/).map(line => line.trim());
          if (lines.length !== question.params.questions.length || lines.some(line => !line)) throw new Error("请逐题回答，每题一行且不能为空。");
          answers = Object.fromEntries(question.params.questions.map((q: any, index: number) => [q.id, { answers: [lines[index]] }]));
        }
        seenInputs.add(command.id);
        receipt(command.id, { state: "claimed" });
        claimed = true;
        const commit = (): void => {
          receipt(command!.id, { state: "committed", text: command!.text });
          emit({ type: "wand_input_committed", questionId: command!.questionId,
            message: { id: command!.id, text: command!.text, boundaryId: config.requestId, incarnationId: config.requestId } });
        };
        if (question) {
          const key = rpcKey(question.rpcId);
          const resolved = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { resolutions.delete(key); reject(new Error("Codex 回答确认超时，送达结果未知。")); }, 30_000);
            resolutions.set(key, { timer, reject, complete: () => { clearTimeout(timer); commit(); resolve(); } });
          });
          wire({ id: question.rpcId, result: { answers } });
          await resolved;
          questions.delete(command.questionId!);
        } else {
          const expectedTurnId = turnId;
          await request("turn/steer", { threadId, expectedTurnId, clientUserMessageId: command.id,
            input: userInput(command.text, command.images) }, result => {
            if (result?.turnId !== expectedTurnId) throw new Error("Codex 插话回执身份不匹配，送达结果未知。");
            commit();
          });
        }
        socket.end(JSON.stringify({ ok: true }) + "\n");
      } catch (error) {
        const rejected = !duplicate && (!claimed || (error as any).definiteRejection === true);
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
        if (event.error) {
          const error: Error & { definiteRejection?: boolean } = codexRpcError(pending.method, event.error, config.threadId);
          if ((pending.method === "turn/start" || pending.method === "turn/steer")
            && (isTransportFailure(error.message) || /\b5\d\d\b/.test(error.message)
              || event.error.code === -32603 || [408, 409].includes(event.error.code)
              || (event.error.code >= 500 && event.error.code <= 599))) delete error.definiteRejection;
          pending.reject(error);
        } else {
          try { pending.accepted?.(event.result); pending.resolve(event.result); }
          catch (error) { pending.reject(error as Error); }
        }
      }
      return;
    }
    const params = event.params ?? {};
    if (event.id !== undefined && event.method) {
      if (typeof event.id !== "string" && (typeof event.id !== "number" || !Number.isFinite(event.id))) {
        fail(new Error("Codex server request identity is invalid"));
        return;
      }
      if (event.method === "item/tool/requestUserInput" || event.method === "tool/requestUserInput") {
        const validQuestions = Array.isArray(params.questions) && params.questions.length > 0 && params.questions.length <= 3
          && params.questions.every((q: any) => q && typeof q.id === "string" && q.id.trim()
            && typeof q.header === "string" && typeof q.question === "string" && q.question.trim()
            && q.isSecret === false && (q.options === null || q.options === undefined || (Array.isArray(q.options)
              && q.options.every((option: any) => option && typeof option.label === "string" && typeof option.description === "string"))))
          && new Set(params.questions.map((q: any) => q.id)).size === params.questions.length;
        if (finished || interrupted || !turnId || params.threadId !== threadId || params.turnId !== turnId
          || typeof params.itemId !== "string" || !params.itemId || !validQuestions
          || params.isBlocking !== true || (params.autoResolutionMs !== undefined && params.autoResolutionMs !== null)) {
          // resolved has no outcome: auto-resolution cannot acknowledge that our answer was used.
          wire({ id: event.id, error: { code: -32602, message: "Unsupported Codex question scope, secret input, or automatic resolution" } });
          return;
        }
        const id = `codex-question:${config.requestId}:${rpcKey(event.id)}`;
        if (questions.has(id)) return;
        questions.set(id, { rpcId: event.id, params });
        emit({ type: "wand_codex_question", id, questions: params.questions });
      } else {
        // Do not widen filesystem/network/tool approvals while adapting protocols.
        wire({ id: event.id, error: { code: -32601, message: `Wand does not support ${event.method}` } });
      }
      return;
    }
    if (params.threadId && (!threadId || params.threadId !== threadId)) return;
    if (params.turnId && params.turnId !== turnId) return;
    if (event.method === "turn/completed" && (!turnId || params.turn?.id !== turnId)) return;
    if (event.method === "serverRequest/resolved") {
      if (params.threadId !== threadId || (typeof params.requestId !== "string" && typeof params.requestId !== "number")) return;
      const key = rpcKey(params.requestId);
      // Commit first: the manager still needs the pending question to pair tool_result.
      const resolution = resolutions.get(key);
      if (resolution && (interrupted || finished)) {
        clearTimeout(resolution.timer);
        resolution.reject(new Error("Codex 回答期间回合已中断，送达结果未知。"));
      } else resolution?.complete();
      resolutions.delete(key);
      for (const [id, question] of questions) {
        if (rpcKey(question.rpcId) === key) {
          questions.delete(id);
          emit({ type: "wand_codex_question_resolved", id });
        }
      }
    }
    if (event.method === "turn/started") {
      if (!turnRequested || typeof params.turn?.id !== "string" || !params.turn.id
        || (turnId && params.turn.id !== turnId)) return;
      turnId = params.turn.id;
      if (startup) clearTimeout(startup);
      emit({ type: "wand_input_ready", id: config.inputMessageId });
      emit({ type: "wand_input_boundary", id: config.requestId });
    }
    emit({ type: "wand_codex_event", event });
    if (event.method === "turn/completed" && params.turn?.id === turnId) {
      finished = true;
      failed = params.turn.status !== "completed";
      for (const [id] of questions) emit({ type: "wand_codex_question_resolved", id });
      questions.clear();
      for (const pending of resolutions.values()) { clearTimeout(pending.timer); pending.reject(new Error("Codex 回合已结束，回答送达未确认。")); }
      resolutions.clear();
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
  carry += decoder.end();
  if (carry.trim()) {
    if (Buffer.byteLength(carry) > MAX_PROTOCOL_LINE_BYTES) fail(new Error("Codex protocol line exceeds limit"));
    else applyLine(carry);
    carry = "";
  }
  if (!finished) fail(new Error("Codex app-server protocol ended before turn completion"));
});

const interruptTurn = (): void => {
  if (turnId && !finished) void request("turn/interrupt", { threadId, turnId }).catch(fail);
};
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  if (interrupted || finished) return;
  interrupted = true;
  // Install before initialize: cancellation during startup must never launch a later turn.
  if (!turnRequested) { finished = true; close(); }
  else {
    interruptTimer = setTimeout(() => fail(new Error("Codex 回合中断确认超时。")), 30_000);
    interruptTurn();
  }
});

try {
  startup = setTimeout(() => fail(new Error("Codex App Server startup timed out")), 60_000);
  await request("initialize", { clientInfo: { name: "wand", version: "1.0.0" }, capabilities: { experimentalApi: true } });
  if (interrupted || finished) throw new Error("Codex 启动已取消。");
  wire({ method: "initialized" });
  const settings = { cwd: config.cwd, model: config.model, approvalPolicy: "never", sandbox: config.sandbox,
    developerInstructions: config.developerInstructions };
  const thread = await request(config.threadId ? "thread/resume" : "thread/start",
    // Wand already owns the displayed transcript; resuming only needs metadata and live state.
    { ...settings, ...(config.threadId ? { threadId: config.threadId, excludeTurns: true } : { allowProviderModelFallback: false }) });
  if (typeof thread?.thread?.id !== "string" || !thread.thread.id
    || (config.threadId && config.threadId !== thread.thread.id)) throw new Error("Codex thread response identity mismatch");
  threadId = thread.thread.id;
  emit({ type: "thread.started", thread_id: threadId });
  if (!interrupted && !finished) {
    turnRequested = true;
    await request("turn/start", { threadId, clientUserMessageId: config.inputMessageId,
      input: userInput(config.prompt, config.images), effort: config.effort }, started => {
      if (typeof started?.turn?.id !== "string" || !started.turn.id
        || (turnId && turnId !== started.turn.id)) throw new Error("Codex turn response identity mismatch; input delivery unknown");
      turnId = started.turn.id;
      emit({ type: "wand_codex_accepted" });
      if (interrupted) interruptTurn();
    });
  }
} catch (error) { fail(error as Error); }
