/**
 * Qoder ACP 执行工作进程。
 *
 * 由持久化宿主（terminald / wand-structured-renderd 或进程内宿主）托管。
 * 持久化宿主下，此工作进程与 Qoder ACP stdio 跨 Web 服务重启存活；进程内宿主不提供该保证。
 * 通过 stdin 读取单次启动配置，通过 stdout 向上抛出 NDJSON 事件，通过 control.sock 接收权限裁决、结构化回答与插话指令。
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

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

const child = spawn(config.file, ["--acp", ...(config.systemPrompt ? ["--append-system-prompt", config.systemPrompt] : [])], {
  cwd: config.cwd,
  env: process.env,
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
  rpcId: number;
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
  rpcId: number;
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
  const wanted = decision === "deny"
    ? ["reject_once", "reject_always"]
    : decision === "approve_turn"
      ? ["allow_always", "allow_once"]
      : ["allow_once", "allow_always"];
  for (const kind of wanted) {
    const match = options.find((option) => String(option.kind ?? "") === kind);
    if (match) return String(match.optionId ?? "") || null;
  }
  const fallback = options.find((option) => {
    const name = String(option.name ?? "").toLowerCase();
    return decision === "deny" ? /reject|deny|no\b/.test(name) : /allow|approve|yes\b/.test(name);
  });
  return fallback ? String(fallback.optionId ?? "") || null : null;
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
          if (finished || !promptRpcId || !nativeSessionId || !steeringSupported) {
            throw Object.assign(new Error("Qoder 当前回合不接受插话，消息已保留至下次回合。"), { rejected: true });
          }
          receipt(command.id, { state: "pending", text: command.text });
          const steerBlocks = buildAcpPromptBlocks(command.text, imagesSupported);
          const steeringId = ++sequence;
          steeringPromptIds.add(steeringId);
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
    const id = typeof frame.id === "number" ? frame.id : null;

    if (id !== null && !frame.method) {
      const pending = requests.get(id);
      if (pending) {
        requests.delete(id);
        clearTimeout(pending.timer);
        if (frame.error) {
          const rec = frame.error as Record<string, unknown>;
          pending.reject(Object.assign(new Error(String(rec.message ?? "Qoder ACP error")), { code: rec.code, data: rec.data }));
        } else {
          pending.resolve(frame.result);
        }
      }
      const steeringResult = steeringPromptIds.delete(id ?? -1);
      if (id === promptRpcId || steeringResult) {
        emit(frame);
        if (frame.error) failed = true;
        // Qoder promptQueueing coalesces inputs into the primary turn and may
        // never respond separately to steering IDs. Its primary result owns turn
        // completion; missing steering replies are not a reason to hang or replay.
        if (id === promptRpcId) {
          finished = true;
          close();
        }
      }
      return;
    }

    if (id !== null && typeof frame.method === "string") {
      // 权限请求
      if (frame.method === "session/request_permission") {
        const params = (frame.params && typeof frame.params === "object" ? frame.params : {}) as Record<string, unknown>;
        const options = Array.isArray(params.options) ? params.options as Array<Record<string, unknown>> : [];
        if (config.autoApprovePermissions === true || config.mode === "yolo") {
          const allowOption = options.find((opt) => String(opt.kind ?? "").startsWith("allow")) ?? options[0];
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
        emit(frame);
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
      fs: { readTextFile: true, writeTextFile: true },
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

  const configOptions = Array.isArray(sessionInfo?.configOptions)
    ? (sessionInfo.configOptions as AcpConfigOption[])
    : [];

  const desiredConfigs: Array<[string, string]> = [];
  if (config.mode) desiredConfigs.push(["mode", config.mode]);
  if (config.model && config.model !== "default") {
    const modelOpt = configOptions.find((o) => String(o.id ?? "") === "model");
    if (Array.isArray(modelOpt?.options)) {
      const match = modelOpt.options.find((opt) => {
        const val = String(opt.value ?? "");
        const name = String(opt.name ?? "");
        return val === config.model || name === config.model || name.replace(/\s*\(default\)$/i, "").trim() === config.model;
      });
      if (match && match.value) desiredConfigs.push(["model", String(match.value)]);
    }
  }
  if (config.thinkingEffort) {
    const effortOpt = configOptions.find((o) => String(o.id ?? "") === "reasoning_effort");
    if (Array.isArray(effortOpt?.options) && effortOpt.options.some((opt) => String(opt.value ?? "") === config.thinkingEffort)) {
      desiredConfigs.push(["reasoning_effort", config.thinkingEffort]);
    }
  }

  for (const [configId, value] of desiredConfigs) {
    try {
      await request("session/set_config_option", { sessionId: nativeSessionId, configId, value });
    } catch {
      // ignore rejected config option
    }
  }

  if (interrupted) {
    close();
  } else {
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
