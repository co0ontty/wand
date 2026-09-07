import { spawn } from "node:child_process";

import { startStructuredCli } from "./structured-exec-pump.js";
import type { StructuredExecHost } from "./structured-exec-host.js";
import { thinkingEffortToPiLevel } from "./structured-provider-common.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
  StructuredRunnerTurnState,
} from "./structured-runner.js";
import type { SessionSnapshot } from "./types.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => textContent(item)).filter(Boolean).join("\n");
  const item = record(value);
  if (!item) return "";
  if (item.type === "text" && typeof item.text === "string") return item.text;
  return textContent(item.content);
}

export function buildPiArgs(session: SessionSnapshot, prompt: string): string[] {
  const args = ["--mode", "json", "--print"];
  const model = session.selectedModel?.trim();
  if (model && model !== "default") args.push("--model", model);
  const thinking = thinkingEffortToPiLevel(session.thinkingEffort);
  if (thinking) args.push("--thinking", thinking);
  if (session.claudeSessionId) args.push("--session", session.claudeSessionId);
  args.push(prompt);
  return args;
}

export function piToolName(name: string): string {
  const mapped: Record<string, string> = { bash: "Bash", read: "Read", edit: "Edit", write: "Write", grep: "Grep", find: "Glob", ls: "Glob" };
  return mapped[name.toLowerCase()] ?? `Pi/${name}`;
}

function applyPiAssistantMessage(state: StructuredRunnerTurnState, message: Record<string, unknown>): string | null {
  if (typeof message.model === "string") state.model = message.model;
  const usage = record(message.usage);
  const cost = record(usage?.cost);
  if (usage) {
    state.usage = {
      inputTokens: typeof usage.input === "number" ? usage.input : 0,
      outputTokens: typeof usage.output === "number" ? usage.output : 0,
      cacheReadInputTokens: typeof usage.cacheRead === "number" ? usage.cacheRead : 0,
      cacheCreationInputTokens: typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0,
      totalCostUsd: typeof cost?.total === "number" ? cost.total : 0,
    };
  }

  const texts: string[] = [];
  const thinkings: string[] = [];
  const parts = Array.isArray(message.content) ? message.content : [];
  for (const part of parts) {
    const item = record(part);
    if (!item) continue;
    if (item.type === "text") {
      const text = typeof item.text === "string" ? item.text : textContent(item);
      if (text) texts.push(text);
    } else if (item.type === "thinking") {
      const thinking = typeof item.thinking === "string"
        ? item.thinking
        : typeof item.text === "string" ? item.text : "";
      if (thinking) thinkings.push(thinking);
    }
  }
  const thinking = thinkings.join("");
  if (thinking && !state.blocks.some((block) => block.type === "thinking")) {
    state.blocks.push({ type: "thinking", thinking });
  }
  const text = texts.join("");
  if (text) {
    const lastText = [...state.blocks].reverse().find((block) => block.type === "text");
    if (lastText?.type === "text") {
      if (text.length >= lastText.text.length) lastText.text = text;
    } else {
      state.blocks.push({ type: "text", text });
    }
    if (text.length >= state.result.length) state.result = text;
  }

  if (message.stopReason === "error") {
    return typeof message.errorMessage === "string" ? message.errorMessage : "Pi CLI execution failed";
  }
  return null;
}

export function applyPiEvent(state: StructuredRunnerTurnState, event: Record<string, unknown>): string | null {
  if (event.type === "session" && typeof event.id === "string") state.sessionId = event.id;
  if (event.type === "message_update") {
    const update = record(event.assistantMessageEvent);
    const delta = typeof update?.delta === "string" ? update.delta : "";
    if (update?.type === "text_delta" && delta) {
      const last = state.blocks.at(-1);
      if (last?.type === "text") last.text += delta;
      else state.blocks.push({ type: "text", text: delta });
      state.result += delta;
    } else if (update?.type === "thinking_delta" && delta) {
      const last = state.blocks.at(-1);
      if (last?.type === "thinking") last.thinking += delta;
      else state.blocks.push({ type: "thinking", thinking: delta });
    } else if (update?.type === "text_end" && typeof update.content === "string" && update.content) {
      const last = state.blocks.at(-1);
      if (last?.type === "text") last.text = update.content;
      else state.blocks.push({ type: "text", text: update.content });
      if (update.content.length >= state.result.length) state.result = update.content;
    } else if (update?.type === "thinking_end" && typeof update.content === "string" && update.content) {
      const last = state.blocks.at(-1);
      if (last?.type === "thinking") last.thinking = update.content;
      else state.blocks.push({ type: "thinking", thinking: update.content });
    }
  }
  if (event.type === "tool_execution_start") {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : crypto.randomUUID();
    const name = typeof event.toolName === "string" ? event.toolName : "tool";
    state.blocks.push({ type: "tool_use", id, name: piToolName(name), input: record(event.args) ?? {} });
  }
  if (event.type === "tool_execution_end") {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : "unknown";
    state.blocks.push({ type: "tool_result", tool_use_id: id, content: textContent(event.result), is_error: event.isError === true });
  }
  if (event.type === "message_end" || event.type === "turn_end") {
    const message = record(event.message);
    if (message?.role === "assistant") return applyPiAssistantMessage(state, message);
  }
  if (event.type === "agent_end" && Array.isArray(event.messages)) {
    for (const raw of event.messages) {
      const message = record(raw);
      if (message?.role === "assistant") {
        const error = applyPiAssistantMessage(state, message);
        if (error) return error;
      }
    }
  }
  return null;
}

export class PiRunner implements StructuredRunnerAdapter {
  constructor(
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly execHost?: StructuredExecHost,
  ) {}

  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    const args = buildPiArgs(context.session, context.prompt);
    const state: StructuredRunnerTurnState = { blocks: [], result: "", sessionId: context.session.claudeSessionId, model: context.session.selectedModel ?? undefined };
    let primaryError: string | null = null;
    return startStructuredCli({
      sessionId: context.session.id,
      file: "pi",
      args,
      cwd: context.session.cwd,
      env: context.env,
      observer,
      execHost: this.execHost,
      spawnProcess: this.spawnProcess,
      createState: () => state,
      processLine: (line) => {
        if (!observer.isActive() || !line.trim()) return;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          observer.onEvent?.(event);
          primaryError = applyPiEvent(state, event) ?? primaryError;
          observer.onUpdate(state);
        } catch { /* Pi stdout is NDJSON; ignore non-protocol noise. */ }
      },
      finalize: (ctx, exitCode, signal, spawnError) => ({ state, exitCode, signal, stderr: ctx.stderr, primaryError, ...(spawnError ? { spawnError } : {}) }),
    });
  }
}
