import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { openCodeMajorVersion, openCodeModelArgs } from "./opencode-cli.js";

import { startStructuredCli } from "./structured-exec-pump.js";
import type { StructuredExecHost } from "./structured-exec-host.js";
import { asRecord } from "./structured-content.js";
import { buildStructuredCliResult } from "./structured-failure.js";
import { thinkingEffortToOpenCodeVariant, promptWithSystemFallback } from "./structured-provider-common.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
  StructuredRunnerTurnState,
} from "./structured-runner.js";
import type { SessionSnapshot } from "./types.js";

export type OpenCodeTurnState = StructuredRunnerTurnState;

function extractStructuredText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractStructuredText).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (!record) return "";
  for (const key of ["text", "output_text", "message", "content", "summary", "data"]) {
    const text = extractStructuredText(record[key]);
    if (text) return text;
  }
  return "";
}

export function buildOpenCodeArgs(session: SessionSnapshot, major = 1): string[] {
  const args = ["run", "--format", "json", "--thinking"];
  if (major >= 2) args.push("--standalone");
  args.push(...openCodeModelArgs(session.selectedModel, thinkingEffortToOpenCodeVariant(session.thinkingEffort), major));
  if (
    session.autoApprovePermissions === true
    || session.mode === "full-access"
    || session.mode === "managed"
    || session.mode === "auto-edit"
  ) {
    args.push("--auto");
  }
  if (session.claudeSessionId) args.push("--session", session.claudeSessionId);
  return args;
}

function openCodeToolName(name: string): string {
  const mapped: Record<string, string> = {
    bash: "Bash",
    shell: "Bash",
    read: "Read",
    edit: "Edit",
    write: "Write",
    glob: "Glob",
    grep: "Grep",
    webfetch: "WebFetch",
    websearch: "WebSearch",
    todowrite: "TodoWrite",
    task: "Task",
    skill: "Skill",
  };
  return mapped[name.toLowerCase()] ?? `OpenCode/${name}`;
}

/** Apply one OpenCode NDJSON event to the current transport-neutral turn state. */
export function applyOpenCodeEvent(
  turnState: OpenCodeTurnState,
  event: Record<string, unknown>,
  createId: () => string = randomUUID,
): string | null {
  if (typeof event.sessionID === "string" && event.sessionID) turnState.sessionId = event.sessionID;
  const type = typeof event.type === "string" ? event.type : "";
  const part = asRecord(event.part);
  if (!part) {
    if (type === "error") return extractStructuredText(event.error) || "OpenCode run failed";
    return null;
  }

  if (type === "text" && typeof part.text === "string" && part.text.trim()) {
    turnState.blocks.push({ type: "text", text: part.text });
    turnState.result += (turnState.result ? "\n" : "") + part.text;
    return null;
  }
  if (type === "reasoning" && typeof part.text === "string" && part.text.trim()) {
    turnState.blocks.push({ type: "thinking", thinking: part.text });
    return null;
  }
  if (type === "tool_use") {
    const state = asRecord(part.state) ?? {};
    const tool = typeof part.tool === "string" && part.tool ? part.tool : "tool";
    const toolId = typeof part.callID === "string" && part.callID
      ? part.callID
      : typeof part.id === "string" && part.id
        ? part.id
        : createId();
    const input = asRecord(state.input) ?? {};
    turnState.blocks.push({
      type: "tool_use",
      id: toolId,
      name: openCodeToolName(tool),
      description: typeof state.title === "string" ? state.title : undefined,
      input,
    });
    const failed = state.status === "error";
    const content = failed
      ? (typeof state.error === "string" ? state.error : "OpenCode tool failed")
      : (typeof state.output === "string" ? state.output : "");
    turnState.blocks.push({ type: "tool_result", tool_use_id: toolId, content, is_error: failed });
    return null;
  }
  if (type === "step_finish") {
    const tokens = asRecord(part.tokens);
    const cache = asRecord(tokens?.cache);
    const previous = turnState.usage ?? {};
    turnState.usage = {
      inputTokens: (previous.inputTokens ?? 0) + (typeof tokens?.input === "number" ? tokens.input : 0),
      outputTokens: (previous.outputTokens ?? 0) + (typeof tokens?.output === "number" ? tokens.output : 0),
      reasoningOutputTokens: (previous.reasoningOutputTokens ?? 0) + (typeof tokens?.reasoning === "number" ? tokens.reasoning : 0),
      cacheReadInputTokens: (previous.cacheReadInputTokens ?? 0) + (typeof cache?.read === "number" ? cache.read : 0),
      cacheCreationInputTokens: (previous.cacheCreationInputTokens ?? 0) + (typeof cache?.write === "number" ? cache.write : 0),
      totalCostUsd: (previous.totalCostUsd ?? 0) + (typeof part.cost === "number" ? part.cost : 0),
    };
  }
  return null;
}

/** Production adapter for the external `opencode run --format json` process. */
export class OpenCodeRunner implements StructuredRunnerAdapter {
  constructor(
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly execHost?: StructuredExecHost,
  ) {}

  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    const abort = new AbortController();
    let execution: StructuredRunnerExecution | undefined;
    const spawnedAt = new Date().toISOString();
    const completion = Promise.resolve().then(async () => {
      const major = await openCodeMajorVersion(context.env, abort.signal);
      if (abort.signal.aborted || !observer.isActive()) throw new Error("OpenCode 启动已取消。");
      execution = this.startCli(context, observer, major);
      return execution.completion;
    }).catch((error: unknown) => {
      // Once launched, keep the runner's delivery facts; preparation is the only known rejection.
      if (execution) throw error;
      return {
        state: { blocks: [], result: "", sessionId: context.session.claudeSessionId },
        exitCode: 1, signal: null, stderr: "", primaryError: error instanceof Error ? error.message : "OpenCode 启动准备失败。",
        processExited: true, inputAccepted: false, retryForbidden: true,
      };
    });
    return { spawnedAt, completion,
      get args() { return execution?.args ?? []; }, get pid() { return execution?.pid ?? null; },
      exited: completion.then(() => execution?.exited, () => execution?.exited).then(() => {}),
      interrupt() { abort.abort(); execution?.interrupt(); },
    };
  }

  private startCli(context: StructuredRunnerContext, observer: StructuredRunnerObserver, major: number): StructuredRunnerExecution {
    const args = buildOpenCodeArgs(context.session, major);
    const state: OpenCodeTurnState = {
      blocks: [],
      result: "",
      sessionId: context.session.claudeSessionId,
      model: context.session.selectedModel ?? context.session.structuredState?.model,
      usage: undefined,
    };
    let primaryError: string | null = null;
    let protocolError = false;
    let unparsedStdout = false;
    let protocolEventObserved = false;
    const previousSessionId = context.session.claudeSessionId;
    return startStructuredCli({
      sessionId: context.session.id,
      file: "opencode",
      args,
      cwd: context.session.cwd,
      env: context.env,
      stdinData: promptWithSystemFallback(context.session, context.prompt),
      observer,
      execHost: this.execHost,
      requestId: context.session.structuredState?.activeRequestId ?? undefined,
      spawnProcess: this.spawnProcess,
      createState: () => state,
      processLine: (line) => {
        if (!observer.isActive()) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          unparsedStdout = true;
          return;
        }
        protocolEventObserved = true;
        observer.onEvent?.(event);
        const error = applyOpenCodeEvent(state, event);
        if (error) { primaryError = error; protocolError = true; }
        observer.onUpdate(state);
      },
      finalize: (ctx, exitCode, signal, spawnError) => buildStructuredCliResult({
        state, exitCode, signal, stderr: ctx.stderr, primaryError,
        protocolError, unparsedStdout, spawnError,
        previousSessionId,
        noProtocolEvent: !protocolEventObserved,
      }),
    });
  }
}
