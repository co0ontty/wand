import { spawn } from "node:child_process";
import { capturePiExecutionEvent } from "./pi-execution.js";
import { defaultCoreHarnessAgentDir } from "./harness-engine.js";
import { preparePiResources, type PreparedPiResources } from "./pi-resource-run.js";
import { prepareOpenRouterFreeCli, type OpenRouterFreeCliDependencies } from "./openrouter-free-cli.js";
import { isOpenRouterFreeSelector } from "./openrouter-free-selection.js";
import { getErrorMessage } from "./error-utils.js";
import { classifyProviderRejection, hasStructuredExecutionProgress } from "./structured-failure.js";

import { settleThinkingRound, updateThinkingActivity } from "./structured-thinking.js";
import { startStructuredCli } from "./structured-exec-pump.js";
import type { StructuredExecHost } from "./structured-exec-host.js";
import { asRecord, canonicalizeToolResultContent } from "./structured-content.js";
import { systemPromptArgs, thinkingEffortToPiLevel } from "./structured-provider-common.js";
import { defaultPiCliSessionSettings, PI_BUILTIN_TOOLS, piToolSelection } from "./pi-session-settings.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
  StructuredRunnerResult,
  StructuredRunnerTurnState,
} from "./structured-runner.js";
import type { ContentBlock, SessionSnapshot } from "./types.js";

type PiTurnState = StructuredRunnerTurnState & { pendingSessionId?: string };

export function isMissingPiSession(error: string | null | undefined, sessionId: string | null | undefined): boolean {
  return !!sessionId && !!error?.includes(`No session found matching '${sessionId}'`);
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => textContent(item)).filter(Boolean).join("\n");
  const item = asRecord(value);
  if (!item) return "";
  if (item.type === "text" && typeof item.text === "string") return item.text;
  return textContent(item.content);
}

export function piToolsArgs(session: Pick<SessionSnapshot, "piSettings">): string[] {
  // 没有会话设置（旧快照）时按 CLI 出厂默认：跟随 Pi 自身配置，不传任何工具参数。
  const settings = session.piSettings ?? defaultPiCliSessionSettings();
  // 旧快照可能带未校验的名字：只保留合法的基础工具，再交给策略附加 CodeMode / 目标工具。
  const selection = piToolSelection({
    ...settings,
    tools: settings.tools.filter((tool) => PI_BUILTIN_TOOLS.includes(tool)),
  });
  // `globalTools` 打开：既不传 --tools 也不传 --exclude-tools，完全跟随 Pi 自身配置。
  if (selection.mode === "config") return [];
  return selection.names.length ? ["--tools", selection.names.join(",")] : ["--no-tools"];
}

export function buildPiArgs(session: SessionSnapshot, prompt: string, resourceArgs: string[] = []): string[] {
  const args = ["--mode", "json", "--print"];
  args.push(...piToolsArgs(session), ...resourceArgs);
  const model = session.selectedModel?.trim();
  if (model && model !== "default") args.push("--model", model);
  const thinking = thinkingEffortToPiLevel(session.thinkingEffort);
  if (thinking) args.push("--thinking", thinking);
  args.push(...systemPromptArgs(session));
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
  const usage = asRecord(message.usage);
  const cost = asRecord(usage?.cost);
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
    const item = asRecord(part);
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
  // 流式事件只给出边界时，最后一轮会停在空占位上。这里用完整正文补齐，
  // 而不是因为「已经有思考块」就把真实内容整段丢掉；单轮时更长的正文为准。
  const thinkingBlocks = state.blocks.filter((block) => block.type === "thinking");
  const lastThinking = thinkingBlocks.at(-1) as Extract<ContentBlock, { type: "thinking" }> | undefined;
  if (thinking) {
    if (!lastThinking) state.blocks.push({ type: "thinking", thinking });
    else if (!lastThinking.thinking.trim()) lastThinking.thinking = thinking;
    else if (thinkingBlocks.length === 1 && thinking.length > lastThinking.thinking.length) {
      lastThinking.thinking = thinking;
    }
  } else {
    settleThinkingRound(state.blocks, thinking);
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

export function applyPiEvent(state: PiTurnState, event: Record<string, unknown>, observedAt?: string): string | null {
  capturePiExecutionEvent(state.blocks, event);
  // Pi announces the ID before it writes a session file. The file is only
  // created when an assistant message is saved, so this ID is not resumable yet.
  if (event.type === "session" && typeof event.id === "string") state.pendingSessionId = event.id;
  if (event.type === "turn_start" || event.type === "message_start" || event.type === "tool_execution_start") {
    state.phase = "responding";
  }
  if (event.type === "message_update") {
    state.phase = "responding";
    const update = asRecord(event.assistantMessageEvent);
    const delta = typeof update?.delta === "string" ? update.delta : "";
    updateThinkingActivity(state.blocks, update, observedAt);
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
    state.blocks.push({ type: "tool_use", id, name: piToolName(name), input: asRecord(event.args) ?? {} });
  }
  if (event.type === "tool_execution_end") {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : "unknown";
    state.blocks.push({ type: "tool_result", tool_use_id: id, content: canonicalizeToolResultContent(event.result), is_error: event.isError === true });
  }
  if (event.type === "message_end" || event.type === "turn_end") {
    const message = asRecord(event.message);
    if (message?.role === "assistant") {
      if (state.pendingSessionId) state.sessionId = state.pendingSessionId;
      const error = applyPiAssistantMessage(state, message);
      if (event.type === "turn_end") {
        const content = Array.isArray(message.content) ? message.content : [];
        const hasToolCall = content.some((part) => asRecord(part)?.type === "toolCall");
        if (!hasToolCall && message.stopReason !== "toolUse") state.phase = "background";
      }
      return error;
    }
  }
  if (event.type === "agent_end" && Array.isArray(event.messages)) {
    let error: string | null = null;
    for (const raw of event.messages) {
      const message = asRecord(raw);
      if (message?.role === "assistant") {
        if (state.pendingSessionId) state.sessionId = state.pendingSessionId;
        error = applyPiAssistantMessage(state, message);
      }
    }
    return error;
  }
  return null;
}

export class PiRunner implements StructuredRunnerAdapter {
  constructor(
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly execHost?: StructuredExecHost,
    private readonly agentDir?: string,
    private readonly freeModels?: OpenRouterFreeCliDependencies,
  ) {}

  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    const selection = context.session.piSettings?.resources;
    const codemodeOverride = context.session.piSettings?.codemodeOverride;
    const freeSelection = isOpenRouterFreeSelector(context.session.selectedModel);
    const env = { ...context.env };
    delete env.WAND_PI_RESOURCE_POLICY;
    delete env.WAND_PI_FREE_POLICY;
    delete env.WAND_PI_FREE_TOKEN;
    context = { ...context, env };
    if (!selection && !codemodeOverride && !freeSelection) return this.startCli(context, observer);
    // Return synchronously so the manager registers ownership in this tick. Preparation belongs to
    // this execution; stop/delete during preparation prevents the process from being started.
    let execution: StructuredRunnerExecution | null = null;
    let interrupted = false;
    const spawnedAt = new Date().toISOString();
    const completion = (async () => {
      const prepared: PreparedPiResources[] = [];
      try {
        let preparedEnv = context.env;
        if (selection || codemodeOverride) {
          const resources = await preparePiResources(this.agentDir ?? defaultCoreHarnessAgentDir(),
            context.session.cwd, selection, preparedEnv, codemodeOverride);
          prepared.push(resources); preparedEnv = resources.env;
        }
        if (interrupted || !observer.isActive()) throw new Error("资源准备已取消，尚未启动 Pi。");
        if (freeSelection) {
          if (!this.freeModels) throw new Error("免费模型 CLI 接入未就绪，请更新 Wand 服务后重试。");
          const free = prepareOpenRouterFreeCli(this.freeModels, { ...context, env: preparedEnv });
          prepared.push(free); preparedEnv = free.env;
        }
        execution = this.startCli({ ...context, env: preparedEnv }, observer, prepared.flatMap((item) => item.args));
        const result = await execution.completion;
        // A configured fallback tool uses its own capabilities. Only the free-price boundary
        // forbids switching after execution; resource preparation failures still fail closed below.
        return freeSelection ? { ...result, retryForbidden: true } : result;
      } finally { for (const item of prepared.reverse()) item.close(); }
    })().catch((error: unknown): StructuredRunnerResult => ({
      state: { blocks: [], result: "", sessionId: context.session.claudeSessionId },
      exitCode: 1, signal: null, stderr: "", primaryError: getErrorMessage(error),
      inputAccepted: false, retryForbidden: true,
    }));
    return { get args() { return execution?.args ?? buildPiArgs(context.session, context.prompt, ["--no-skills"]); },
      get pid() { return execution?.pid ?? null; }, spawnedAt, completion,
      interrupt: () => { interrupted = true; execution?.interrupt(); } };
  }

  private startCli(context: StructuredRunnerContext, observer: StructuredRunnerObserver,
    resourceArgs: string[] = []): StructuredRunnerExecution {
    const args = buildPiArgs(context.session, context.prompt, resourceArgs);
    const state: PiTurnState = {
      blocks: [],
      result: "",
      sessionId: context.session.claudeSessionId,
      model: context.session.selectedModel ?? undefined,
      phase: "responding",
    };
    let primaryError: string | null = null;
    let progressed = false;
    let unparsedOutput = false;
    return startStructuredCli({
      sessionId: context.session.id,
      file: "pi",
      args,
      cwd: context.session.cwd,
      env: this.agentDir ? { ...context.env, PI_CODING_AGENT_DIR: this.agentDir } : context.env,
      observer,
      execHost: this.execHost,
      spawnProcess: this.spawnProcess,
      createState: () => state,
      processLine: (line) => {
        if (!observer.isActive() || !line.trim()) return;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          observer.onEvent?.(event);
          primaryError = applyPiEvent(state, event, new Date().toISOString()) ?? primaryError;
          progressed ||= hasStructuredExecutionProgress(state);
          const messages = event.type === "agent_end" && Array.isArray(event.messages) ? event.messages
            : event.type === "message_end" || event.type === "turn_end" ? [event.message] : [];
          progressed ||= messages.some((raw) => {
            const message = asRecord(raw);
            return message?.role === "assistant" && (message.stopReason !== "error"
              || (Array.isArray(message.content) && message.content.length > 0));
          });
          const lastAssistant = asRecord([...messages].reverse().find((raw) => asRecord(raw)?.role === "assistant"));
          // Pi can recover internally. A later completed answer supersedes an earlier error;
          // the opposite order remains a failure and the monotonic progress fact forbids replay.
          if (lastAssistant && lastAssistant.stopReason !== "error") primaryError = null;
          observer.onUpdate(state);
        } catch { unparsedOutput = true; /* Unknown stdout is not evidence of a safe refusal. */ }
      },
      finalize: (ctx, exitCode, signal, spawnError) => {
        const rejection = !progressed && !unparsedOutput && !signal && !spawnError
          ? classifyProviderRejection(primaryError) : null;
        return { state, exitCode, signal, stderr: ctx.stderr, primaryError, ...(spawnError ? { spawnError } : {}),
          ...(rejection ? { rejection, inputAccepted: false } : progressed ? { inputAccepted: true } : {}) };
      },
    });
  }
}
