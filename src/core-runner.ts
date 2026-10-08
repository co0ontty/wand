import { randomUUID } from "node:crypto";
import { capturePiExecutionEvent } from "./pi-execution.js";
import { buildChildEnv } from "./env-utils.js";
import { getErrorMessage } from "./error-utils.js";
import { coreHarnessAgentDir, coreModelSelector, coreHarnessRuntime, loadPiAi, loadPiAgentCore, loadPiCodingAgent, resolveCoreModel } from "./harness-engine.js";
import { OPENROUTER_FREE_ROUTING, isOpenRouterFreeSelector, type OpenRouterFreeModelsService } from "./openrouter-free-models.js";
import type { ResolvedCoreModel } from "./harness-engine.js";
import type { DecisionRuntimeAccess } from "./decision-runner.js";
import type { ConversationTurn, SessionSnapshot, WandConfig } from "./types.js";
import { CoreTurnTracker } from "./core-turn-tracker.js";
import { defaultPiSessionSettings } from "./pi-session-settings.js";
import { createCoreExtensionHost, type CoreExtensionHost } from "./core-extension-host.js";
import { updateThinkingActivity } from "./structured-thinking.js";
import { canonicalizeToolResultContent, toolResultContentToAgentParts } from "./structured-content.js";
import type {
  StructuredContextUsage,
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
  StructuredRunnerResult,
  StructuredRunnerTurnState,
} from "./structured-runner.js";
import type { Agent, AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, JsonObject, Model, Api, ModelThinkingLevel, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** 上游工具名 → Wand 展示名，与 CLI 适配器保持同一口径（卡片/语义投影都按这个名字判定）。 */
const CORE_TOOL_DISPLAY_NAMES: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
};

function coreToolDisplayName(name: string): string {
  return CORE_TOOL_DISPLAY_NAMES[name] ?? name;
}

/** 展示名 → 上游工具名：重建历史 transcript 时要还原成 loop 认得的名字。 */
function upstreamToolName(name: string): string {
  const bare = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  for (const [upstream, display] of Object.entries(CORE_TOOL_DISPLAY_NAMES)) {
    if (display === bare || display.toLowerCase() === bare.toLowerCase()) return upstream;
  }
  return bare;
}

function usageFromPi(usage: Usage | undefined): ConversationTurn["usage"] | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input ?? 0,
    outputTokens: usage.output ?? 0,
    cacheReadInputTokens: usage.cacheRead ?? 0,
    cacheCreationInputTokens: usage.cacheWrite ?? 0,
    ...(typeof usage.reasoning === "number" && usage.reasoning > 0 ? { reasoningOutputTokens: usage.reasoning } : {}),
    totalCostUsd: typeof usage.cost?.total === "number" ? usage.cost.total : 0,
  };
}

function usageFromWand(usage: ConversationTurn["usage"]): Usage {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  return {
    input,
    output,
    cacheRead: usage?.cacheReadInputTokens ?? 0,
    cacheWrite: usage?.cacheCreationInputTokens ?? 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage?.totalCostUsd ?? 0 },
  };
}

function timestampOf(iso: string | undefined, fallback: number): number {
  if (!iso) return fallback;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 压缩摘要作为上下文导入时的头部：明确它不是新的用户要求。 */
export const CORE_SUMMARY_HEADER = "[更早的对话已被压缩为下面的摘要。它是本会话的已有上下文，不是新的用户要求。]\n\n";

/**
 * Wand 历史 → core transcript。
 * Wand 库是唯一事实源：每个回合都从存储的历史重建，不依赖上游 session 文件。
 * Wand 允许 tool_result 落在 tool_use 之后的另一个 turn（服务端把结果并进下一个 user turn），
 * 这里按 toolCallId 重新配对成标准的 assistant / toolResult 消息。
 *
 * `from` 之后的 turn 才进入 transcript；更早的历史由 `summary` 代表（上下文压缩后）。
 */
export function coreMessagesFromTurns(session: SessionSnapshot, options: { from?: number; until?: number; summary?: string } = {}): AgentMessage[] {
  const turns = session.messages ?? [];
  const from = Math.max(0, Math.min(options.from ?? 0, turns.length));
  const until = Math.max(from, Math.min(options.until ?? turns.length, turns.length));
  const messages: AgentMessage[] = [];
  const now = Date.now();
  const toolNames = new Map<string, string>();
  const summary = options.summary?.trim();
  if (from > 0 && summary) {
    messages.push({ role: "user", content: [{ type: "text", text: `${CORE_SUMMARY_HEADER}${summary}` }], timestamp: timestampOf(turns[from]?.createdAt, now) });
  }
  for (const turn of turns.slice(from, until)) {
    const blocks = turn.content ?? [];
    const at = timestampOf(turn.createdAt, now);
    if (turn.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      for (const block of blocks) {
        if (block.type === "text") {
          if (block.text.trim()) content.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          if (block.thinking.trim()) content.push({ type: "thinking", thinking: block.thinking });
        } else if (block.type === "tool_use") {
          const name = upstreamToolName(block.name);
          toolNames.set(block.id, name);
          content.push({ type: "toolCall", id: block.id, name, arguments: (block.input ?? {}) as JsonObject });
        }
      }
      if (content.length === 0) continue;
      messages.push({
        role: "assistant",
        content,
        api: "core-replay",
        provider: session.provider ?? "pi",
        model: session.selectedModel ?? "",
        usage: usageFromWand(turn.usage),
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        timestamp: at,
      });
      continue;
    }
    const texts: string[] = [];
    for (const block of blocks) {
      if (block.type === "tool_result") {
        messages.push({
          role: "toolResult",
          toolCallId: block.tool_use_id,
          toolName: toolNames.get(block.tool_use_id) ?? "tool",
          content: toolResultContentToAgentParts(block.content),
          isError: block.is_error === true,
          timestamp: at,
        });
      } else if (block.type === "text") {
        texts.push(block.text);
      }
    }
    const text = texts.join("\n").trim();
    if (text) messages.push({ role: "user", content: [{ type: "text", text }], timestamp: at });
  }
  return messages;
}

/** 单条 assistant 消息的权威内容 → Wand blocks（去重、保序，不覆盖已到达的 tool_result）。 */
function applyAssistantMessage(state: StructuredRunnerTurnState, message: AssistantMessage): void {
  if (typeof message.model === "string" && message.model) state.model = message.model;
  const usage = usageFromPi(message.usage);
  if (usage) state.usage = usage;

  const texts: string[] = [];
  const thinkings: string[] = [];
  const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  for (const part of message.content ?? []) {
    if (part.type === "text") texts.push(part.text);
    else if (part.type === "thinking") thinkings.push(part.thinking);
    else if (part.type === "toolCall") {
      toolCalls.push({ id: part.id, name: part.name, arguments: (part.arguments ?? {}) as Record<string, unknown> });
    }
  }
  const text = texts.join("");
  if (text.trim()) {
    const lastText = [...state.blocks].reverse().find((block) => block.type === "text");
    if (lastText?.type === "text" && text.length >= lastText.text.length) lastText.text = text;
    else if (!lastText) state.blocks.push({ type: "text", text });
  }
  if (thinkings.length > 0) {
    const thinking = thinkings.join("");
    const lastThinking = [...state.blocks].reverse().find((block) => block.type === "thinking");
    if (lastThinking?.type === "thinking") {
      if (thinking.length >= lastThinking.thinking.length) lastThinking.thinking = thinking;
    } else {
      state.blocks.push({ type: "thinking", thinking });
    }
  }
  for (const call of toolCalls) {
    if (state.blocks.some((block) => block.type === "tool_use" && block.id === call.id)) continue;
    state.blocks.push({
      type: "tool_use",
      id: call.id,
      name: coreToolDisplayName(call.name),
      ...(typeof call.arguments.description === "string" ? { description: call.arguments.description } : {}),
      input: call.arguments,
      occurredAt: new Date().toISOString(),
    });
  }
  if (text.length >= state.result.length) state.result = text;
}

/**
 * core agent 事件 → Wand 回合状态。与 pi CLI 适配器共用同一套 blocks 语义，
 * 但参数与结果是上游真值（不再从 provider 文本里反推）。返回本轮的 primaryError。
 */
export function applyCoreAgentEvent(state: StructuredRunnerTurnState, event: Record<string, unknown>): string | null {
  capturePiExecutionEvent(state.blocks, event);
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "agent_start" || type === "turn_start" || type === "message_start") {
    state.phase = "responding";
    return null;
  }
  if (type === "message_update") {
    state.phase = "responding";
    const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
    const delta = typeof update?.delta === "string" ? update.delta : "";
    updateThinkingActivity(state.blocks, update, new Date().toISOString());
    if (!delta) return null;
    if (update?.type === "text_delta") {
      const last = state.blocks.at(-1);
      if (last?.type === "text") last.text += delta;
      else state.blocks.push({ type: "text", text: delta });
      state.result += delta;
    } else if (update?.type === "thinking_delta") {
      const last = state.blocks.at(-1);
      if (last?.type === "thinking") last.thinking += delta;
      else state.blocks.push({ type: "thinking", thinking: delta });
    }
    return null;
  }
  if (type === "message_end") {
    const message = event.message as AssistantMessage | undefined;
    if (message?.role !== "assistant") return null;
    applyAssistantMessage(state, message);
    if (message.stopReason === "error") {
      return typeof message.errorMessage === "string" && message.errorMessage ? message.errorMessage : "core 引擎回合失败";
    }
    return null;
  }
  if (type === "tool_execution_start") {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
    // Nested CodeMode calls are real operations, not fabricated tool text.
    if (id && !state.blocks.some((block) => block.type === "tool_use" && block.id === id)) {
      state.blocks.push({ type: "tool_use", id, name: coreToolDisplayName(String(event.toolName ?? "tool")),
        input: (event.args ?? {}) as Record<string, unknown>, occurredAt: new Date().toISOString() });
    }
    return null;
  }
  if (type === "tool_execution_end") {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : `core-${randomUUID()}`;
    const raw = (event.result ?? {}) as Record<string, unknown>;
    const details = raw.details;
    const preview = details && typeof details === "object" && typeof (details as Record<string, unknown>).preview === "string"
      ? String((details as Record<string, unknown>).preview).slice(0, 180)
      : undefined;
    state.blocks.push({
      type: "tool_result",
      tool_use_id: id,
      content: canonicalizeToolResultContent(event.result),
      is_error: event.isError === true,
      ...(preview ? { preview } : {}),
    });
    return null;
  }
  return null;
}

export interface CoreRunnerOptions {
  openRouter?: OpenRouterFreeModelsService;
  config: WandConfig;
  /** 进程内决策能力（与 CLI 的 env token 路径二选一，core 用这个）。 */
  decisionAccess?: () => DecisionRuntimeAccess | null;
  /** 测试/宿主注入：替换模型流式实现（生产用 ModelRuntime.streamSimple）。 */
  streamFn?: StreamFn;
  /** 测试/宿主注入：替换模型解析（生产走 Pi 认证目录）。 */
  modelResolver?: (session: SessionSnapshot) => Promise<ResolvedCoreModel | null>;
}

/**
 * 进程内 core runner：用 Pi 的 agent loop 跑结构化会话。
 * 与 CLI runner 的契约完全相同（同一个 StructuredRunnerAdapter），
 * 差别是 loop 与工具都在 Wand 进程内，系统提示由 Wand 拥有、上下文由 Wand 拥有。
 */
export class CoreRunner implements StructuredRunnerAdapter {
  constructor(private readonly options: CoreRunnerOptions) {}

  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    const controller = new AbortController();
    const state: StructuredRunnerTurnState = {
      blocks: [],
      result: "",
      // core 没有 CLI 原生会话 id：历史由 Wand 库持有，恢复靠重建 transcript。
      sessionId: null,
      model: context.session.selectedModel ?? undefined,
      phase: "responding",
    };
    let agent: Agent | null = null;
    let interruptExtensions: (() => void) | undefined;
    let inputAccepted = false;
    const turnToken = CoreTurnTracker.startTurn(context.session.id);
    let aborted = false;
    const spawnedAt = new Date().toISOString();

    const completion = (async (): Promise<StructuredRunnerResult> => {
      let primaryError: string | null = null;
      try {
        primaryError = await this.runTurn(context, observer, state, controller, (created, interrupt) => { agent = created; interruptExtensions = interrupt; },
          () => { inputAccepted = true; });
      } catch (error) {
        primaryError = aborted ? null : getErrorMessage(error);
      } finally {
        if (observer.isActive()) observer.onUpdate(state);
        // Always untrack when done
        CoreTurnTracker.endTurn(turnToken);
      }
      return {
        state,
        exitCode: primaryError ? 1 : 0,
        signal: null,
        stderr: primaryError ?? "",
        primaryError,
        inputAccepted,
        ...((context.session.piSettings?.resources || context.session.piSettings?.codemodeOverride
          || context.session.piSettings?.autoResources || context.session.piSettings?.lockedSkills?.length) && primaryError
          ? { retryForbidden: true } : {}),
      };
    })();

    return {
      // 结构化 spawn 日志用 args 记录"这一轮用什么引擎/模型"，与 CLI 的 argv 语义对齐。
      args: ["core", context.session.selectedModel?.trim() || "default"],
      spawnedAt,
      pid: process.pid,
      completion,
      interrupt: () => {
        aborted = true;
        try {
          // Pause extension-owned continuation before aborting the stream.
          if (interruptExtensions) interruptExtensions();
          else agent?.abort();
        } catch {
          // 回合已经结束；interrupt 是幂等的。
        } finally {
          controller.abort();
        }
      },
    };
  }

  /** 返回本轮的 primaryError；null 表示成功。 */
  private async runTurn(
    context: StructuredRunnerContext,
    observer: StructuredRunnerObserver,
    state: StructuredRunnerTurnState,
    controller: AbortController,
    register: (agent: Agent, interrupt?: () => void) => void,
    accepted: () => void,
  ): Promise<string | null> {
    const session = context.session;
    if (session.piSettings?.resources || session.piSettings?.codemodeOverride
      || session.piSettings?.autoResources || session.piSettings?.lockedSkills?.length) {
      return "Wand Agent 尚不支持会话级 Skills / MCP 选择，没有改用全局资源。";
    }
    const injectedStreamFn = this.options.streamFn;
    // 测试环境必须显式注入模型缝隙：避免单测无意中发出真实付费请求（或挂在网络上）。
    if (!injectedStreamFn && !this.options.modelResolver && process.env.NODE_TEST_CONTEXT) {
      return "core 引擎在测试环境下必须注入 streamFn/modelResolver（或把 harness.engine 设为 cli）。";
    }
    const selector = this.options.modelResolver
      ? session.selectedModel
      : coreModelSelector(this.options.config.harness, session.selectedModel);
    const freeSelection = isOpenRouterFreeSelector(selector);
    const effort = session.thinkingEffort?.split(":").at(-1);
    const freeRequirements = { preferReasoning: !!effort && effort !== "off",
      ...(context.modelGroupModels ? { allowedSelectors: context.modelGroupModels } : {}) };
    const free = freeSelection && this.options.openRouter
      ? this.options.openRouter.resolve(session.selectedModel, freeRequirements)
        ?? await this.options.openRouter.resolveForCall(session.selectedModel!, controller.signal, freeRequirements) : null;
    if (freeSelection && !free) return "免费模型已下架或 OpenRouter Key 未配置，请同步免费分组并重新选择模型。";
    const resolved = free ? { model: free.model, providerId: free.model.provider, modelId: free.model.id, subscription: false } : this.options.modelResolver
      ? await this.options.modelResolver(session)
      : await resolveCoreModel(this.options.config.harness, session.selectedModel, { cwd: session.cwd });
    if (!resolved) {
      return `core 引擎找不到可用模型（${session.selectedModel ?? "default"}）：请在 Pi 里 /login 后重试，或在会话里换一个模型。`;
    }
    const [piAi, agentCore, codingAgent, runtime] = await Promise.all([
      loadPiAi(),
      loadPiAgentCore(),
      loadPiCodingAgent(),
      injectedStreamFn || free ? Promise.resolve(null) : coreHarnessRuntime(this.options.config.harness),
    ]);

    const model = resolved.model as Model<Api>;
    let activeModel = model;
    let activeAgent: Agent | null = null;
    const freeApi = free ? piAi.lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions")) : null;
    const rawStreamFn: StreamFn = free
      ? (async (_requestModel, transcript, options) => {
        // Keep the allocated model through tool loops; only fresh pricing can force a replacement.
        // The session retains the pool selector, while state.model reports the actual execution model.
        const checked = await this.options.openRouter!.resolveForCall(
          `${free.model.provider}/${activeModel.id}`, options?.signal ?? controller.signal, freeRequirements,
        );
        activeModel = checked.model;
        if (activeAgent) activeAgent.state.model = activeModel;
        state.model = activeModel.id;
        const requestThinking = thinkingLevelFor(piAi.clampThinkingLevel, activeModel, session.thinkingEffort);
        return (injectedStreamFn ?? freeApi!.streamSimple)(activeModel, transcript, {
          ...options,
          maxTokens: Math.min(options?.maxTokens ?? activeModel.maxTokens, activeModel.maxTokens),
          reasoning: requestThinking === "off" ? undefined : requestThinking as ThinkingLevel,
          apiKey: checked.apiKey,
          onPayload: async (payload, model) => {
            const customized = await options?.onPayload?.(payload, model) ?? payload;
            return { ...(customized as Record<string, unknown>), provider: OPENROUTER_FREE_ROUTING };
          },
        });
      })
      : injectedStreamFn ?? ((requestModel, transcript, options) => runtime!.streamSimple(requestModel, transcript, options));
    const streamFn: StreamFn = (requestModel, transcript, options) => {
      controller.signal.throwIfAborted();
      const stream = rawStreamFn(requestModel, transcript, {
        ...options, signal: options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
      });
      return stream;
    };
    const thinkingLevel = thinkingLevelFor(piAi.clampThinkingLevel, model, session.thinkingEffort);
    const settings = session.piSettings ?? defaultPiSessionSettings(this.options.config.harness?.compaction?.enabled ?? true);
    const decision = settings.localDecision ? this.options.decisionAccess?.() ?? null : null;
    // Once compaction/inference can begin, a failure is not a safe replay signal.
    accepted();
    // 上下文压缩：阈值可配（config.harness.compaction），历史不删，只按切点 + 摘要重建模型上下文。
    const transcript = await planContext({
      session,
      model,
      streamFn,
      thinkingLevel,
      signal: controller.signal,
      settings: { ...compactionSettings(this.options.config, codingAgent.DEFAULT_COMPACTION_SETTINGS), enabled: settings.autoCompaction },
      convertToLlm: codingAgent.convertToLlm,
      generateSummary: codingAgent.generateSummaryWithUsage,
      estimateTokens: codingAgent.estimateTokens,
      shouldCompact: codingAgent.shouldCompact,
      state,
    });
    const tools = this.buildTools(session, context, codingAgent, piAi.Type, decision);
    const agent = new agentCore.Agent({
      convertToLlm: codingAgent.convertToLlm,
      initialState: {
        systemPrompt: buildCoreSystemPrompt(session),
        model,
        thinkingLevel,
        messages: transcript.messages,
        tools,
      },
      streamFn,
      toolExecution: "parallel",
    });
    activeAgent = agent;
    if (free) agent.state.model = activeModel;
    register(agent);

    let turnError: string | null = null;
    let extensionHost: CoreExtensionHost | null = null;
    if (settings.codemode !== "off" || settings.globalTools || settings.goalMode) {
      extensionHost = await createCoreExtensionHost({ pi: codingAgent, ai: piAi,
        config: this.options.config, target: session, settings, systemPrompt: buildCoreSystemPrompt(session),
        agent, messages: transcript.messages, tools, runtime, externalStreamAuth: !!injectedStreamFn || !!free,
        onNotice: (text) => {
          state.blocks.push({ type: "text", text });
          if (observer.isActive()) observer.onUpdate(state);
        },
      });
    }
    if (extensionHost) register(agent, () => extensionHost!.interrupt());
    const handleEvent = (event: unknown) => {
      const record = event as unknown as Record<string, unknown>;
      const mapped = applyCoreAgentEvent(state, record);
      if (mapped) turnError = mapped;
      if (!observer.isActive()) return;
      observer.onEvent?.(record);
      observer.onUpdate(state);
    };
    const unsubscribe = extensionHost ? extensionHost.session.subscribe(handleEvent) : agent.subscribe(handleEvent);

    try {
      if (controller.signal.aborted) { extensionHost?.interrupt(); return null; }
      if (extensionHost) {
        await extensionHost.session.prompt(context.prompt);
        await extensionHost.session.waitForIdle();
      } else {
        await agent.prompt({ role: "user", content: [{ type: "text", text: context.prompt }], timestamp: Date.now() });
        await agent.waitForIdle();
      }
    } finally {
      unsubscribe();
      if (extensionHost) {
        try { state.harnessExtensionState = extensionHost.capture(); }
        finally { await extensionHost.close(); }
      }
    }

    const finalModel = free ? activeModel : agent.state.model as Model<Api> | undefined;
    if (typeof finalModel?.id === "string" && finalModel.id) state.model = finalModel.id;
    const usage = contextUsageOf(codingAgent.estimateTokens, finalModel, agent.state.messages as AgentMessage[]);
    state.contextUsage = usage
      ? { ...usage, ...(state.compaction ? { compactions: state.compaction.compactions } : {}) }
      : undefined;
    if (controller.signal.aborted) return null;
    return turnError;
  }

  private buildTools(
    session: SessionSnapshot,
    context: StructuredRunnerContext,
    codingAgent: Awaited<ReturnType<typeof loadPiCodingAgent>>,
    type: typeof import("@earendil-works/pi-ai").Type,
    decision: DecisionRuntimeAccess | null,
  ): AgentTool[] {
    const env = context.env ?? buildChildEnv(this.options.config.inheritEnv !== false);
    // Wand 自有工具中只有本地决策在 core 下接成进程内工具（同一进程直接调决策服务）；
    // 员工知识仍走既有环境变量与脚本路径，本轮不改。
    const tools = codingAgent.createCodingTools(session.cwd, {
      bash: {
        // core 不是 Pi CLI，不暴露 PI_SESSION_* 元数据；环境沿用会话的继承规则。
        exposeSessionEnvironment: false,
        spawnHook: (spawnContext) => ({ ...spawnContext, env: { ...env, ...spawnContext.env } }),
      },
    }) as unknown as AgentTool[];
    const selected = session.piSettings?.tools ?? ["read", "bash", "edit", "write"];
    // Optional search tools use the same SDK implementations; omitted tools are not callable from CodeMode.
    const extra = { grep: codingAgent.createGrepTool, find: codingAgent.createFindTool, ls: codingAgent.createLsTool };
    for (const name of selected) {
      if (name in extra) tools.push(extra[name as keyof typeof extra](session.cwd) as unknown as AgentTool);
    }
    const active = tools.filter((tool) => selected.includes(tool.name as typeof selected[number]));
    if (decision?.evaluate) active.push(buildDecisionTool(decision, type, session.id) as AgentTool);
    return active;
  }
}

/** 上下文占用：以上游 chars/4 估算为准（保守高估），窗口取当前模型的 contextWindow。 */
function contextUsageOf(
  estimateTokens: (message: AgentMessage) => number,
  model: Model<Api> | undefined,
  messages: readonly AgentMessage[],
): StructuredContextUsage | undefined {
  const windowTokens = typeof model?.contextWindow === "number" ? model.contextWindow : 0;
  if (!windowTokens) return undefined;
  let usedTokens = 0;
  for (const message of messages) {
    try {
      usedTokens += estimateTokens(message);
    } catch {
      // 未知角色不参与估算。
    }
  }
  return {
    usedTokens,
    windowTokens,
    percent: Math.min(100, Math.round((usedTokens / windowTokens) * 1000) / 10),
  };
}

type ClampThinkingLevel = (model: Model<Api>, level: ModelThinkingLevel) => ModelThinkingLevel;

/**
 * Wand 自有工具：本地决策（进程内）。
 * 同进程直接调决策服务，不经过 env token / HTTP 回环；
 * `questions` 用 JSON 字符串传递，避开各家 provider 对嵌套 schema 的差异，
 * 也把校验交给服务端的有界校验器（1–8 题、每题 2–8 项、总请求≤32KiB）。
 */
export function buildDecisionTool(
  decision: DecisionRuntimeAccess,
  type: typeof import("@earendil-works/pi-ai").Type,
  sessionId: string,
): AgentTool {
  return {
    name: "decision_evaluate",
    label: "本地决策",
    description: [
      "用本机离线判断模型做有界判断（选一个 / 评分 / 是非），适用于明确的取舍与分类。",
      "适合：在给定选项里选一个、按档位打分、对一句话做是否判断。不适合：开放式推理、写代码、需要外部事实的问题。",
      "结果是概率参考，不是正确率、也不是操作授权；关键取舍仍需你自己说明理由。",
      "questions 传 JSON 字符串，形如 { q1: { type: noul, instructions: … } }；",
      "type 可选 choice（criteria 为 {选项名:说明}，2–8 项）、score（criteria 为档位说明数组，2–8 项）、noul（是非判断）。",
      "最多 8 题、每题最多 8 项，state 与 questions 合计不超过 32KiB。",
    ].join(" "),
    parameters: type.Object({
      state: type.String({ description: "参与判断的事实/上下文；越具体越好，不要包含凭据" }),
      questions: type.String({ description: "JSON 字符串：题目 id → {type, instructions, criteria?}" }),
    }),
    execute: async (_id, params, signal) => {
      const raw = params as { state?: unknown; questions?: unknown };
      const state = typeof raw.state === "string" ? raw.state : "";
      const questionsText = typeof raw.questions === "string" ? raw.questions.trim() : "";
      if (!questionsText) {
        return { content: [{ type: "text", text: "decision_evaluate 需要 questions（JSON 字符串）。" }], isError: true, details: { code: "INVALID_REQUEST" } };
      }
      let questions: unknown;
      try {
        questions = JSON.parse(questionsText);
      } catch {
        return {
          content: [{ type: "text", text: "questions 不是合法 JSON；请传形如 { q1: { type: noul, instructions: … } } 的字符串。" }],
          isError: true,
          details: { code: "INVALID_REQUEST" },
        };
      }
      if (!decision.evaluate) {
        return { content: [{ type: "text", text: "本地决策不可用（进程内入口未装配）。" }], isError: true, details: { code: "UNAVAILABLE" } };
      }
      try {
        const result = await decision.evaluate({ state, questions }, `core:${sessionId}`, signal);
        // content 保持纯 JSON：模型能读，卡片摘要（decision-tool）也靠它解析出结论。
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { model: result.model, usage: result.usage, experimental: true },
        };
      } catch (error) {
        const message = getErrorMessage(error);
        return { content: [{ type: "text", text: `本地决策调用失败：${message}` }], isError: true, details: { code: "DECISION_FAILED" } };
      }
    },
  } as AgentTool;
}/**
 * Wand 的思考档 → 当前模型真正支持的档位。
 * Wand 的 off/standard/deep/max 是历史四档，`provider:level` 是原生档；
 * 最终一律交给上游 clamp，避免把不支持的档位发给 provider。
 */
export function thinkingLevelFor(clamp: ClampThinkingLevel, model: Model<Api>, effort: SessionSnapshot["thinkingEffort"]): ModelThinkingLevel {
  const raw = typeof effort === "string" ? effort : "";
  const native = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
  const mapped = native === "standard" ? "low"
    : native === "deep" ? "high"
    : native === "max" ? "max"
    : native === "" ? "off"
    : native;
  const allowed = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  return clamp(model, (allowed.has(mapped) ? mapped : "off") as ModelThinkingLevel);
}

/** 压缩预算：config.harness.compaction 覆盖上游默认值。 */
export function compactionSettings(
  config: WandConfig,
  defaults: { enabled: boolean; reserveTokens: number; keepRecentTokens: number },
): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
  const override = config.harness?.compaction;
  return {
    enabled: override?.enabled ?? defaults.enabled,
    reserveTokens: override?.reserveTokens ?? defaults.reserveTokens,
    keepRecentTokens: override?.keepRecentTokens ?? defaults.keepRecentTokens,
  };
}

interface PlanContextOptions {
  session: SessionSnapshot;
  model: Model<Api>;
  streamFn: StreamFn;
  thinkingLevel: ModelThinkingLevel;
  signal: AbortSignal;
  settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  convertToLlm: typeof import("@earendil-works/pi-coding-agent").convertToLlm;
  generateSummary: typeof import("@earendil-works/pi-coding-agent").generateSummaryWithUsage;
  estimateTokens: (message: AgentMessage) => number;
  shouldCompact: typeof import("@earendil-works/pi-coding-agent").shouldCompact;
  state: StructuredRunnerTurnState;
}

/** 一条只含文本的用户消息才算“真正的用户输入”：只在该边界切，保证 tool_use / tool_result 不被切开。 */
function currentUserTurnIndex(session: SessionSnapshot, prompt: string): number {
  const turns = session.messages ?? [];
  const last = turns.at(-1);
  const text = last?.content?.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  return last?.role === "user" && text === prompt ? turns.length - 1 : turns.length;
}

function isUserTextTurn(turn: ConversationTurn): boolean {
  if (turn.role !== "user") return false;
  const blocks = turn.content ?? [];
  return blocks.length > 0 && blocks.every((block) => block.type === "text");
}

function estimateMessages(estimateTokens: (message: AgentMessage) => number, messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    try {
      total += estimateTokens(message);
    } catch {
      // 未知角色不参与估算。
    }
  }
  return total;
}

/**
 * 在 turn 空间里找切点：保留预算内最最早的真实用户输入作为切点。
 * 预算内找不到时至少向前推一格（否则超限会话会永远压不下去）；再没办法就返回原切点。
 */
export function findCompactionCut(
  turns: readonly ConversationTurn[],
  from: number,
  keepRecentTokens: number,
  turnTokens: (index: number) => number,
  isUserText: (turn: ConversationTurn) => boolean = isUserTextTurn,
): number {
  let budget = keepRecentTokens;
  let earliestWithin = -1;
  for (let index = turns.length - 1; index > from; index -= 1) {
    const cost = turnTokens(index);
    if (budget - cost < 0) break;
    budget -= cost;
    if (isUserText(turns[index])) earliestWithin = index;
  }
  if (earliestWithin > from) return earliestWithin;
  // 预算内装不下任何完整用户轮次时，至少保留最后一个用户输入：
  // 否则超限会话会卡在同一处反复超限。
  for (let index = turns.length - 1; index > from; index -= 1) {
    if (isUserText(turns[index])) return index;
  }
  return from;
}

/**
 * 决定本轮的模型上下文：先按持久化的切点重建，超阈值就压缩更早的历史。
 * 压缩只影响模型看到的上下文：Wand 的会话历史不删，客户端也不因此变。
 */
async function planContext(options: PlanContextOptions): Promise<{ messages: AgentMessage[] }> {
  const { session, state, estimateTokens, settings } = options;
  const turns = session.messages ?? [];
  const prior = session.harnessContext;
  const priorFrom = prior ? Math.max(0, Math.min(prior.fromTurnIndex, turns.length)) : 0;
  const current = coreMessagesFromTurns(session, { from: priorFrom, summary: prior?.summary });
  if (!settings.enabled || turns.length === 0) return { messages: current };

  const tokensBefore = estimateMessages(estimateTokens, current);
  const windowTokens = options.model.contextWindow;
  if (!options.shouldCompact(tokensBefore, windowTokens, settings)) return { messages: current };

  const turnCost = new Map<number, number>();
  const costOf = (index: number): number => {
    const cached = turnCost.get(index);
    if (cached !== undefined) return cached;
    const cost = estimateMessages(estimateTokens, coreMessagesFromTurns(session, { from: index, until: index + 1 }));
    turnCost.set(index, cost);
    return cost;
  };
  const cut = findCompactionCut(turns, priorFrom, settings.keepRecentTokens, costOf);
  if (cut <= priorFrom) return { messages: current };

  const span = coreMessagesFromTurns(session, { from: priorFrom, until: cut });
  if (span.length === 0) return { messages: current };
  const summarized = await options.generateSummary(
    options.convertToLlm(span),
    options.model,
    settings.reserveTokens,
    undefined,
    undefined,
    options.signal,
    undefined,
    prior?.summary,
    options.thinkingLevel as ThinkingLevel,
    options.streamFn,
  );
  const summary = summarized.text?.trim();
  if (!summary) return { messages: current };
  const messages = coreMessagesFromTurns(session, { from: cut, summary });
  const droppedMessages = span.length;
  state.compaction = {
    reason: "threshold",
    tokensBefore,
    tokensAfter: estimateMessages(estimateTokens, messages),
    summary,
    fromTurnIndex: cut,
    droppedMessages,
    compactions: (prior?.compactions ?? 0) + 1,
    ...(usageFromPi(summarized.usage) ? { usage: usageFromPi(summarized.usage) } : {}),
  };
  return { messages };
}

/**
 * core 会话的基础系统提示。 * Wand 拥有它：不再依赖外部 CLI 的默认提示词，也不再往别人的提示词后面追加。
 * 会话级 systemPrompt / 员工角色 / 本轮知识由 buildCoreSystemPrompt 接在后面。
 */
export const CORE_BASE_SYSTEM_PROMPT = [
  "你是 Wand 托管的一个编码会话。Wand 是本地 AI 工作台，你在一台真实机器上、在给定的工作目录里工作。",
  "",
  "工作方式：",
  "- 先看清楚再动手：读文件、搜代码、看目录，不要凭猜测改代码。",
  "- 需要运行命令、读文件、改文件时用提供的工具；互不依赖的调用可以一次并行发起。",
  "- 改完要给出结论：改了什么、验证了什么、还剩什么没做。没有验证过的不要说已验证。",
  "- 工具报错如实说明，不要编造成功，也不要伪造命令输出、文件内容或测试结果。",
  "- 除非用户要求，不要写总结文档、不要提交 git、不要改工作目录之外的文件。",
  "",
  "交流方式：",
  "- 默认用中文，先结论后证据，简洁直接。",
  "- 引用代码带文件路径与关键行；长内容不要整段复述。",
  "- 缺少必要信息时先问，不要自行假设关键取舍。",
].join("\n");

/** 基础提示 + 会话级系统提示（角色/规则/本轮知识）。 */
export function buildCoreSystemPrompt(session: Pick<SessionSnapshot, "systemPrompt" | "runtimeSystemPrompt">): string {
  const sessionPrompt = [session.systemPrompt?.trim(), session.runtimeSystemPrompt?.trim()].filter(Boolean).join("\n\n");
  return sessionPrompt ? `${CORE_BASE_SYSTEM_PROMPT}\n\n---\n\n${sessionPrompt}` : CORE_BASE_SYSTEM_PROMPT;
}
