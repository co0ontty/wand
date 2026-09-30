import { spawn } from "node:child_process";

import { startStructuredCli } from "./structured-exec-pump.js";
import type { StructuredExecHost } from "./structured-exec-host.js";
import { asRecord } from "./structured-content.js";
import { promptWithSystemFallback } from "./structured-provider-common.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
  StructuredRunnerTurnState,
} from "./structured-runner.js";
import type { SessionSnapshot } from "./types.js";

export type GeminiTurnState = StructuredRunnerTurnState;

/**
 * Gemini CLI 的会话写在 `~/.gemini/tmp/<project_hash>/chats/`。ID 找不回来时 headless
 * 会以 42 退出并打印下面这句，识别出来才能丢掉失效的 resume ID 重开一轮
 * （与 Claude / Pi 的同类兜底一致）。
 */
export function isMissingGeminiSession(error: string | null | undefined): boolean {
  if (!error) return false;
  return /Invalid session identifier|No previous sessions found/i.test(error);
}

/**
 * approval mode 映射。结构化 runner 没有权限桥，`default` 下需要确认的工具调用会被
 * 直接拒绝；`yolo` 才是能连续干活的那一档。
 */
export function geminiApprovalMode(session: SessionSnapshot): "default" | "auto_edit" | "yolo" {
  if (
    session.autoApprovePermissions === true
    || session.mode === "full-access"
    || session.mode === "managed"
  ) {
    return "yolo";
  }
  if (session.mode === "auto-edit") return "auto_edit";
  return "default";
}

/**
 * `-p ""` 只把 CLI 钉在 headless 模式，真正的 prompt 走 stdin（Gemini CLI 把 stdin
 * 内容与 `-p` 内容用空行拼接，`-p` 为空时只剩 stdin）。这样长消息不撞 argv 上限，
 * 也不会出现在 `ps` 里。
 *
 * `--skip-trust` 必须带：headless 模式下 Gemini CLI 会检查工作区信任状态，未信任的
 * 目录会直接以 55 退出，并把 `--approval-mode` 降级成 `default`。Wand 是在用户自己
 * 选定的工作目录里代表用户启动这个 CLI，与其它 provider 的 auto-approve 语义一致。
 */
export function buildGeminiArgs(session: SessionSnapshot): string[] {
  const args = ["-p", "", "--output-format", "stream-json", "--skip-trust"];
  const model = session.selectedModel?.trim();
  if (model && model !== "default") args.push("--model", model);
  args.push("--approval-mode", geminiApprovalMode(session));
  if (session.claudeSessionId) args.push("--resume", session.claudeSessionId);
  return args;
}

const GEMINI_TOOL_NAMES: Record<string, string> = {
  run_shell_command: "Bash",
  shell: "Bash",
  read_file: "Read",
  read_many_files: "Read",
  write_file: "Write",
  replace: "Edit",
  edit: "Edit",
  glob: "Glob",
  list_directory: "Glob",
  grep_search: "Grep",
  search_file_content: "Grep",
  web_search: "WebSearch",
  google_web_search: "WebSearch",
  web_fetch: "WebFetch",
  write_todos: "TodoWrite",
  todo_write: "TodoWrite",
  ask_user: "AskUserQuestion",
  activate_skill: "Skill",
};

export function geminiToolName(name: string): string {
  return GEMINI_TOOL_NAMES[name.toLowerCase()] ?? `Gemini/${name}`;
}

function applyGeminiStats(state: GeminiTurnState, stats: Record<string, unknown>): void {
  const input = typeof stats.input_tokens === "number" ? stats.input_tokens : 0;
  const cached = typeof stats.cached === "number" ? stats.cached : 0;
  const output = typeof stats.output_tokens === "number" ? stats.output_tokens : 0;
  if (!input && !output) return;
  state.usage = {
    inputTokens: Math.max(input - cached, 0),
    outputTokens: output,
    cacheReadInputTokens: cached,
  };
}

function geminiToolOutput(event: Record<string, unknown>): string {
  if (typeof event.output === "string" && event.output) return event.output;
  const error = asRecord(event.error);
  return typeof error?.message === "string" ? error.message : "";
}

/**
 * Apply one Gemini CLI `--output-format stream-json` event.
 *
 * assistant `message` 事件带 `delta: true`，每个 chunk 是增量而不是快照，所以文本是
 * 追加而不是替换。tool_use / tool_result 由 CLI 直接按 tool_id 配对，不需要 upsert。
 */
export function applyGeminiEvent(state: GeminiTurnState, event: Record<string, unknown>): string | null {
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "init") {
    if (typeof event.session_id === "string" && event.session_id) state.sessionId = event.session_id;
    if (typeof event.model === "string" && event.model) state.model = event.model;
    return null;
  }
  if (type === "message") {
    const content = typeof event.content === "string" ? event.content : "";
    if (event.role !== "assistant" || !content) return null;
    const previous = state.blocks.at(-1);
    if (previous?.type === "text") previous.text += content;
    else state.blocks.push({ type: "text", text: content });
    state.result += content;
    return null;
  }
  if (type === "tool_use") {
    const id = typeof event.tool_id === "string" && event.tool_id ? event.tool_id : "tool";
    const name = typeof event.tool_name === "string" && event.tool_name ? event.tool_name : "tool";
    state.blocks.push({ type: "tool_use", id, name: geminiToolName(name), input: asRecord(event.parameters) ?? {} });
    return null;
  }
  if (type === "tool_result") {
    const id = typeof event.tool_id === "string" && event.tool_id ? event.tool_id : "unknown";
    state.blocks.push({
      type: "tool_result",
      tool_use_id: id,
      content: geminiToolOutput(event),
      is_error: event.status === "error",
    });
    return null;
  }
  if (type === "error") {
    // warning 只是提示（例如循环检测），不应把整轮判成失败。
    if (event.severity !== "error") return null;
    return typeof event.message === "string" && event.message ? event.message : "Gemini CLI execution failed";
  }
  if (type === "result") {
    const stats = asRecord(event.stats);
    if (stats) applyGeminiStats(state, stats);
    if (event.status === "error") {
      const error = asRecord(event.error);
      const message = typeof error?.message === "string" ? error.message : "";
      return message || "Gemini CLI execution failed";
    }
  }
  return null;
}

export class GeminiRunner implements StructuredRunnerAdapter {
  constructor(
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly execHost?: StructuredExecHost,
  ) {}

  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    const state: GeminiTurnState = {
      blocks: [],
      result: "",
      sessionId: context.session.claudeSessionId,
      model: context.session.selectedModel ?? context.session.structuredState?.model,
      phase: "responding",
    };
    let primaryError: string | null = null;
    return startStructuredCli({
      sessionId: context.session.id,
      file: "gemini",
      args: buildGeminiArgs(context.session),
      cwd: context.session.cwd,
      env: context.env,
      stdinData: promptWithSystemFallback(context.session, context.prompt),
      observer,
      execHost: this.execHost,
      spawnProcess: this.spawnProcess,
      createState: () => state,
      processLine: (line) => {
        if (!observer.isActive() || !line.trim()) return;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          observer.onEvent?.(event);
          primaryError = applyGeminiEvent(state, event) ?? primaryError;
          observer.onUpdate(state);
        } catch { /* Gemini stdout is NDJSON; ignore non-protocol noise. */ }
      },
      finalize: (ctx, exitCode, signal, spawnError) => ({
        state,
        exitCode,
        signal,
        stderr: ctx.stderr,
        primaryError,
        ...(spawnError ? { spawnError } : {}),
      }),
    });
  }
}
