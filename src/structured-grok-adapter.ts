import { spawn } from "node:child_process";

import { startStructuredCli } from "./structured-exec-pump.js";
import type { StructuredExecHost } from "./structured-exec-host.js";
import { thinkingEffortToGrokEffort } from "./structured-provider-common.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
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
  constructor(
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly execHost?: StructuredExecHost,
  ) {}

  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    const args = buildGrokArgs(context.session, context.prompt);
    const state: GrokTurnState = {
      blocks: [],
      result: "",
      sessionId: context.session.claudeSessionId,
      model: context.session.selectedModel ?? context.session.structuredState?.model,
    };
    let primaryError: string | null = null;
    return startStructuredCli({
      sessionId: context.session.id,
      file: "grok",
      args,
      cwd: context.session.cwd,
      env: context.env,
      observer,
      execHost: this.execHost,
      spawnProcess: this.spawnProcess,
      createState: () => state,
      processLine: (line) => {
        if (!observer.isActive()) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          observer.onEvent?.(event);
          primaryError = applyGrokEvent(state, event) ?? primaryError;
          observer.onUpdate(state);
        } catch { /* Grok diagnostics belong on stderr; ignore non-JSON stdout defensively. */ }
      },
      finalize: (ctx, exitCode, signal, spawnError) => ({
        state, exitCode, signal, stderr: ctx.stderr, primaryError, ...(spawnError ? { spawnError } : {}),
      }),
    });
  }
}
