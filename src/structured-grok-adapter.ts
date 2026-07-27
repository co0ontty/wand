import { spawn } from "node:child_process";

import { thinkingEffortToGrokEffort } from "./structured-provider-common.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
  StructuredRunnerResult,
  StructuredRunnerTurnState,
} from "./structured-runner.js";
import type { SessionSnapshot } from "./types.js";

export type GrokTurnState = StructuredRunnerTurnState;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function buildGrokArgs(session: SessionSnapshot, prompt: string): string[] {
  const args = ["--no-auto-update", "-p", prompt, "--output-format", "streaming-json"];
  const model = session.selectedModel?.trim();
  if (model && model !== "default") args.push("--model", model);
  const effort = thinkingEffortToGrokEffort(session.thinkingEffort);
  if (effort) args.push("--effort", effort);
  if (
    session.autoApprovePermissions === true
    || session.mode === "full-access"
    || session.mode === "managed"
    || session.mode === "auto-edit"
  ) {
    args.push("--always-approve");
  }
  if (session.claudeSessionId) args.push("--resume", session.claudeSessionId);
  return args;
}

/** Apply one official Grok Build `streaming-json` event. */
export function applyGrokEvent(state: GrokTurnState, event: Record<string, unknown>): string | null {
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "text" && typeof event.data === "string" && event.data) {
    const previous = state.blocks.at(-1);
    if (previous?.type === "text") previous.text += event.data;
    else state.blocks.push({ type: "text", text: event.data });
    state.result += event.data;
    return null;
  }
  if (type === "thought" && typeof event.data === "string" && event.data) {
    const previous = state.blocks.at(-1);
    if (previous?.type === "thinking") previous.thinking += event.data;
    else state.blocks.push({ type: "thinking", thinking: event.data });
    return null;
  }
  if (type === "end") {
    if (typeof event.sessionId === "string" && event.sessionId) state.sessionId = event.sessionId;
    const usage = asRecord(event.usage);
    const modelUsage = asRecord(event.modelUsage);
    const totalCostUsd = typeof event.total_cost_usd === "number"
      ? event.total_cost_usd
      : Object.values(modelUsage ?? {}).reduce<number>((sum, item) => {
          const cost = asRecord(item)?.costUSD;
          return sum + (typeof cost === "number" ? cost : 0);
        }, 0);
    state.usage = {
      inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : 0,
      outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : 0,
      reasoningOutputTokens: typeof usage?.reasoning_tokens === "number" ? usage.reasoning_tokens : 0,
      cacheReadInputTokens: typeof usage?.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0,
      ...(totalCostUsd > 0 ? { totalCostUsd } : {}),
    };
    return null;
  }
  if (type === "error") {
    return typeof event.message === "string" && event.message ? event.message : "Grok failed";
  }
  return null;
}

export class GrokRunner implements StructuredRunnerAdapter {
  constructor(private readonly spawnProcess: typeof spawn = spawn) {}

  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    const args = buildGrokArgs(context.session, context.prompt);
    const spawnedAt = new Date().toISOString();
    const child = this.spawnProcess("grok", args, {
      cwd: context.session.cwd,
      env: context.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const state: GrokTurnState = {
      blocks: [],
      result: "",
      sessionId: context.session.claudeSessionId,
      model: context.session.selectedModel ?? context.session.structuredState?.model,
    };
    let lineBuffer = "";
    let stderr = "";
    let primaryError: string | null = null;
    let settled = false;

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: NodeJS.ErrnoException): StructuredRunnerResult => ({
      state, exitCode, signal, stderr, primaryError, ...(spawnError ? { spawnError } : {}),
    });
    const processLine = (line: string): void => {
      if (!observer.isActive()) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        observer.onEvent?.(event);
        primaryError = applyGrokEvent(state, event) ?? primaryError;
        observer.onUpdate(state);
      } catch { /* Grok diagnostics belong on stderr; ignore non-JSON stdout defensively. */ }
    };
    const completion = new Promise<StructuredRunnerResult>((resolve) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        if (!observer.isActive()) return;
        const text = chunk.toString();
        observer.onStdout?.(text);
        lineBuffer += text;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (!observer.isActive()) return;
        const text = chunk.toString();
        observer.onStderr?.(text);
        stderr += text;
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        resolve(finish(null, null, error as NodeJS.ErrnoException));
      });
      child.on("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        if (lineBuffer.trim()) processLine(lineBuffer);
        resolve(finish(exitCode, signal));
      });
    });
    return {
      args,
      spawnedAt,
      pid: child.pid ?? null,
      completion,
      interrupt: () => { try { child.kill("SIGTERM"); } catch { /* best effort */ } },
    };
  }
}
