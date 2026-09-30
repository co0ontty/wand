import assert from "node:assert/strict";
import test from "node:test";

import { buildClaudeCliArgs, buildSessionSystemPromptParts } from "../src/structured-claude-adapter.js";
import { buildCodexArgs } from "../src/structured-codex-adapter.js";
import { applyOpenCodeEvent, buildOpenCodeArgs } from "../src/structured-opencode-adapter.js";
import { applyGrokEvent, buildGrokArgs } from "../src/structured-grok-adapter.js";
import { buildQoderArgs } from "../src/structured-qoder-adapter.js";
import { buildPiArgs } from "../src/structured-pi-adapter.js";
import { buildGeminiArgs } from "../src/structured-gemini-adapter.js";
import { commandWithSystemPrompt, promptWithSystemFallback } from "../src/structured-provider-common.js";
import type { SessionSnapshot } from "../src/types.js";

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "wand-1",
    sessionKind: "structured",
    provider: "claude",
    runner: "claude-cli-print",
    command: "claude",
    cwd: "/repo",
    mode: "assist",
    status: "idle",
    exitCode: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    ...overrides,
  };
}

test("Codex adapter emits permission, model, effort, and resume arguments in protocol order", () => {
  assert.deepEqual(buildCodexArgs(session({
    provider: "codex",
    runner: "codex-cli-exec",
    mode: "agent",
    selectedModel: "gpt-5.4",
    thinkingEffort: "max",
    claudeSessionId: "thread-1",
  })), [
    "exec", "--json", "--color", "never",
    "--sandbox", "workspace-write",
    "--skip-git-repo-check",
    "--model", "gpt-5.4",
    "-c", "model_reasoning_effort=xhigh",
    "resume", "thread-1", "-",
  ]);

  assert.ok(buildCodexArgs(session({ mode: "managed" })).includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("Claude adapter keeps variadic permission flags ahead of all following flags", () => {
  assert.deepEqual(buildClaudeCliArgs(session({
    mode: "managed",
    selectedModel: "claude-opus-4-6",
    thinkingEffort: "deep",
    claudeSessionId: "session-1",
  }), {
    permissionPolicy: { permissionMode: "acceptEdits", allowedTools: ["Read", "mcp__figma"] },
    systemPromptParts: ["work independently", "reply in Chinese"],
  }), [
    "-p", "--verbose", "--output-format", "stream-json",
    "--permission-mode", "acceptEdits",
    "--allowedTools", "Read", "mcp__figma",
    "--append-system-prompt", "work independently",
    "--append-system-prompt", "reply in Chinese",
    "--model", "claude-opus-4-6",
    "--effort", "medium",
    "--disallowedTools", "AskUserQuestion",
    "--resume", "session-1",
  ]);
});

test("OpenCode adapter maps args and stream events without session lifecycle state", () => {
  assert.deepEqual(buildOpenCodeArgs(session({
    provider: "opencode",
    runner: "opencode-cli-run",
    mode: "auto-edit",
    selectedModel: "anthropic/claude-sonnet-4-6",
    thinkingEffort: "opencode:ultra",
    claudeSessionId: "oc-1",
  })), [
    "run", "--format", "json", "--thinking",
    "--model", "anthropic/claude-sonnet-4-6",
    "--variant", "ultra",
    "--auto",
    "--session", "oc-1",
  ]);

  const state = { blocks: [], result: "", sessionId: null };
  assert.equal(applyOpenCodeEvent(state, {
    type: "tool_use",
    sessionID: "oc-2",
    part: { tool: "shell", state: { title: "Run tests", input: { command: "npm test" }, output: "ok" } },
  }, () => "generated-id"), null);
  assert.equal(state.sessionId, "oc-2");
  assert.deepEqual(state.blocks, [
    { type: "tool_use", id: "generated-id", name: "Bash", description: "Run tests", input: { command: "npm test" } },
    { type: "tool_result", tool_use_id: "generated-id", content: "ok", is_error: false },
  ]);

  assert.equal(applyOpenCodeEvent(state, { type: "error", error: { message: { text: "boom" } } }), "boom");
});

test("Grok adapter maps official streaming-json chunks, usage, and resume arguments", () => {
  assert.deepEqual(buildGrokArgs(session({
    provider: "grok",
    runner: "grok-cli-headless",
    mode: "managed",
    selectedModel: "grok-4.5",
    thinkingEffort: "deep",
    claudeSessionId: "grok-session-1",
  }), "hello"), [
    "--no-auto-update", "-p", "hello", "--output-format", "streaming-json",
    "--model", "grok-4.5", "--effort", "high", "--always-approve",
    "--resume", "grok-session-1",
  ]);
  assert.deepEqual(buildGrokArgs(session({
    provider: "grok",
    runner: "grok-cli-headless",
    thinkingEffort: "max",
  }), "hello").slice(-2), ["--effort", "xhigh"]);

  const state = { blocks: [], result: "", sessionId: null };
  applyGrokEvent(state, { type: "thought", data: "checking" });
  applyGrokEvent(state, { type: "text", data: "WAND" });
  applyGrokEvent(state, { type: "text", data: "_OK" });
  assert.equal(applyGrokEvent(state, {
    type: "end",
    sessionId: "grok-session-2",
    usage: { input_tokens: 10, output_tokens: 4, reasoning_tokens: 2, cache_read_input_tokens: 3 },
    total_cost_usd: 0.25,
  }), null);
  assert.equal(state.sessionId, "grok-session-2");
  assert.equal(state.result, "WAND_OK");
  assert.deepEqual(state.blocks, [
    { type: "thinking", thinking: "checking" },
    { type: "text", text: "WAND_OK" },
  ]);
  assert.deepEqual(state.usage, {
    inputTokens: 10,
    outputTokens: 4,
    reasoningOutputTokens: 2,
    cacheReadInputTokens: 3,
    totalCostUsd: 0.25,
  });
  assert.equal(applyGrokEvent(state, { type: "error", message: "boom" }), "boom");

  const tools = { blocks: [], result: "", sessionId: null };
  applyGrokEvent(tools, {
    type: "tool_call",
    toolCallId: "call_1",
    title: "Read",
    kind: "read",
    status: "in_progress",
    toolName: "read_file",
    rawInput: { path: "src/main.rs" },
  });
  applyGrokEvent(tools, {
    type: "tool_call_update",
    toolCallId: "call_1",
    status: "completed",
    rawOutput: { lines: 42 },
  });
  applyGrokEvent(tools, {
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
  });
  assert.equal(tools.result, "ok");
  assert.deepEqual(tools.blocks, [
    { type: "tool_use", id: "call_1", name: "Read", description: "Read", input: { path: "src/main.rs" } },
    { type: "tool_result", tool_use_id: "call_1", content: "{\"lines\":42}", is_error: false },
    { type: "text", text: "ok" },
  ]);

  const bash = { blocks: [], result: "", sessionId: null };
  applyGrokEvent(bash, {
    type: "tool_call_update",
    toolCallId: "call_bash",
    status: "completed",
    toolName: "run_terminal_command",
    rawOutput: {
      type: "Bash",
      output: [119, 97, 110, 100, 45, 111, 107, 10],
      output_for_prompt: "exit: 0\nwand-ok\n",
      exit_code: 0,
    },
  });
  assert.deepEqual(bash.blocks, [
    { type: "tool_use", id: "call_bash", name: "Bash", description: undefined, input: {} },
    { type: "tool_result", tool_use_id: "call_bash", content: "exit: 0\nwand-ok\n", is_error: false },
  ]);
});

test("Qoder adapter emits print, model, permission, and resume arguments", () => {
  assert.deepEqual(buildQoderArgs(session({
    provider: "qoder",
    runner: "qoder-cli-print",
    mode: "managed",
    selectedModel: "performance",
    claudeSessionId: "qoder-session-1",
  }), "hello"), [
    "-p", "hello", "--output-format", "stream-json",
    "--model", "performance",
    "--permission-mode", "bypass_permissions",
    "-r", "qoder-session-1",
  ]);

  // 无论选择哪种模式，Qoder 都以 yolo（bypass_permissions）启动，PTY 与结构化一致。
  assert.deepEqual(buildQoderArgs(session({
    provider: "qoder",
    runner: "qoder-cli-print",
    mode: "default",
  }), "hello"), [
    "-p", "hello", "--output-format", "stream-json",
    "--permission-mode", "bypass_permissions",
  ]);
  for (const mode of ["auto-edit", "full-access", "managed"] as const) {
    assert.deepEqual(buildQoderArgs(session({
      provider: "qoder",
      runner: "qoder-cli-print",
      mode,
    }), "hello").slice(-2), ["--permission-mode", "bypass_permissions"]);
  }
  assert.deepEqual(buildQoderArgs(session({
    provider: "qoder",
    runner: "qoder-cli-print",
    thinkingEffort: "deep",
  }), "hello").slice(0, 6), [
    "-p", "hello", "--output-format", "stream-json", "--reasoning-effort", "high",
  ]);
});

test("session system prompts go through each provider's own system-prompt flag", () => {
  const systemPrompt = "你是 AI 团队「三人组」的负责人。";
  const withPrompt = (provider: SessionSnapshot["provider"], runner: SessionSnapshot["runner"]): SessionSnapshot =>
    session({ provider, runner, systemPrompt });

  // Claude 的 append 列表由共享 helper 派生（模式 / 语言指令 + 会话级系统提示），CLI 与 SDK 同一份。
  assert.deepEqual(buildSessionSystemPromptParts(withPrompt("claude", "claude-cli-print"), undefined), [systemPrompt]);
  assert.deepEqual(
    buildClaudeCliArgs(withPrompt("claude", "claude-cli-print"), {
      permissionPolicy: { permissionMode: "default" },
      systemPromptParts: buildSessionSystemPromptParts(withPrompt("claude", "claude-cli-print"), undefined),
    }).slice(-2),
    ["--append-system-prompt", systemPrompt],
  );

  for (const [provider, runner, flag] of [
    ["qoder", "qoder-cli-print", "--append-system-prompt"],
    ["pi", "pi-cli-json", "--append-system-prompt"],
  ] as const) {
    const args = provider === "qoder"
      ? buildQoderArgs(withPrompt(provider, runner), "hello")
      : buildPiArgs(withPrompt(provider, runner), "hello");
    const at = args.indexOf(flag);
    assert.ok(at >= 0, `${provider} should pass ${flag}`);
    assert.equal(args[at + 1], systemPrompt);
  }

  // Grok 的追加入口叫 --rules，不是 --append-system-prompt。
  assert.deepEqual(buildGrokArgs(withPrompt("grok", "grok-cli-headless"), "hello").slice(-2), ["--rules", systemPrompt]);
  // Codex / OpenCode 没有系统提示开关：不能凭空多出参数，由 promptWithSystemFallback 并进消息。
  assert.ok(!buildCodexArgs(withPrompt("codex", "codex-cli-exec")).includes("--append-system-prompt"));
  assert.ok(!buildOpenCodeArgs(withPrompt("opencode", "opencode-cli-run")).some((arg) => arg.startsWith("--append")));
  assert.ok(!buildCodexArgs(session({ provider: "codex", runner: "codex-cli-exec" })).includes(systemPrompt));
});

test("providers without a system-prompt flag get it prepended once, on the first message", () => {
  const prompt = "本轮要求：写计划。";
  const systemPrompt = "固定要求：只做本步骤。";
  assert.equal(
    promptWithSystemFallback(session({ provider: "codex", runner: "codex-cli-exec", systemPrompt, messages: [] }), prompt),
    `以下是本会话的固定要求（来自系统，不是用户输入，优先级高于后面的内容）：\n\n${systemPrompt}\n\n---\n\n${prompt}`,
  );
  // 第二轮起消息已经接在有它的历史后面，不重复。
  assert.equal(
    promptWithSystemFallback(session({
      provider: "codex", runner: "codex-cli-exec", systemPrompt,
      messages: [{ role: "user", content: [{ type: "text", text: "第一次" }] }, { role: "assistant", content: [] }],
    }), prompt),
    prompt,
  );
  // 有系统提示通道的 provider 不走兜底，避免同一段话出现两次。
  for (const provider of ["claude", "qoder", "pi", "grok"] as const) {
    assert.equal(promptWithSystemFallback(session({ provider, systemPrompt, messages: [] }), prompt), prompt);
  }
  assert.equal(promptWithSystemFallback(session({ provider: "codex", runner: "codex-cli-exec", messages: [] }), prompt), prompt);
});

test("PTY commands append the system prompt with shell quoting and never twice", () => {
  assert.equal(commandWithSystemPrompt("claude", "claude", "说 '中文'"), `claude --append-system-prompt '说 '\\''中文'\\'''`);
  assert.equal(commandWithSystemPrompt("grok", "grok", "规则"), "grok --rules '规则'");
  assert.equal(commandWithSystemPrompt("codex", "codex", "规则"), "codex");
  assert.equal(commandWithSystemPrompt("claude", "claude", undefined), "claude");
  assert.equal(
    commandWithSystemPrompt("claude --append-system-prompt '已有'", "claude", "新的"),
    "claude --append-system-prompt '已有'",
  );
});
