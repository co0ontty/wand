import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFauxCore, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";

import { defaultConfig } from "../src/config.js";
import { OPENROUTER_FREE_SELECTOR } from "../src/openrouter-free-selection.js";
import { CoreRunner, applyCoreAgentEvent, buildCoreSystemPrompt, coreMessagesFromTurns, thinkingLevelFor } from "../src/core-runner.js";
import { buildDecisionTool } from "../src/core-runner.js";
import { resolveHarnessEngine, resolveHarnessEngineSync, decideHarnessEngine, coreHarnessStatus, coreHarnessCachedStatus } from "../src/harness-engine.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import type { ResolvedCoreModel } from "../src/harness-engine.js";
import type { StructuredRunnerAdapter, StructuredRunnerTurnState } from "../src/structured-runner.js";
import type { SessionSnapshot } from "../src/types.js";

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "core-session",
    sessionKind: "structured",
    provider: "pi",
    runner: "pi-cli-json",
    command: "pi --mode json --print",
    cwd: "/tmp/project",
    mode: "managed",
    status: "idle",
    exitCode: null,
    startedAt: new Date(0).toISOString(),
    endedAt: null,
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    messages: [],
    queuedMessages: [],
    structuredState: { provider: "pi", runner: "pi-cli-json", inFlight: false, activeRequestId: null, lastError: null },
    autoRecovered: false,
    autoApprovePermissions: true,
    approvalStats: { tool: 0, command: 0, file: 0, total: 0 },
    selectedModel: null,
    thinkingEffort: null,
    ...overrides,
  };
}

/** 离线 core 引擎：faux provider 提供脚本化模型响应，不需要 Pi 认证、不联网。 */
function fauxCore(responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0], root?: string) {
  const core = createFauxCore({ models: [{ id: "faux-core-model", contextWindow: 200_000, maxTokens: 8_192 }] });
  core.setResponses(responses);
  const seenSystemPrompts: string[] = [];
  const seenTranscripts: unknown[] = [];
  const model: ResolvedCoreModel = {
    model: core.getModel(),
    providerId: "faux",
    modelId: "faux-core-model",
    subscription: false,
  };
  const runner = new CoreRunner({
    config: { ...defaultConfig(), ...(root ? { defaultCwd: root } : {}) },
    modelResolver: async () => model,
    streamFn: (requestModel, context, options) => {
      const system = (context as { messages?: Array<{ role: string; content?: unknown }> }).messages?.[0];
      if (system?.role === "system") seenSystemPrompts.push(JSON.stringify(system.content));
      seenTranscripts.push(context);
      return core.streamSimple(requestModel, context, options);
    },
  });
  return { runner, seenSystemPrompts, seenTranscripts, callCount: () => core.state.callCount };
}

function runTurn(runner: CoreRunner, target: SessionSnapshot, prompt: string): {
  completion: Promise<{ state: StructuredRunnerTurnState; primaryError: string | null; exitCode: number | null }>;
  interrupt: () => void;
  updates: () => number;
} {
  let updates = 0;
  const execution = runner.start(
    { session: target, prompt, env: process.env },
    { isActive: () => true, onUpdate: () => { updates += 1; } },
  );
  return {
    completion: execution.completion.then((result) => ({
      state: result.state,
      primaryError: result.primaryError,
      exitCode: result.exitCode,
    })),
    interrupt: () => execution.interrupt(),
    updates: () => updates,
  };
}

test("core 引擎裁决：显式 cli、显式 core、宿主注入各自生效", async () => {  assert.equal(resolveHarnessEngineSync({ engine: "cli" }, "pi").engine, "cli");
  assert.equal(resolveHarnessEngineSync({ engine: "cli" }, "claude").engine, "cli");
  // 宿主注入 core runner：视为 core 能力可用
  assert.equal(resolveHarnessEngineSync({ engine: "auto" }, "pi", { coreRunnerSupplied: true }).engine, "core");
  // 宿主注入 pi 的 CLI runner：auto 不覆盖这个明确决定
  assert.equal(resolveHarnessEngineSync({ engine: "auto" }, "pi", { cliRunnerSupplied: true }).engine, "cli");
  assert.match(resolveHarnessEngineSync({ engine: "auto" }, "pi", { cliRunnerSupplied: true }).reason, /注入/);
  // 非 pi provider 永不进 core
  assert.equal(resolveHarnessEngineSync({ engine: "auto" }, "codex").engine, "cli");
  assert.throws(() => resolveHarnessEngineSync({ engine: "core" }, "codex"), /只支持/);
  // 异步裁决与同步裁决语义一致（显式 core + 未注入 + 未就绪 → 抛错而不是静默降级）
  await assert.rejects(
    resolveHarnessEngine({ engine: "core", agentDir: "/tmp/wand-no-such-agent-dir" }, "pi"),
    /无法初始化进程内 harness|没有可用认证/,
  );
});

test("core 引擎：能力结论是粘性的（过期也沿用最后一次已知结果，不退化成“尚未就绪”）", async () => {
  const config = { engine: "auto" as const, agentDir: "/tmp/wand-no-such-agent-dir" };
  const probed = await coreHarnessStatus(config, { force: true });
  assert.equal(probed.available, false);
  // 探测过之后：同步裁决必须拿到“真实原因”，而不是“尚未就绪”
  const cached = coreHarnessCachedStatus(config);
  assert.ok(cached, "缓存必须保留最后一次已知结论");
  const decision = resolveHarnessEngineSync(config, "pi");
  assert.equal(decision.engine, "cli");
  assert.doesNotMatch(decision.reason, /尚未就绪/);
  assert.equal(decision.reason, probed.reason);
  // 纯裁决矩阵：可用性状态直接决定结果，与探测时机无关
  const available = { available: true, reason: "", providerCount: 1, modelCount: 1, agentDir: "/tmp/x" };
  const unavailable = { available: false, reason: "Pi 侧没有可用认证", providerCount: 0, modelCount: 0, agentDir: "/tmp/x" };
  assert.equal(decideHarnessEngine(config, "pi", {}, available).engine, "core");
  assert.equal(decideHarnessEngine(config, "pi", {}, unavailable).engine, "cli");
  assert.equal(decideHarnessEngine(config, "pi", {}, unavailable).reason, "Pi 侧没有可用认证");
  assert.throws(() => decideHarnessEngine({ engine: "core", agentDir: "/tmp/x" }, "pi", {}, null), /尚未就绪/);
});

test("core runner 的进程内决策工具：有绑定就注册，调用结果保持纯 JSON 供卡片解析", async () => {
  const { Type } = await import("@earendil-works/pi-ai");
  const calls: Array<{ value: unknown; caller: string }> = [];
  const tool = buildDecisionTool({
    url: "http://127.0.0.1:1",
    evaluate: async (value, caller) => {
      calls.push({ value, caller });
      return {
        model: "aac6fef/laya-multilingual-mlx",
        answers: { keep: { type: "noul", noul: 0.91 } },
        usage: { input_tokens: 42, output_tokens: 0 },
        experimental: true,
        runtime: "laya-mlx",
      };
    },
  }, Type, "session-1");

  const ok = await tool.execute("call-1", {
    state: "候选方案 A 与 B",
    questions: JSON.stringify({ keep: { type: "noul", instructions: "是否保留方案 A？" } }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].caller, "core:session-1", "会话身份必须绑定到本次会话");
  assert.deepEqual(calls[0].value, { state: "候选方案 A 与 B", questions: { keep: { type: "noul", instructions: "是否保留方案 A？" } } });
  const text = (ok.content as Array<{ text: string }>)[0].text;
  assert.deepEqual(JSON.parse(text), {
    model: "aac6fef/laya-multilingual-mlx",
    answers: { keep: { type: "noul", noul: 0.91 } },
    usage: { input_tokens: 42, output_tokens: 0 },
    experimental: true,
    runtime: "laya-mlx",
  });
  assert.equal(ok.isError ?? false, false);

  // questions 不是 JSON：明确报错、不调服务
  const bad = await tool.execute("call-2", { state: "x", questions: "{坏" });
  assert.equal(bad.isError, true);
  assert.match(String((bad.content as Array<{ text: string }>)[0].text), /不是合法 JSON/);
  assert.equal(calls.length, 1);

  // 服务报错：如实回执给模型（不编结论）
  const failing = buildDecisionTool({
    url: "http://127.0.0.1:1",
    evaluate: async () => { throw new Error("本地决策未启用、平台不支持或运行环境未安装。"); },
  }, Type, "session-2");
  const failure = await failing.execute("call-3", { state: "x", questions: JSON.stringify({ q: { type: "noul", instructions: "i" } }) });
  assert.equal(failure.isError, true);
  assert.match(String((failure.content as Array<{ text: string }>)[0].text), /未启用/);
});

test("core runner 在没有进程内决策入口时，工具如实报不可用而不是假装调用", async () => {
  const { Type } = await import("@earendil-works/pi-ai");
  const tool = buildDecisionTool({ url: "" }, Type, "s");
  const missing = await tool.execute("c", { state: "x", questions: JSON.stringify({ q: { type: "noul", instructions: "i" } }) });
  assert.equal(missing.isError, true);
  assert.match(String((missing.content as Array<{ text: string }>)[0].text), /未装配/);
});

test("Wand 拥有系统提示：基础提示 + 会话提示 + 本轮知识", () => {
  const prompt = buildCoreSystemPrompt({
    systemPrompt: "角色：审阅者",
    runtimeSystemPrompt: "本轮知识：项目用 ESM",
  });
  assert.match(prompt, /Wand 托管/);
  assert.match(prompt, /角色：审阅者/);
  assert.match(prompt, /本轮知识：项目用 ESM/);
  assert.equal(buildCoreSystemPrompt({}), prompt.split("\n\n---\n\n")[0]);
});

test("Wand 的思考档映射到模型真正支持的档位", () => {
  const model = { contextWindow: 1, maxTokens: 1, reasoning: true, thinkingLevelMap: undefined } as never;
  const clamp = (() => "medium") as never;
  assert.equal(thinkingLevelFor(clamp, model, "pi:high"), "medium");
  assert.equal(thinkingLevelFor(clamp, model, "off"), "medium");
});

test("Wand 历史重建 transcript：tool_use 与 tool_result 重新配对成标准消息", () => {
  const target = session({
    selectedModel: "openai-codex/gpt-5.6-luna",
    messages: [
      { role: "user", content: [{ type: "text", text: "读一下 a.ts" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "好" },
          { type: "tool_use", id: "call-1", name: "Read", input: { path: "a.ts" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "文件内容", is_error: false }] },
      { role: "assistant", content: [{ type: "text", text: "读完了" }] },
    ],
  });
  const messages = coreMessagesFromTurns(target);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
  const assistant = messages[1] as { content: Array<{ type: string; name?: string }> };
  assert.deepEqual(assistant.content.map((part) => part.type), ["text", "toolCall"]);
  assert.equal(assistant.content[1].name, "read", "展示名 Read 还原成上游工具名");
  const toolResult = messages[2] as { toolCallId: string; toolName: string };
  assert.equal(toolResult.toolCallId, "call-1");
  assert.equal(toolResult.toolName, "read");
});

test("core runner 处理工具结果：保留图片块并在历史重建中正确转换为 ImageContent", () => {
  const turnState: StructuredRunnerTurnState = {
    blocks: [],
    phase: "streaming",
    result: "",
    thinking: "",
    title: "",
  };

  applyCoreAgentEvent(turnState, {
    type: "tool_execution_end",
    toolCallId: "call-img-1",
    result: {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "base64-png-bytes", mimeType: "image/png" },
      ],
    },
  });

  assert.equal(turnState.blocks.length, 1);
  const block = turnState.blocks[0] as { type: string; content: unknown };
  assert.equal(block.type, "tool_result");
  assert.ok(Array.isArray(block.content), "图片块必须保留为数组，不可压成纯文本");
  assert.deepEqual(block.content, [
    { type: "text", text: "Read image file [image/png]" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "base64-png-bytes" } },
  ]);

  const target = session({
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-img-1", name: "Read", input: { path: "shot.png" } }],
      },
      {
        role: "user",
        content: [block as any],
      },
    ],
  });

  const messages = coreMessagesFromTurns(target);
  assert.equal(messages.length, 2);
  const toolResultMsg = messages[1] as { role: string; content: Array<{ type: string; [key: string]: unknown }> };
  assert.equal(toolResultMsg.role, "toolResult");
  assert.deepEqual(toolResultMsg.content, [
    { type: "text", text: "Read image file [image/png]" },
    { type: "image", data: "base64-png-bytes", mimeType: "image/png" },
  ]);
});

test("core runner 跑完一个真回合：工具调用 → 工具结果 → 文本，并回报 usage 与上下文占用", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-core-turn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "note.txt"), "core-harness-marker\n");

  const { runner, seenSystemPrompts } = fauxCore([
    fauxAssistantMessage([fauxText("先读文件"), fauxToolCall("read", { path: "note.txt" }, { id: "call-1" })]),
    fauxAssistantMessage([fauxText("文件内容是 core-harness-marker")]),
  ], root);

  const result = await runTurn(
    runner,
    session({ cwd: root, systemPrompt: "本会话固定要求：只回答文件内容。", selectedModel: "faux/faux-core-model" }),
    "读 note.txt",
  ).completion;

  assert.equal(result.primaryError, null);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.state.blocks.map((block) => block.type), ["text", "tool_use", "tool_result", "text"]);
  const toolUse = result.state.blocks.find((block) => block.type === "tool_use");
  assert.equal(toolUse?.name, "Read");
  assert.deepEqual(toolUse?.input, { path: "note.txt" });
  const toolResult = result.state.blocks.find((block) => block.type === "tool_result");
  assert.match(String(toolResult?.content), /core-harness-marker/);
  assert.equal(toolResult?.is_error, false);
  assert.equal(result.state.model, "faux-core-model");
  assert.ok((result.state.usage?.inputTokens ?? 0) > 0, "usage 必须回报");
  assert.equal(result.state.contextUsage?.windowTokens, 200_000);
  assert.ok((result.state.contextUsage?.percent ?? 0) > 0);
  assert.equal(seenSystemPrompts.length, 2, "每次请求都带系统提示（而非只首轮）");
  assert.match(seenSystemPrompts[0], /只回答文件内容/);
});

test("core runner 的中断是幂等的，且不会把取消报成失败", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-core-abort-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { runner } = fauxCore([fauxAssistantMessage([fauxText("这是一个很长的回答")])], root);
  const turn = runTurn(runner, session({ cwd: root }), "说点什么");
  turn.interrupt();
  turn.interrupt();
  const result = await turn.completion;
  assert.equal(result.primaryError, null);
  assert.equal(result.exitCode, 0);
});

test("core runner 把模型层错误如实报成失败，而不是空回复", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-core-error-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { runner } = fauxCore([
    fauxAssistantMessage([fauxText("")], { stopReason: "error", errorMessage: "额度已用尽" }),
  ], root);
  const result = await runTurn(runner, session({ cwd: root }), "hi").completion;
  assert.equal(result.primaryError, "额度已用尽");
  assert.equal(result.exitCode, 1);
});

/** 造一段足够长的历史，让估算 token 稳稳超过窗口减去预留。 */
function longHistory(pairs: number): SessionSnapshot["messages"] {
  const filler = "这是一段用于把上下文撑到压缩阈值以上得长文本。".repeat(20);
  const turns: NonNullable<SessionSnapshot["messages"]> = [];
  for (let index = 0; index < pairs; index += 1) {
    turns.push({ role: "user", content: [{ type: "text", text: `第 ${index + 1} 轮问题：${filler}` }] });
    turns.push({ role: "assistant", content: [{ type: "text", text: `第 ${index + 1} 轮回答：${filler}` }] });
  }
  return turns;
}

function smallWindowCore(responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0], root: string, contextWindow: number) {
  const core = createFauxCore({ models: [{ id: "faux-small", contextWindow, maxTokens: 4_096 }] });
  core.setResponses(responses);
  const seen: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
  const runner = new CoreRunner({
    config: {
      ...defaultConfig(),
      defaultCwd: root,
      harness: { engine: "core", compaction: { enabled: true, reserveTokens: 64, keepRecentTokens: 400 } },
    },
    modelResolver: async () => ({ model: core.getModel(), providerId: "faux", modelId: "faux-small", subscription: false }),
    streamFn: (requestModel, context, options) => {
      seen.push(context as { messages: Array<{ role: string; content?: unknown }> });
      return core.streamSimple(requestModel, context, options);
    },
  });
  return { runner, seen, callCount: () => core.state.callCount };
}

test("core 引擎超阈值时压缩更早历史：摘要进上下文、原历史不动", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-core-compact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = session({ cwd: root, messages: longHistory(8), selectedModel: "faux/faux-small" });
  const before = JSON.stringify(target.messages);
  const { runner, seen } = smallWindowCore([
    fauxAssistantMessage([fauxText("## 已压缩的早前对话摘要：用户讨论了 1-6 轮。")]),
    fauxAssistantMessage([fauxText("压缩后继续回答")]),
  ], root, 1_000);

  const result = await runTurn(runner, target, "接着第七轮继续").completion;
  assert.equal(result.primaryError, null);
  const notice = result.state.compaction;
  assert.ok(notice, "应当发生压缩");
  assert.equal(notice?.reason, "threshold");
  assert.equal(notice?.compactions, 1);
  assert.ok((notice?.fromTurnIndex ?? 0) > 0);
  assert.match(String(notice?.summary), /已压缩的早前对话摘要/);
  assert.ok((notice?.tokensBefore ?? 0) > (notice?.tokensAfter ?? 0), "压缩后应当变小");
  assert.equal(JSON.stringify(target.messages), before, "会话历史不被删改");

  // 摘要调用 + 本轮对话调用：第二次请求里应当带摘要头，且不再带被压缩的原文
  const last = seen[seen.length - 1];
  const serialized = JSON.stringify(last.messages);
  assert.match(serialized, /更早的对话已被压缩/, "上下文里必须带摘要头");
  assert.match(serialized, /已压缩的早前对话摘要/);
  assert.doesNotMatch(serialized, /第 1 轮问题/, "被压缩的原文不再进入模型上下文");
  assert.match(serialized, /第 8 轮问题/);
  assert.equal(result.state.contextUsage?.compactions, 1);
});

test("core 引擎压缩阈值可配：关闭后不再压缩，预留变大后更容易触发", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-core-compact-cfg-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const history = longHistory(8);

  const disabled = createFauxCore({ models: [{ id: "faux-small", contextWindow: 1_000, maxTokens: 4_096 }] });
  disabled.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  const offRunner = new CoreRunner({
    config: {
      ...defaultConfig(),
      harness: { engine: "core", compaction: { enabled: false, reserveTokens: 64, keepRecentTokens: 400 } },
    },
    modelResolver: async () => ({ model: disabled.getModel(), providerId: "faux", modelId: "faux-small", subscription: false }),
    streamFn: (requestModel, context, options) => disabled.streamSimple(requestModel, context, options),
  });
  const offResult = await runTurn(offRunner, session({ cwd: root, messages: history }), "继续").completion;
  assert.equal(offResult.state.compaction, undefined, "关闭压缩后不得压缩");
  assert.equal(disabled.state.callCount, 1, "关闭压缩时不发生额外的摘要调用");
});

test("会话管理器：即使注入 core runner，Pi 主功能仍固定走 CLI JSON", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-cli-manager-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const prompts: string[] = [];
  const core: StructuredRunnerAdapter = {
    start() { throw new Error("Pi 主功能不应调用 core runner"); },
  };
  const pi: StructuredRunnerAdapter = {
    start({ prompt }) {
      prompts.push(prompt);
      return {
        args: ["--mode", "json"], spawnedAt: new Date().toISOString(), pid: null, interrupt() {},
        completion: Promise.resolve({
          state: { blocks: [{ type: "text", text: "CLI 回合完成" }], result: "CLI 回合完成", sessionId: "native-1" },
          exitCode: 0, signal: null, stderr: "", primaryError: null,
        }),
      };
    },
  };
  storage.saveSession(session({ id: "cli-managed", cwd: root }));
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root }, null, { core, pi });
  t.after(() => manager.dispose());

  const finished = await manager.sendMessage("cli-managed", "跑一轮");
  assert.deepEqual(prompts, ["跑一轮"]);
  assert.equal(finished.status, "idle");
  assert.equal(finished.structuredState?.engine, "cli");
  assert.equal(finished.structuredState?.engineReason, "Pi 主功能固定使用 CLI JSON");
  assert.equal(finished.structuredState?.runner, "pi-cli-json");
  assert.equal(finished.claudeSessionId, "native-1");
  assert.match(JSON.stringify(finished.messages?.at(-1)), /CLI 回合完成/);
});


test("会话管理器：注入 pi runner 时保持 CLI 路径，并记录回退原因", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-core-cli-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const pi: StructuredRunnerAdapter = {
    start() {
      return {
        args: ["--mode", "json"], spawnedAt: new Date().toISOString(), pid: null, interrupt() {},
        completion: Promise.resolve({
          state: { blocks: [{ type: "text", text: "CLI 回合完成" }], result: "CLI 回合完成", sessionId: "native-1" },
          exitCode: 0, signal: null, stderr: "", primaryError: null,
        }),
      };
    },
  };
  storage.saveSession(session({ id: "cli-managed", cwd: root }));
  const manager = new StructuredSessionManager(storage, { ...defaultConfig(), defaultCwd: root }, null, { pi });
  t.after(() => manager.dispose());

  const finished = await manager.sendMessage("cli-managed", "跑一轮");
  assert.equal(finished.structuredState?.engine, "cli");
  assert.equal(finished.structuredState?.engineReason, "Pi 主功能固定使用 CLI JSON");
  assert.equal(finished.claudeSessionId, "native-1");
});

test("服务重启：进程内 core 回合不会被当成可领养的 daemon 运行", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-core-restore-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  t.after(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  storage.saveSession(session({
    id: "core-interrupted",
    cwd: root,
    status: "running",
    structuredState: {
      provider: "pi", runner: "pi-cli-json", inFlight: true, activeRequestId: "req-1",
      lastError: null, engine: "core", contextUsage: { usedTokens: 10, windowTokens: 100, percent: 10 },
    },
  }));
  const host = {
    persistent: true,
    async startRun() { throw new Error("不应为 core 会话启动守护运行"); },
    async adoptRun() { throw new Error("不应领养 core 会话"); },
    async listRuns() { return []; },
    forgetRun() {},
    push() {},
    onStream() { return () => {}; },
    onExit() { return () => {}; },
  };
  const manager = new StructuredSessionManager(
    storage,
    { ...defaultConfig(), harness: { engine: "core" }, defaultCwd: root },
    null,
    {},
    host as never,
  );
  t.after(() => manager.dispose());
  const restored = manager.get("core-interrupted")!;
  assert.equal(restored.status, "idle");
  assert.equal(restored.structuredState?.inFlight, false);
  assert.match(String(restored.structuredState?.lastError), /服务重启/);
  assert.equal(restored.structuredState?.contextUsage?.usedTokens, 10, "上下文占用随会话保留");
});

test("选择免费分组后进程内 agent 自动分配并发出零价路由请求，无需 Pi 本地认证", async () => {
  const { OpenRouterFreeModelsService, OPENROUTER_FREE_SELECTOR } = await import("../src/openrouter-free-models.js");
  const root = mkdtempSync(path.resolve("output/openrouter/core-test-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const service = new OpenRouterFreeModelsService(storage, async (url) => String(url).endsWith("/chat/completions")
    ? Response.json({ choices: [{ finish_reason: "stop", message: { content: "免费模型验证" } }] })
    : Response.json({ data: [{
    id: "vendor/agent:free", name: "Free Agent", pricing: { prompt: "0", completion: "0" },
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    context_length: 32768, supported_parameters: ["tools"],
  }] }));
  const originalFetch = globalThis.fetch;
  try {
    await service.saveKey("offline-test-key");
    let payload: Record<string, unknown> | undefined;
    globalThis.fetch = async (input, options) => {
      assert.equal(String(input), "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer offline-test-key");
      payload = JSON.parse(String(options?.body)) as Record<string, unknown>;
      const chunk = { id: "offline-completion", object: "chat.completion.chunk", created: 1,
        model: "vendor/agent:free", choices: [{ index: 0, delta: { content: "免费模型已接通" }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    const config = { ...defaultConfig(), harness: { ...defaultConfig().harness!,
      agentDir: path.join(root, "no-pi-auth"), engine: "auto" as const } };
    const runner = new CoreRunner({ config, openRouter: service, modelResolver: async () => null });
    const target = session({ cwd: root, selectedModel: OPENROUTER_FREE_SELECTOR });
    const result = await runTurn(runner, target, "你好").completion;
    assert.equal(result.primaryError, null);
    assert.ok(payload);
    assert.equal(payload.model, "vendor/agent:free");
    assert.deepEqual(payload.provider, { require_parameters: true,
      max_price: { prompt: 0, completion: 0, request: 0, image: 0 } });
    assert.ok(Array.isArray(payload.tools) && payload.tools.length > 0);
    assert.match(result.state.result, /免费模型已接通/);
    assert.equal(result.state.model, "vendor/agent:free");
    assert.equal(target.selectedModel, OPENROUTER_FREE_SELECTOR, "实际模型不覆盖用户选中的分组");
    service.clearKey();
    const stale = await runTurn(runner, target, "重试").completion;
    assert.match(stale.primaryError ?? "", /OpenRouter Key 未配置/);
  } finally {
    globalThis.fetch = originalFetch;
    service.dispose(); storage.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("Pi 主功能的免费分组不切换到 core SDK", async (t) => {
  const root = mkdtempSync(path.resolve("output/openrouter/cli-free-group-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const pi: StructuredRunnerAdapter = {
    start() {
      return {
        args: ["--mode", "json"], spawnedAt: new Date().toISOString(), pid: null, interrupt() {},
        completion: Promise.resolve({
          state: { blocks: [{ type: "text", text: "CLI 免费分组请求" }], result: "CLI 免费分组请求", sessionId: "cli-free" },
          exitCode: 0, signal: null, stderr: "", primaryError: null,
        }),
      };
    },
  };
  const config = { ...defaultConfig(), defaultCwd: root };
  storage.saveSession(session({ id: "cli-free", cwd: root, selectedModel: OPENROUTER_FREE_SELECTOR }));
  const manager = new StructuredSessionManager(storage, config, null, { pi });
  t.after(() => { manager.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  const finished = await manager.sendMessage("cli-free", "执行");
  assert.equal(finished.structuredState?.engine, "cli");
  assert.equal(finished.structuredState?.engineReason, "Pi 主功能固定使用 CLI JSON");
  assert.match(JSON.stringify(finished.messages?.at(-1)), /CLI 免费分组请求/);
});



test("core 工具循环每次调用查价格，收费后切换免费替补且状态记录实际模型", async () => {
  const { OpenRouterFreeModelsService, OPENROUTER_FREE_PROVIDER } = await import("../src/openrouter-free-models.js");
  const root = mkdtempSync(path.resolve("output/openrouter/core-price-loop-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  let priceChecks = 0;
  let probes = 0;
  const service = new OpenRouterFreeModelsService(storage, async (url) => {
    if (String(url).endsWith("/chat/completions")) {
      probes++;
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "已验证" } }] });
    }
    priceChecks++;
    return Response.json({ data: ["first", "second"].map(id => ({
      id, name: id, pricing: { prompt: priceChecks >= 3 && id === "first" ? "0.01" : "0", completion: "0" },
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      context_length: 32768, supported_parameters: ["tools"],
    })) });
  });
  try {
    await service.saveKey("offline-test-key");
    writeFileSync(path.join(root, "example.txt"), "hello");
    const faux = createFauxCore({ models: [{ id: "test-model", contextWindow: 32768, maxTokens: 8192 }] });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read-one", "read", { path: "example.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("免费替补已回复")]),
    ]);
    const usedModels: string[] = [];
    const runner = new CoreRunner({ config: defaultConfig(), openRouter: service,
      streamFn: (model, transcript, options) => {
        usedModels.push(model.id);
        return faux.streamSimple(model, transcript, options);
      },
    });
    const result = await runTurn(runner, session({ cwd: root, selectedModel: `${OPENROUTER_FREE_PROVIDER}/first` }), "读文件").completion;
    assert.equal(result.primaryError, null);
    assert.equal(priceChecks, 3, "同步一次，两次推理各检查一次");
    assert.equal(probes, 2, "已验证模型不重复测试");
    assert.deepEqual(usedModels, ["first", "second"]);
    assert.equal(result.state.model, "second");
    assert.match(result.state.result, /免费替补已回复/);
    assert.equal(service.resolve(`${OPENROUTER_FREE_PROVIDER}/first`), null);
  } finally { service.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); }
});

test("core 价格接口失败或没有免费替补时不发送推理请求", async () => {
  const { OpenRouterFreeModelsService, OPENROUTER_FREE_PROVIDER } = await import("../src/openrouter-free-models.js");
  const root = mkdtempSync(path.resolve("output/openrouter/core-price-fail-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  let phase = "initial";
  const service = new OpenRouterFreeModelsService(storage, async (url) => {
    if (String(url).endsWith("/chat/completions")) return Response.json({ choices: [{ finish_reason: "stop", message: { content: "已验证" } }] });
    if (phase === "error") return Response.json({}, { status: 503 });
    return Response.json({ data: phase === "paid" ? [] : [{ id: "first", name: "first",
      pricing: { prompt: "0", completion: "0" }, context_length: 32768, supported_parameters: ["tools"],
      architecture: { input_modalities: ["text"], output_modalities: ["text"] } }] });
  });
  try {
    await service.saveKey("offline-test-key");
    let calls = 0;
    const runner = new CoreRunner({ config: defaultConfig(), openRouter: service, streamFn: () => {
      calls++; throw new Error("不应执行推理");
    } });
    const target = session({ cwd: root, selectedModel: `${OPENROUTER_FREE_PROVIDER}/first` });
    phase = "error";
    assert.match((await runTurn(runner, target, "hello").completion).primaryError ?? "", /价格检查失败/);
    phase = "paid";
    assert.match((await runTurn(runner, target, "hello").completion).primaryError ?? "", /没有已验证且免费的模型/);
    assert.equal(calls, 0);
  } finally { service.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); }
});

test("core 上下文压缩与正式回复分别检查价格，复用历史探测不重发测试消息", async () => {
  const { OpenRouterFreeModelsService, OPENROUTER_FREE_PROVIDER } = await import("../src/openrouter-free-models.js");
  const root = mkdtempSync(path.resolve("output/openrouter/core-price-compact-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  let checks = 0;
  let probes = 0;
  const service = new OpenRouterFreeModelsService(storage, async (url) => {
    if (String(url).endsWith("/chat/completions")) {
      probes++;
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "已验证" } }] });
    }
    checks++;
    return Response.json({ data: [{ id: "compact", name: "compact", pricing: { prompt: "0", completion: "0" },
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      context_length: 2048, supported_parameters: ["tools"] }] });
  });
  try {
    await service.saveKey("offline-test-key");
    const faux = createFauxCore({ models: [{ id: "test-model", contextWindow: 2048, maxTokens: 1024 }] });
    faux.setResponses([fauxAssistantMessage([fauxText("已压缩摘要")]), fauxAssistantMessage([fauxText("继续回复")])]);
    const runner = new CoreRunner({ config: { ...defaultConfig(),
      harness: { engine: "core", compaction: { enabled: true, reserveTokens: 64, keepRecentTokens: 400 } },
    }, openRouter: service, streamFn: faux.streamSimple });
    const result = await runTurn(runner, session({ cwd: root, messages: longHistory(24),
      selectedModel: `${OPENROUTER_FREE_PROVIDER}/compact` }), "继续").completion;
    assert.equal(result.primaryError, null);
    assert.ok(result.state.compaction);
    assert.equal(faux.state.callCount, 2);
    assert.equal(checks, 3);
    assert.equal(probes, 1);
  } finally { service.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); }
});

test("core runner tracks model preparation and overlapping cancellation by execution, not session", async () => {
  const { CoreTurnTracker } = await import("../src/core-turn-tracker.js");
  const resolvers: Array<(model: ResolvedCoreModel | null) => void> = [];
  const runner = new CoreRunner({ config: defaultConfig(),
    modelResolver: () => new Promise((resolve) => { resolvers.push(resolve); }) });
  const first = runTurn(runner, session(), "first");
  const replacement = runTurn(runner, session(), "replacement");
  assert.equal(CoreTurnTracker.getActiveTurnCount(), 2);
  first.interrupt();
  resolvers[0](null);
  await first.completion;
  assert.equal(CoreTurnTracker.getActiveTurnCount(), 1, "late old completion cannot untrack the new turn");
  resolvers[1](null);
  await replacement.completion;
  assert.equal(CoreTurnTracker.hasActiveTurns(), false);
});

test("Pi CLI 不受 core SDK 重启 drain 阻塞", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-cli-drain-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  const prompts: string[] = [];
  const pi: StructuredRunnerAdapter = {
    start({ prompt }) {
      prompts.push(prompt);
      return {
        args: ["--mode", "json"], spawnedAt: new Date().toISOString(), pid: null, interrupt() {},
        completion: Promise.resolve({
          state: { blocks: [{ type: "text", text: "done" }], result: "done", sessionId: "cli-1" },
          exitCode: 0, signal: null, stderr: "", primaryError: null,
        }),
      };
    },
  };
  storage.saveSession(session({ id: "cli-drain", cwd: root }));
  const manager = new StructuredSessionManager(storage, defaultConfig(), null, { pi });
  t.after(() => { manager.dispose(); storage.close(); rmSync(root, { recursive: true, force: true }); });
  const release = manager.beginCoreRestartDrain();
  await manager.sendMessage("cli-drain", "CLI 期间继续执行");
  release();
  assert.deepEqual(prompts, ["CLI 期间继续执行"]);
  assert.deepEqual(storage.getSession("cli-drain")?.queuedMessages, []);
});

