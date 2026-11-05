/**
 * Qoder ACP 执行工作进程。
 *
 * 由持久化宿主（terminald / wand-structured-renderd 或进程内宿主）托管。
 * 持久化宿主下，此工作进程与 Qoder ACP stdio 跨 Web 服务重启存活；进程内宿主不提供该保证。
 * 通过 stdin 读取单次启动配置，通过 stdout 向上抛出 NDJSON 事件，通过 control.sock 接收权限裁决、结构化回答与插话指令。
 */
import { existsSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { shellQuote } from "./shell-quote.js";
import { QoderBackgroundTasks } from "./qoder-background.js";

import { MAX_PROTOCOL_LINE_BYTES } from "./bounded-process-output.js";
import { qoderControlDirectory, type QoderControlCommand } from "./qoder-acp-control.js";
import { createUtf8TextDecoder } from "./structured-exec-host.js";
import { buildAcpPromptBlocks, type AcpConfigOption, type AcpPromptContent } from "./structured-qoder-acp-adapter.js";
import type { StructuredPermissionDecision } from "./structured-runner.js";

export interface QoderAcpWorkerConfig {
  file: string;
  sessionId: string;
  requestId: string;
  inputMessageId?: string;
  claudeSessionId?: string | null;
  prompt: string;
  cwd: string;
  systemPrompt?: string;
  model?: string;
  thinkingEffort?: string | null;
  mode: string;
  autoApprovePermissions?: boolean;
  /** Capability discovery never sends session/prompt. */
  catalogOnly?: boolean;
  /** Keep the native session and its notifications alive across prompt turns. */
  resident?: boolean;
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let launch: QoderAcpWorkerConfig | undefined;
for await (const line of input) {
  if (line.trim()) {
    launch = JSON.parse(line.trim()) as QoderAcpWorkerConfig;
    break;
  }
}
input.close();

if (!launch) {
  throw new Error("Missing Qoder ACP worker launch config");
}
const config = launch;

const directory = qoderControlDirectory(config.sessionId, config.requestId);
mkdirSync(directory, { mode: 0o700, recursive: true });

const emit = (event: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const receipt = (id: string, value: unknown): void => {
  const file = path.join(directory, `${id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};

const helperJs = fileURLToPath(new URL("./qoder-background-helper.js", import.meta.url));
const helperArgs = existsSync(helperJs) ? [helperJs] : ["--import", import.meta.resolve("tsx"), helperJs.replace(/\.js$/, ".ts")];
const shellPrefix = path.join(directory, "shell-prefix");
writeFileSync(shellPrefix, "#!/bin/sh\nexec " + [process.execPath, ...helperArgs, "shell"].map(shellQuote).join(" ") + ' "$@"\n', { mode: 0o700 });
const hookSettings = { hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: process.execPath, args: [...helperArgs, "hook"], timeout: 86400 }] }] } };
const childEnv = { ...process.env,
  WAND_QODER_BACKGROUND_SOCKET: path.join(directory, "control.sock"),
  WAND_QODER_ORIGINAL_SHELL_PREFIX: process.env.QODERCN_SHELL_PREFIX || process.env.QODER_SHELL_PREFIX || process.env.CLAUDE_CODE_SHELL_PREFIX || "",
  QODER_SHELL_PREFIX: shellPrefix, QODERCN_SHELL_PREFIX: shellPrefix, CLAUDE_CODE_SHELL_PREFIX: shellPrefix,
};
const child = spawn(config.file, ["--acp", "--settings", JSON.stringify(hookSettings), ...(config.systemPrompt ? ["--append-system-prompt", config.systemPrompt] : [])], {
  cwd: config.cwd,
  env: childEnv,
  stdio: ["pipe", "pipe", "pipe"],
});

let sequence = 0;
let nativeSessionId = config.claudeSessionId ?? "";
let finished = false;
let interrupted = false;
let stopping = false;
let failed = false;
let controlsInFlight = 0;
let cancelTimer: ReturnType<typeof setTimeout> | null = null;
let promptRpcId: number | null = null;
let idle = false;
let approveThisTurn = false;
const backgroundTasks = new QoderBackgroundTasks();
const backgroundToolCalls = new Set<string>();
let applyNextConfig: ((selection: NonNullable<Extract<QoderControlCommand, { type: "steer" }>["config"]>) => Promise<void>) | undefined;
const steeringPromptIds = new Set<number>();
let imagesSupported = false;
let steeringSupported = false;

const requests = new Map<number, {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}>();

interface PendingPermission {
  rpcId: number | string;
  options: Array<Record<string, unknown>>;
  toolCall: unknown;
}
const pendingPermissions = new Map<string, PendingPermission>();
const resolvedPermissions = new Map<string, StructuredPermissionDecision>();
const emitNextPermission = (): void => {
  const next = pendingPermissions.entries().next().value;
  if (next) emit({ type: "wand_qoder_permission", id: next[0], toolCall: next[1].toolCall, options: next[1].options });
};

interface PendingElicitation {
  rpcId: number | string;
  properties: Record<string, any>;
  propertyKeys: string[];
}
const pendingElicitations = new Map<string, PendingElicitation>();

const wire = (value: unknown): void => {
  try {
    child.stdin.write(`${JSON.stringify(value)}\n`);
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
  }
};

const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => {
    requests.delete(id);
    reject(new Error(`Qoder ACP ${method} 请求超时`));
  }, 45_000);
  timer.unref?.();
  requests.set(id, { method, resolve, reject, timer });
  wire({ jsonrpc: "2.0", id, method, params });
});

const close = (): void => {
  if (controlsInFlight || stopping) return;
  stopping = true;
  if (cancelTimer) {
    clearTimeout(cancelTimer);
    cancelTimer = null;
  }
  try { server.close(); } catch { /* ignore */ }
  rmSync(path.join(directory, "control.sock"), { force: true });
  try { child.stdin.end(); } catch { /* ignore */ }
  try { child.kill("SIGTERM"); } catch { /* ignore */ }
  const forceKillTimer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }, 3000);
  forceKillTimer.unref?.();
};

const fail = (error: Error): void => {
  if (!failed && !finished) {
    emit({ jsonrpc: "2.0", id: 0, error: { code: -32603, message: error.message } });
  }
  backgroundTasks.cancel();
  failed = true;
  finished = true;
  close();
};

child.once("error", fail);
child.stdin.on("error", fail);
child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
child.once("close", (code) => {
  for (const pending of requests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(`Qoder CLI ACP 退出 (${code ?? "null"})`));
  }
  requests.clear();
  if (!finished) {
    fail(new Error(`Qoder CLI ACP 在回合完成前退出 (${code ?? "null"})`));
  }
  process.exitCode = failed ? 1 : 0;
});

function pickOptionId(options: Array<Record<string, unknown>>, decision: StructuredPermissionDecision): string | null {
  // A host turn approval must never install a persistent native allow rule.
  const kind = decision === "deny" ? "reject_once" : "allow_once";
  const match = options.find(option => option.kind === kind);
  return match && typeof match.optionId === "string" ? match.optionId : null;
}

const server = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.setTimeout(25_000, () => socket.destroy());
  let buffer = "";
  let received = false;
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    if (received) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 64 * 1024) { socket.destroy(); return; }
    if (!buffer.includes("\n")) return;
    received = true;
    controlsInFlight++;
    void (async () => {
      try {
        const command = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as QoderControlCommand;
        if (command.type === "background") {
          if (finished || interrupted || stopping) { socket.end(JSON.stringify({ ok: false, cancelled: true }) + "\n"); return; }
          if (command.event.kind === "task") {
            socket.setTimeout(0);
            if (typeof command.event.toolCallId !== "string" || !backgroundToolCalls.has(command.event.toolCallId)) {
              throw new Error("后台工具调用不属于当前 ACP 执行。");
            }
            const completion = await backgroundTasks.waitForTask(command.event, nativeSessionId);
            if (!completion.cancelled) emit({ type: "wand_qoder_background_completed", tasks: [completion] });
            socket.end(JSON.stringify({ ok: true, completion }) + "\n");
          } else socket.end(JSON.stringify({ ok: backgroundTasks.accept(command.event, nativeSessionId) }) + "\n");
          return;
        }

        // 1. 权限裁决
        if (command.type === "permission_resolution") {
          const previous = resolvedPermissions.get(command.escalationId);
          if (previous) {
            if (previous !== command.resolution) throw Object.assign(new Error("该授权已有不同的裁决。"), { rejected: true });
            emit({ type: "wand_qoder_permission_resolved", id: command.escalationId, resolution: previous });
            socket.end(`${JSON.stringify({ ok: true })}\n`);
            return;
          }
          const pending = pendingPermissions.get(command.escalationId);
          if (!pending) throw Object.assign(new Error("授权请求已失效或已处理。"), { rejected: true });
          const optionId = pickOptionId(pending.options, command.resolution);
          if (optionId && command.resolution === "approve_turn") approveThisTurn = true;
          wire({
            jsonrpc: "2.0",
            id: pending.rpcId,
            result: optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } },
          });
          pendingPermissions.delete(command.escalationId);
          resolvedPermissions.set(command.escalationId, command.resolution);
          emit({ type: "wand_qoder_permission_resolved", id: command.escalationId, resolution: command.resolution });
          emitNextPermission();
          socket.end(`${JSON.stringify({ ok: true })}\n`);
          return;
        }

        // 2. 结构化询问回答
        if (command.type === "question_answer") {
          if (!/^[a-f0-9-]{36}$/i.test(command.id)) throw Object.assign(new Error("回答交接标识无效。"), { rejected: true });
          const pending = pendingElicitations.get(command.toolUseId);
          if (!pending) throw Object.assign(new Error("问题已失效或已被回答。"), { rejected: true });
          receipt(command.id, { state: "pending", text: command.text });
          const lines = command.text.trim().split("\n").map(line => line.trim());
          if (lines.length !== pending.propertyKeys.length) {
            throw Object.assign(new Error("回答数量与当前表单不一致。"), { rejected: true });
          }
          const content: Record<string, any> = {};
          pending.propertyKeys.forEach((key, idx) => {
            const prop = pending.properties[key] ?? {};
            const answerLine = lines[idx] ?? "";
            if (prop.type === "array") {
              // React cards join choices with ；; native/legacy cards use commas.
              content[key] = answerLine.split(/[,，;；]/).map(value => value.trim()).filter(Boolean);
            } else if (prop.type === "boolean") {
              if (!/^(true|false|yes|no|是|否|1|0)$/i.test(answerLine)) throw Object.assign(new Error("布尔回答无效。"), { rejected: true });
              content[key] = /^(true|yes|是|1)$/i.test(answerLine);
            } else if (prop.type === "integer" || prop.type === "number") {
              const num = Number(answerLine);
              if (!answerLine || !Number.isFinite(num) || prop.type === "integer" && !Number.isInteger(num)) {
                throw Object.assign(new Error("数字回答无效。"), { rejected: true });
              }
              content[key] = num;
            } else {
              content[key] = answerLine;
            }
          });
          wire({
            jsonrpc: "2.0",
            id: pending.rpcId,
            result: { action: "accept", content },
          });
          pendingElicitations.delete(command.toolUseId);
          receipt(command.id, { state: "committed", text: command.text });
          emit({ type: "wand_input_committed", questionId: command.toolUseId,
            message: { id: command.id, text: command.text, boundaryId: command.toolUseId, incarnationId: config.requestId } });
          emit({ type: "wand_qoder_question_resolved", id: command.toolUseId });
          socket.end(`${JSON.stringify({ ok: true })}\n`);
          return;
        }

        // 3. 运行中实时插话
        if (command.type === "steer") {
          if (!/^[a-f0-9-]{36}$/i.test(command.id)) throw Object.assign(new Error("插话交接标识无效。"), { rejected: true });
          // A repeated control request must not duplicate a provider prompt.
          let previous: { state?: string; text?: string } | undefined;
          try {
            previous = JSON.parse(readFileSync(path.join(directory, `${command.id}.json`), "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Qoder 插话记录不可读，送达未知，不重复发送。");
          }
          if (previous) {
            if (previous.state === "committed" && previous.text === command.text) {
              socket.end(`${JSON.stringify({ ok: true })}\n`);
              return;
            }
            throw new Error("Qoder 插话已有未确认记录，不自动重复发送。");
          }
          if (finished || interrupted || !nativeSessionId || (!idle && (!promptRpcId || !steeringSupported))) {
            throw Object.assign(new Error("Qoder 当前回合不接受插话，消息已保留至下次回合。"), { rejected: true });
          }
          if (idle && command.config) {
            try { await applyNextConfig?.(command.config); }
            catch (error) { throw Object.assign(error as Error, { rejected: true }); }
          }
          receipt(command.id, { state: "pending", text: command.text });
          const steerBlocks = buildAcpPromptBlocks(command.text, imagesSupported);
          const steeringId = ++sequence;
          if (idle) {
            idle = false;
            promptRpcId = steeringId;
            steeringPromptIds.clear();
            emit({ type: "wand_qoder_phase", phase: "responding", foregroundRequestId: command.id, at: new Date().toISOString() });
          } else steeringPromptIds.add(steeringId);
          await new Promise<void>((resolve, reject) => {
            child.stdin.write(`${JSON.stringify({
              jsonrpc: "2.0",
              id: steeringId,
              method: "session/prompt",
              params: { sessionId: nativeSessionId, prompt: steerBlocks },
            })}\n`, (error) => error ? reject(error) : resolve());
          });
          // Durable submission to the provider channel, NOT a model-consumption ack.
          // A failed write leaves a pending (unknown) receipt and is never replayed.
          receipt(command.id, { state: "committed", text: command.text });
          emit({
            type: "wand_input_committed",
            message: { id: command.id, text: command.text, boundaryId: config.requestId, incarnationId: config.requestId },
          });
          socket.end(`${JSON.stringify({ ok: true })}\n`);
          return;
        }

        // 4. 中断
        if (command.type === "interrupt") {
          triggerCancel();
          socket.end(`${JSON.stringify({ ok: true })}\n`);
          return;
        }

        throw new Error("未知的 Qoder 控制命令。");
      } catch (error) {
        const rejected = (error as any).rejected === true;
        emit({ type: "wand_qoder_control_error", message: (error as Error).message });
        socket.end(`${JSON.stringify({ ok: false, rejected, error: (error as Error).message })}\n`);
      } finally {
        controlsInFlight--;
        if (finished) close();
      }
    })();
  });
});
server.on("error", fail);

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(path.join(directory, "control.sock"), resolve);
});
chmodSync(path.join(directory, "control.sock"), 0o600);

function triggerCancel(): void {
  backgroundTasks.cancel();
  if (interrupted) return;
  interrupted = true;
  for (const [id, pending] of pendingPermissions.entries()) {
    wire({ jsonrpc: "2.0", id: pending.rpcId, result: { outcome: { outcome: "cancelled" } } });
    emit({ type: "wand_qoder_permission_resolved", id, resolution: "deny" });
  }
  pendingPermissions.clear();
  for (const [id, pending] of pendingElicitations.entries()) {
    wire({ jsonrpc: "2.0", id: pending.rpcId, result: { action: "cancel" } });
    emit({ type: "wand_qoder_question_resolved", id });
  }
  pendingElicitations.clear();
  if (idle) { finished = true; close(); return; }
  if (nativeSessionId) {
    wire({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: nativeSessionId } });
  }
  cancelTimer = setTimeout(() => {
    finished = true;
    close();
  }, 5000);
  cancelTimer.unref?.();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => triggerCancel());
}

const applyLine = (line: string): void => {
  try {
    const frame = JSON.parse(line) as Record<string, unknown>;
    const id = typeof frame.id === "number" || typeof frame.id === "string" ? frame.id : null;

    if (id !== null && !frame.method) {
      const pending = typeof id === "number" ? requests.get(id) : undefined;
      if (pending) {
        requests.delete(id as number);
        clearTimeout(pending.timer);
        if (frame.error) {
          const rec = frame.error as Record<string, unknown>;
          pending.reject(Object.assign(new Error(String(rec.message ?? "Qoder ACP error")), { code: rec.code, data: rec.data }));
        } else {
          pending.resolve(frame.result);
        }
      }
      const steeringResult = typeof id === "number" && steeringPromptIds.delete(id);
      if (id === promptRpcId || steeringResult) {
        emit(frame);
        if (frame.error) failed = true;
        // Qoder promptQueueing coalesces inputs into the primary turn and may
        // never respond separately to steering IDs. Its primary result owns turn
        // completion; missing steering replies are not a reason to hang or replay.
        if (id === promptRpcId) {
          if (config.resident && !frame.error && !interrupted) {
            idle = true;
            approveThisTurn = false;
            promptRpcId = null;
            steeringPromptIds.clear();
            emit({ type: "wand_qoder_phase", phase: "idle", pendingBackgroundTasks: backgroundTasks.pending, at: new Date().toISOString() });
            emit({ type: "wand_input_boundary", id: config.requestId });
          } else {
            finished = true;
            close();
          }
        }
      }
      return;
    }

    if (id !== null && typeof frame.method === "string") {
      // 权限请求
      if (frame.method === "session/request_permission") {
        const params = (frame.params && typeof frame.params === "object" ? frame.params : {}) as Record<string, unknown>;
        const options = Array.isArray(params.options) ? params.options as Array<Record<string, unknown>> : [];
        if (config.autoApprovePermissions === true || config.mode === "yolo" || approveThisTurn) {
          const allowOption = options.find((opt) => opt.kind === "allow_once");
          const optionId = allowOption ? String(allowOption.optionId ?? "") : null;
          wire({
            jsonrpc: "2.0",
            id,
            result: optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } },
          });
          return;
        }
        const escalationId = randomUUID();
        pendingPermissions.set(escalationId, { rpcId: id, options, toolCall: params.toolCall });
        if (pendingPermissions.size === 1) emitNextPermission();
        return;
      }

      // 结构化表单询问 (AskUserQuestion elicitation)
      if (frame.method === "elicitation/create" || frame.method === "unstable_createElicitation") {
        const params = (frame.params && typeof frame.params === "object" ? frame.params : {}) as Record<string, unknown>;
        const schema = (params.requestedSchema ?? {}) as Record<string, any>;
        const properties = (schema.properties ?? {}) as Record<string, any>;
        const propertyKeys = Object.keys(properties);
        const questions = propertyKeys.map((key) => {
          const prop = properties[key] ?? {};
          const rawTitle = String(prop.title ?? key);
          const rawDesc = String(prop.description ?? "");
          const isMulti = prop.type === "array";
          let options: Array<{ label: string; description?: string }> = [];
          if (prop.type === "string") {
            const rawOpts = prop.oneOf ?? prop.enum ?? [];
            options = rawOpts.map((opt: any, index: number) => {
              const val = String(opt?.const ?? opt?.title ?? opt?.value ?? opt ?? `选项 ${index + 1}`);
              const desc = opt?.title && opt.title !== opt.const ? String(opt.title) : undefined;
              return { label: val, ...(desc ? { description: desc } : {}) };
            });
          } else if (isMulti) {
            const items = prop.items ?? {};
            const rawOpts = items.anyOf ?? items.enum ?? [];
            options = rawOpts.map((opt: any, index: number) => {
              const val = String(opt?.const ?? opt?.title ?? opt?.value ?? opt ?? `选项 ${index + 1}`);
              return { label: val };
            });
          } else if (prop.type === "boolean") {
            options = [{ label: "是" }, { label: "否" }];
          }
          if (options.length === 0) {
            options = [{ label: "确认" }];
          }
          const firstLine = rawDesc.split("\n")[0]?.trim();
          const questionText = firstLine || rawTitle;
          return {
            question: questionText,
            header: rawTitle !== questionText ? rawTitle : undefined,
            multiSelect: isMulti,
            options,
          };
        });

        const toolUseId = String(params.toolCallId || `qoder-question-${randomUUID()}`);
        pendingElicitations.set(toolUseId, { rpcId: id, properties, propertyKeys });
        emit({
          type: "wand_qoder_question",
          id: toolUseId,
          questions,
          toolCallId: params.toolCallId,
        });
        return;
      }

      wire({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported method ${frame.method}` } });
      return;
    }

    if (typeof frame.method === "string") {
      if (frame.method === "session/update") {
        const params = frame.params as { sessionId?: string; update?: { sessionUpdate?: string; status?: string; toolCallId?: string; _meta?: { qoder?: { toolName?: string } } } } | undefined;
        if (params?.sessionId && params.sessionId !== nativeSessionId) return;
        if (params?.update?.sessionUpdate === "tool_call" && params.update._meta?.qoder?.toolName === "Bash"
          && typeof params.update.toolCallId === "string") backgroundToolCalls.add(params.update.toolCallId);
        // Unsolicited output is live work, not proof of background completion.
        if (idle && ["agent_message_chunk", "agent_thought_chunk", "tool_call"].includes(params?.update?.sessionUpdate ?? "")) {
          idle = false;
          emit({ type: "wand_qoder_phase", phase: "responding", at: new Date().toISOString() });
        }
        emit(frame);
        if (params?.update?.toolCallId && ["completed", "failed"].includes(params.update.status ?? "")) backgroundToolCalls.delete(params.update.toolCallId);
      }
    }
  } catch (error) {
    fail(error as Error);
  }
};

const decoder = createUtf8TextDecoder();
let carry = "";
child.stdout.on("data", (chunk: Buffer) => {
  carry += decoder.write(chunk);
  let end: number;
  while ((end = carry.indexOf("\n")) >= 0) {
    const line = carry.slice(0, end);
    carry = carry.slice(end + 1);
    if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) {
      fail(new Error("Qoder ACP protocol line exceeds limit"));
      return;
    }
    if (line.trim()) applyLine(line.trim());
  }
  if (Buffer.byteLength(carry) > MAX_PROTOCOL_LINE_BYTES) {
    carry = "";
    fail(new Error("Qoder ACP protocol line exceeds limit"));
  }
});
child.stdout.on("end", () => {
  if (carry.trim()) applyLine(carry.trim());
});

try {
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      // Qoder retains its native file tools; this host does not implement fs RPCs.
      fs: { readTextFile: false, writeTextFile: false },
      elicitation: { form: {} },
    },
    clientInfo: { name: "wand", version: "1.0.0" },
  });
  if (init?.protocolVersion !== 1) {
    throw new Error(`Qoder ACP 协议版本不匹配（agent=${String(init?.protocolVersion)}，Wand=1）`);
  }
  const promptCapabilities = init?.agentCapabilities?.promptCapabilities;
  imagesSupported = Boolean(promptCapabilities?.image);
  steeringSupported = init?.agentCapabilities?._meta?.qoder?.promptQueueing === true;

  let sessionInfo: Record<string, unknown> | undefined;
  if (config.claudeSessionId?.trim()) {
    try {
      sessionInfo = await request("session/resume", {
        sessionId: config.claudeSessionId.trim(),
        cwd: config.cwd,
        mcpServers: [],
      });
      nativeSessionId = config.claudeSessionId.trim();
    } catch (error: any) {
      if (error?.data?.code !== "INVALID_SESSION_IDENTIFIER") throw error;
    }
  }

  if (!sessionInfo) {
    sessionInfo = await request("session/new", {
      cwd: config.cwd,
      mcpServers: [],
    });
    nativeSessionId = String(sessionInfo?.sessionId ?? "");
    if (!nativeSessionId) throw new Error("Qoder ACP 没有返回会话 ID");
  }

  emit({ type: "wand_qoder_session", sessionId: nativeSessionId });

  let configOptions = Array.isArray(sessionInfo?.configOptions)
    ? (sessionInfo.configOptions as AcpConfigOption[])
    : [];

  const setConfig = async (configId: string, selected: string): Promise<void> => {
    const option = configOptions.find(o => o.id === configId);
    const match = option?.options?.find(opt => opt.value === selected || opt.name === selected
      || String(opt.name ?? "").replace(/\s*\(default\)$/i, "").trim() === selected);
    if (!match || typeof match.value !== "string") {
      throw new Error(`Qoder ACP 不支持所选 ${configId}：${selected}。请重新选择，不会使用其他配置执行。`);
    }
    const result = await request("session/set_config_option", { sessionId: nativeSessionId, configId, value: match.value });
    if (!Array.isArray(result?.configOptions)) throw new Error(`Qoder ACP 未确认 ${configId} 设置。`);
    configOptions = result.configOptions;
    if (configOptions.find(o => o.id === configId)?.currentValue !== match.value) {
      throw new Error(`Qoder ACP ${configId} 设置未生效。`);
    }
  };

  const applyEffort = async (requested: string | null | undefined): Promise<void> => {
    const option = configOptions.find(option => option.id === "reasoning_effort");
    const values = (option?.options ?? []).flatMap(value => typeof value.value === "string" ? [value.value] : []);
    // Unsupported preferences use the provider-confirmed current/default value.
    // No reasoning option means no override, rather than a fabricated native level.
    const selected = requested && requested !== "auto" && values.includes(requested) ? requested
      : typeof option?.currentValue === "string" && values.includes(option.currentValue) ? option.currentValue : values[0];
    if (selected && selected !== option?.currentValue) await setConfig("reasoning_effort", selected);
    emit({ type: "wand_qoder_effort", requested: requested ?? null, effort: selected ?? null });
  };

  const defaultModel = configOptions.find(option => option.id === "model")?.currentValue;
  applyNextConfig = async (selection) => {
    await setConfig("mode", selection.mode);
    const model = selection.model && selection.model !== "default" ? selection.model : defaultModel;
    if (typeof model === "string") await setConfig("model", model);
    await applyEffort(selection.thinkingEffort);
    config.mode = selection.mode;
    config.autoApprovePermissions = selection.autoApprovePermissions;
    emit({ method: "session/update", params: { sessionId: nativeSessionId,
      update: { sessionUpdate: "config_option_update", configOptions } } });
  };

  if (config.catalogOnly) {
    const options = configOptions.find(o => o.id === "model");
    const models = [];
    const defaultModel = options?.currentValue;
    for (const option of options?.options ?? []) {
      if (typeof option.value !== "string") continue;
      await setConfig("model", option.value);
      const efforts = (configOptions.find(o => o.id === "reasoning_effort")?.options ?? [])
        .filter(o => typeof o.value === "string").map(o => ({ effort: o.value, description: o.name }));
      models.push({ id: option.value, label: String(option.name ?? option.value).replace(/\s*\(default\)$/i, ""),
        // Existing clients interpret an empty list as unknown and show legacy levels.
        // `auto` is Wand's explicit no-override choice, never a fabricated native level.
        reasoningEfforts: efforts.length ? efforts : [{ effort: "auto", description: "使用模型默认；此模型未提供推理强度设置" }] });
    }
    emit({ type: "wand_qoder_catalog", models, defaultModel });
    finished = true;
    close();
  } else if (interrupted) {
    close();
  } else {
    if (config.mode) await setConfig("mode", config.mode);
    if (config.model && config.model !== "default") await setConfig("model", config.model);
    await applyEffort(config.thinkingEffort);
    emit({ method: "session/update", params: { sessionId: nativeSessionId,
      update: { sessionUpdate: "config_option_update", configOptions } } });
    promptRpcId = ++sequence;
    if (config.inputMessageId) emit({ type: "wand_input_ready", id: config.inputMessageId });
    if (steeringSupported) emit({ type: "wand_input_boundary", id: config.requestId });
    const promptBlocks: AcpPromptContent[] = buildAcpPromptBlocks(config.prompt, imagesSupported);
    wire({
      jsonrpc: "2.0",
      id: promptRpcId,
      method: "session/prompt",
      params: {
        sessionId: nativeSessionId,
        prompt: promptBlocks,
      },
    });
  }
} catch (error) {
  fail(error as Error);
}
