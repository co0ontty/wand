import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  query as sdkQuery,
  type Options as SdkOptions,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { buildLanguageDirective } from "./language-prompt.js";
import { getErrorMessage } from "./error-utils.js";

export type ClaudeRunErrorCode =
  | "CLAUDE_CLI_MISSING"
  | "CLAUDE_TIMEOUT"
  | "CLAUDE_CLI_FAILED"
  | "CLAUDE_EMPTY_RESULT";

export class ClaudeRunError extends Error {
  constructor(message: string, public readonly code: ClaudeRunErrorCode) {
    super(message);
    this.name = "ClaudeRunError";
  }
}

export interface RunClaudePrintOptions {
  cwd?: string;
  timeoutMs: number;
  /** Optional Claude model id / alias. Empty or "default" keeps Claude Code's own default. */
  model?: string;
  /**
   * 用户偏好的回复语言（取自 config.language）。传进来时会以
   * `appendSystemPrompt` 形式灌给 Claude，保证 quick-commit / prompt-optimizer
   * 这种一次性调用也跟用户主会话同语言——之前 wand 的 git commit message 会
   * 莫名其妙变中英混搭，根因就在这。
   */
  language?: string;
}

/**
 * 判断当前 Linux 是否是 musl 系（Alpine 等）。glibc 系跑不动 musl native binary，
 * 反之亦然，SDK 默认的优先级与本机不匹配时会抛 "Claude Code native binary not found"。
 */
function isMuslSystem(): boolean {
  try {
    const header = (process.report?.getReport() as Record<string, unknown> | undefined)?.header as
      | Record<string, unknown>
      | undefined;
    return !header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/**
 * 在 PATH 上找系统安装的 `claude`。wand 的交互式 PTY 会话本来就 spawn PATH 上的
 * claude（service 模式下 path-repair 已先把 PATH 补全），SDK 调用对齐同一个 binary
 * 才能保证两边版本、认证、API 端点兼容性完全一致。
 */
function findClaudeOnPath(): string | undefined {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, "claude");
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 不存在或不可执行，继续找下一个目录
    }
  }
  return undefined;
}

/**
 * 解析 SDK 应使用的 claude binary：**优先系统安装的 claude，回退 SDK 内置 native binary**。
 *
 * 优先系统版的原因：node_modules 里的内置 binary 版本在装包那刻就钉死了，会随时间
 * 越来越旧，最终可能被 API 端拒绝（实测内置 2.1.138 对部分端点持续 502 重试到超时，
 * 而系统侧日常更新的 2.1.170 正常）。系统 claude 跟交互式 PTY 会话同源，用户平时
 * 一直在用、一直在更新，是最可靠的选择。
 *
 * 内置 binary 仅作兜底（系统没装 claude 时仍可用）。Linux 上必须显式按 libc 选包：
 * SDK 默认解析在 glibc 系统上可能错选 musl 包直接抛 "native binary not found"。
 */
export function resolveSdkClaudeBinary(): string | undefined {
  // Windows 上 PATH 命中的多是 .cmd shim，spawn 语义不同，维持 SDK 默认解析。
  if (process.platform !== "win32") {
    const systemClaude = findClaudeOnPath();
    if (systemClaude) return systemClaude;
  }

  if (process.platform !== "linux") return undefined;

  const musl = isMuslSystem();
  const arch = process.arch;
  const require = createRequire(import.meta.url);

  const candidates = musl
    ? [
        `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude`,
        `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`,
      ]
    : [
        `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`,
        `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude`,
      ];

  for (const pkg of candidates) {
    try {
      const resolved = require.resolve(pkg);
      if (existsSync(resolved)) return resolved;
    } catch {
      // 包不存在，尝试下一个
    }
  }
  return undefined;
}

/**
 * 用 `@anthropic-ai/claude-agent-sdk` 跑一次"prompt → 单段纯文本"调用，
 * 等价以前的 `claude -p --output-format text`。
 *
 * 行为对齐 Claude Code 默认：
 *   - 不指定 model / appendSystemPrompt / agent / mcpServers / hooks 等覆盖项，
 *     完全由 `~/.claude/settings.json`、OAuth 凭据、`CLAUDE_*` 环境变量等
 *     用户侧配置接管，与 Claude Code 自身一致。
 *   - `tools: []` 关掉所有内置工具：这两个调用点（commit message / prompt 优化）
 *     本质就是"纯文本生成"，关掉工具能 (1) 防止 Claude 随手开个工具卡住权限询问；
 *     (2) 避免一次性短调用还顺便加载文件 / 跑 bash 这种副作用。
 *   - `mcpServers: {}` + `strictMcpConfig: true` 跳过用户配置的全部 MCP 服务器：
 *     纯文本生成用不上 MCP，但不禁的话每次调用都要连接 MCP（启动慢好几秒）、
 *     还把所有 MCP 工具 schema 灌进 system prompt（实测一次多写 1.6 万 token 的
 *     prompt cache，白花钱）。
 *   - `persistSession: false`：这些 ephemeral 调用不应该污染 `~/.claude/projects/`
 *     的会话历史；用户在 wand UI 里也压根看不到这些"虚拟会话"。
 *
 * binary 解析见 `resolveSdkClaudeBinary()`：优先系统 claude（与 PTY 会话同源、
 * 版本新），回退 SDK 内置 native binary（系统没装时的零 PATH 依赖兜底）。
 */
export async function runClaudePrint(
  prompt: string,
  options: RunClaudePrintOptions,
): Promise<string> {
  const cwd = options.cwd && options.cwd.length > 0 ? options.cwd : undefined;

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), options.timeoutMs);

  const sdkClaudeBinary = resolveSdkClaudeBinary();
  const languageDirective = options.language ? buildLanguageDirective(options.language) : "";
  const model = options.model?.trim();
  const sdkOptions: SdkOptions = {
    abortController,
    tools: [],
    mcpServers: {},
    strictMcpConfig: true,
    persistSession: false,
    ...(cwd ? { cwd } : {}),
    ...(sdkClaudeBinary ? { pathToClaudeCodeExecutable: sdkClaudeBinary } : {}),
    ...(languageDirective ? { appendSystemPrompt: languageDirective } : {}),
    ...(model && model !== "default" ? { model } : {}),
  };

  // 单条 user message → AsyncGenerator，SDK 的 streaming input 协议要求。
  async function* singleShot(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
      parent_tool_use_id: null,
    };
  }

  let resultText = "";
  let resultError: ClaudeRunError | null = null;

  try {
    for await (const msg of sdkQuery({
      prompt: singleShot(),
      options: sdkOptions,
    }) as AsyncIterable<SDKMessage>) {
      if (msg.type !== "result") continue;
      if (msg.subtype === "success" && typeof msg.result === "string") {
        resultText = msg.result.trim();
      } else {
        const errs = Array.isArray((msg as { errors?: string[] }).errors)
          ? (msg as { errors: string[] }).errors.join("; ")
          : msg.subtype;
        resultError = new ClaudeRunError(`Claude SDK 失败：${errs}`, "CLAUDE_CLI_FAILED");
      }
      break; // 一次性调用，拿到 result 即退出
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      throw new ClaudeRunError("Claude 调用超时。", "CLAUDE_TIMEOUT");
    }
    const message = getErrorMessage(err);
    // SDK 找不到 native binary 时会抛 "Claude Code native binary not found"。
    // 极少数情况下也可能透出 ENOENT。两种都归到"CLI_MISSING"，文案给用户。
    if (/Claude Code native binary not found|ENOENT/i.test(message)) {
      throw new ClaudeRunError("未找到 claude CLI。", "CLAUDE_CLI_MISSING");
    }
    throw new ClaudeRunError(`Claude SDK 失败：${message}`, "CLAUDE_CLI_FAILED");
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (resultError) throw resultError;
  if (!resultText) {
    throw new ClaudeRunError("Claude 返回了空结果。", "CLAUDE_EMPTY_RESULT");
  }
  return resultText;
}
