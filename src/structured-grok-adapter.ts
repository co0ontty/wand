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

function grokText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(grokText).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (!record) return "";
  if (typeof record.text === "string" && record.text) return record.text;
  if (record.content !== undefined) return grokText(record.content);
  if (record.stdout !== undefined || record.stderr !== undefined) {
    return [grokText(record.stdout), grokText(record.stderr)].filter(Boolean).join("\n");
  }
  try { return JSON.stringify(record); } catch { return ""; }
}

function grokToolName(event: Record<string, unknown>): string | null {
  const raw = [
    typeof event.toolName === "string" ? event.toolName : "",
    typeof event.kind === "string" ? event.kind : "",
    typeof event.title === "string" ? event.title : "",
  ].find((value) => value.trim());
  if (!raw) return null;
  const mapped: Record<string, string> = {
    run_terminal_command: "Bash",
    bash: "Bash",
    shell: "Bash",
    read_file: "Read",
    read: "Read",
    search_replace: "Edit",
    edit: "Edit",
    write: "Write",
    list_dir: "Glob",
    glob: "Glob",
    grep: "Grep",
    web_search: "WebSearch",
    webfetch: "WebFetch",
    todo_write: "TodoWrite",
  };
  return mapped[raw.toLowerCase()] ?? raw;
}

function grokToolInput(event: Record<string, unknown>): Record<string, unknown> {
  return asRecord(event.rawInput) ?? asRecord(event.input) ?? {};
}

function grokToolOutput(event: Record<string, unknown>): string {
  const fromRaw = grokText(event.rawOutput);
  if (fromRaw) return fromRaw;
  return grokText(event.content);
}

function upsertGrokTool(
  state: GrokTurnState,
  event: Record<string, unknown>,
  completed: boolean,
): void {
  const id = typeof event.toolCallId === "string" && event.toolCallId
    ? event.toolCallId
    : typeof event.id === "string" && event.id ? event.id : "tool";
  const input = grokToolInput(event);
  const name = grokToolName(event);
  const title = typeof event.title === "string" ? event.title : undefined;
  const existingUse = state.blocks.find((block) => block.type === "tool_use" && block.id === id);
  if (existingUse?.type === "tool_use") {
    if (name) existingUse.name = name;
    existingUse.description = title ?? existingUse.description;
    existingUse.input = Object.keys(input).length ? input : existingUse.input;
  } else {
    state.blocks.push({ type: "tool_use", id, name: name ?? "tool", description: title, input });
  }
  if (!completed) return;
  const content = grokToolOutput(event);
  const failed = event.status === "failed" || event.status === "error";
  const existingResult = state.blocks.find((block) => block.type === "tool_result" && block.tool_use_id === id);
  if (existingResult?.type === "tool_result") {
    existingResult.content = content || existingResult.content;
    existingResult.is_error = failed;
    return;
  }
  state.blocks.push({ type: "tool_result", tool_use_id: id, content, is_error: failed });
}

/** Headless `--output-format streaming-json` is type-tagged; ACP stdio uses session/update. */
function normalizeGrokEvent(event: Record<string, unknown>): Record<string, unknown> {
  if (typeof event.type === "string" && event.type) return event;
  if (event.method !== "session/update") return event;
  const params = asRecord(event.params);
  const update = asRecord(params?.update) ?? asRecord(event.update);
  if (!update) return event;
  const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
  const content = asRecord(update.content);
  const text = typeof content?.text === "string" ? content.text : grokText(update.content);
  if (kind === "agent_message_chunk") return { type: "text", data: text };
  if (kind === "agent_thought_chunk" || kind === "thought") return { type: "thought", data: text };
  if (kind === "tool_call" || kind === "tool_call_update") return { type: kind, ...update };
  return event;
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
  event = normalizeGrokEvent(event);
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
  if (type === "tool_call") {
    upsertGrokTool(state, event, event.status === "completed" || event.status === "failed" || event.status === "error");
    return null;
  }
  if (type === "tool_call_update") {
    upsertGrokTool(state, event, event.status !== "in_progress");
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
