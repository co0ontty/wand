import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { parseAttachmentPrompt } from "./structured-attachment-input.js";
import { AcpTurnReducer, type AcpPromptResult } from "./structured-acp-reducer.js";
import { cliUnacceptedFacts, hasStructuredExecutionProgress } from "./structured-failure.js";
import { inferStructuredEscalation } from "./structured-permission.js";
import { thinkingEffortToQoderEffort } from "./structured-provider-common.js";
import { startStructuredCli } from "./structured-exec-pump.js";
import { createNdjsonLineHandler } from "./structured-ndjson.js";
import { asRecord } from "./structured-content.js";
import { whichSync } from "./path-repair.js";
import { sendQoderControl } from "./qoder-acp-control.js";
import type { StructuredExecHost } from "./structured-exec-host.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
  StructuredRunnerResult,
} from "./structured-runner.js";
import type { EscalationScope, SessionSnapshot } from "./types.js";
import type { QoderAcpWorkerConfig } from "./qoder-acp-worker.js";

/** 单张图片的原生输入上限，与 Codex 的 nativeImagePaths 预算一致。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

export interface AcpConfigOption {
  id?: unknown;
  currentValue?: unknown;
  options?: Array<{ value?: unknown; name?: unknown }>;
}

export function buildQoderAcpArgs(_session: SessionSnapshot): string[] {
  const js = fileURLToPath(new URL("./qoder-acp-worker.js", import.meta.url));
  return existsSync(js) ? [js] : ["--import", import.meta.resolve("tsx"), js.replace(/\.js$/, ".ts")];
}

/**
 * Wand 的执行模式 → Qoder ACP 的会话模式。
 *
 * 无人值守的执行（团队 / 定时 / 派发）没有能点确认的人，沿用 print 时代的无提示行为；
 * 交互会话按用户的权限姿态选最接近的一档：自主模式只在改文件上不打扰，assist 每一步都问。
 */
export function qoderAcpMode(session: SessionSnapshot): string {
  if ((session.sessionSource ?? "interactive") !== "interactive") return "yolo";
  if (session.autoApprovePermissions === true) return "yolo";
  switch (session.mode) {
    case "full-access":
    case "managed":
    case "auto-edit":
      return "yolo";
    case "agent-max":
      return "auto";
    case "agent":
      return "acceptEdits";
    default:
      return "default";
  }
}

function getString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** ACP 用户输入的 content block。 */
export type AcpPromptContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

/** 附件里的图片走 ACP 原生多模态输入；其余附件保持路径文本，由 agent 自己读。 */
export function buildAcpPromptBlocks(prompt: string, imagesSupported: boolean): AcpPromptContent[] {
  const blocks: AcpPromptContent[] = [{ type: "text", text: prompt }];
  if (!imagesSupported) return blocks;
  const { paths } = parseAttachmentPrompt(prompt);
  for (const candidate of paths) {
    if (blocks.length > 10) break;
    if (!path.isAbsolute(candidate)) continue;
    const mimeType = IMAGE_MIME[path.extname(candidate).toLowerCase()];
    if (!mimeType) continue;
    try {
      const data = readFileSync(candidate);
      if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) continue;
      blocks.push({ type: "image", mimeType, data: data.toString("base64") });
    } catch {
      // 附件可能已被移动/删除：退回路径文本，不因为一张图让整轮失败。
    }
  }
  return blocks;
}

/** ACP 工具调用 → Wand 审批卡片需要的 scope/target/reason。 */
export function escalationFor(toolCall: Record<string, unknown>): { scope: EscalationScope; target?: string; reason: string; toolName: string } {
  const title = getString(toolCall.title);
  const kind = getString(toolCall.kind);
  const raw = asRecord(toolCall.rawInput) ?? {};
  const locations = Array.isArray(toolCall.locations)
    ? toolCall.locations.map((entry) => getString(asRecord(entry)?.path)).filter(Boolean)
    : [];
  const toolName = kind === "execute" ? "Bash" : kind === "edit" || kind === "delete" || kind === "move" ? "Edit" : title || "工具";
  const input: Record<string, unknown> = { ...raw };
  if (toolName === "Bash" && !getString(input.command)) input.command = title;
  if ((toolName === "Edit" || toolName === "Read") && !getString(input.file_path)) input.file_path = locations[0] ?? title;
  const inferred = inferStructuredEscalation(toolName, input, { title, description: title });
  return {
    scope: inferred.scope,
    ...(inferred.target ? { target: inferred.target } : {}),
    reason: inferred.reason || `需要授权执行 ${title || "工具调用"}`,
    toolName,
  };
}

export class QoderAcpRunner implements StructuredRunnerAdapter {
  constructor(
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly execHost?: StructuredExecHost,
  ) {}

  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    const session = context.session;
    const reducer = new AcpTurnReducer(session);
    const previousSessionId = session.claudeSessionId ?? null;
    let protocolEventObserved = false;
    let protocolError = false;
    let unparsedStdout = false;
    let primaryError: string | null = null;
    const activeRequestId = session.structuredState?.activeRequestId ?? randomUUID();

    const workerConfig: QoderAcpWorkerConfig = {
      file: whichSync("qodercli", { env: context.env }) ?? "qodercli",
      sessionId: session.id,
      requestId: activeRequestId,
      claudeSessionId: session.claudeSessionId ?? null,
      prompt: context.prompt,
      cwd: session.cwd,
      systemPrompt: [session.systemPrompt?.trim(), session.runtimeSystemPrompt?.trim()].filter(Boolean).join("\n\n") || undefined,
      model: session.selectedModel?.trim() || undefined,
      thinkingEffort: thinkingEffortToQoderEffort(session.thinkingEffort),
      mode: qoderAcpMode(session),
      autoApprovePermissions: session.autoApprovePermissions === true,
    };

    return startStructuredCli({
      sessionId: session.id,
      file: process.execPath,
      args: buildQoderAcpArgs(session),
      cwd: session.cwd,
      env: context.env,
      stdinData: `${JSON.stringify(workerConfig)}\n`,
      observer,
      execHost: this.execHost,
      requestId: activeRequestId,
      spawnProcess: this.spawnProcess,
      createState: () => reducer.state,
      processLine: createNdjsonLineHandler({
        observer,
        onUnparsed: () => {
          unparsedStdout = true;
        },
        handleEvent: (event) => {
          if (!event || typeof event !== "object" || Array.isArray(event)) return;
          const record = event as Record<string, unknown>;

          if (record.type === "wand_qoder_session" && typeof record.sessionId === "string") {
            protocolEventObserved = true;
            reducer.setSessionId(record.sessionId);
            observer.onUpdate(reducer.state);
            context.onQoderInputEvent?.(record, reducer.state);
            return;
          }

          if (record.type === "wand_qoder_permission" && record.id) {
            protocolEventObserved = true;
            const escalationId = getString(record.id);
            const toolCall = asRecord(record.toolCall) ?? {};
            const escalation = escalationFor(toolCall);
            context.onQoderInputEvent?.(record, reducer.state);
            if (context.requestPermission) {
              context.requestPermission({
                id: escalationId,
                scope: escalation.scope,
                target: escalation.target,
                reason: escalation.reason,
                toolName: escalation.toolName,
              }).then((decision: any) => {
                if (decision) {
                  void sendQoderControl(session.id, activeRequestId, {
                    type: "permission_resolution",
                    escalationId,
                    resolution: decision,
                  }).catch(() => {});
                }
              }, () => {
                // 服务端优雅断开时不向 worker 投递拒绝，让它保留在 control.sock 等待重启后裁决。
              });
            }
            return;
          }

          if (record.type === "wand_qoder_question" || record.type === "wand_qoder_question_resolved"
            || record.type === "wand_input_boundary" || record.type === "wand_input_committed") {
            protocolEventObserved = true;
            context.onQoderInputEvent?.(record, reducer.state);
            if (record.type === "wand_qoder_question" && record.id && Array.isArray(record.questions)) {
              reducer.applyQuestion(getString(record.id), record.questions);
              observer.onUpdate(reducer.state);
            }
            if (record.type === "wand_qoder_question_resolved" && record.id) {
              reducer.resolveQuestion(getString(record.id));
              observer.onUpdate(reducer.state);
            }
            return;
          }

          if (record.method === "session/update") {
            protocolEventObserved = true;
            const params = asRecord(record.params);
            const update = asRecord(params?.update);
            if (update && reducer.applyUpdate(update)) {
              observer.onUpdate(reducer.state);
            }
            return;
          }

          if (record.id !== undefined && !record.method) {
            protocolEventObserved = true;
            if (record.result) {
              reducer.applyPromptResult(record.result as AcpPromptResult);
              observer.onUpdate(reducer.state);
            }
            if (record.error) {
              const err = asRecord(record.error);
              primaryError = getString(err?.message) || "Qoder ACP 执行失败。";
              protocolError = true;
            }
          }
        },
      }),
      finalize: (ctx, exitCode, signal, spawnError) => {
        if (protocolError && primaryError) {
          reducer.dropErrorEcho(primaryError);
        }
        const progressed = reducer.workObserved || hasStructuredExecutionProgress(reducer.state);
        return {
          state: reducer.state,
          exitCode,
          signal,
          stderr: ctx.stderr,
          stdoutTail: "",
          primaryError,
          ...(spawnError ? { spawnError } : {}),
          ...cliUnacceptedFacts({
            state: reducer.state,
            primaryError,
            protocolError,
            unparsedStdout,
            signal,
            progressed,
            exitCode,
            previousSessionId,
            noProtocolEvent: !protocolEventObserved,
            ...(spawnError ? { spawnError } : {}),
          }),
        };
      },
    });
  }
}
