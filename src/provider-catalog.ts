/**
 * Provider 的唯一真源：受支持的 CLI 列表、展示名、别名表与推断规则。
 *
 * 这个模块必须保持"纯数据 + 纯函数"，不能 import 任何 `node:*`：
 * 服务端（`src/session-provider.ts`）与浏览器 bundle（`src/web-ui/provider-identity.ts`）
 * 都直接复用它，避免同一个 provider 概念散落在两处各写一份。
 */
import type { SessionRunner } from "./types.js";

/** 全部受支持的会话 provider；顺序即 UI / 派发选择器里的展示顺序。 */
export const SESSION_PROVIDERS = ["claude", "codex", "opencode", "grok", "qoder", "pi"] as const;

export type SessionProvider = (typeof SESSION_PROVIDERS)[number];

/**
 * 拥有原生思考档位（`provider:level`）的 provider。
 */
export const NATIVE_THINKING_EFFORT_PROVIDERS = ["claude", "codex", "opencode", "grok", "qoder", "pi"] as const;

/** 原生思考档位的 `provider:level` 形状；各端必须共用同一张 provider 名单。 */
export const NATIVE_THINKING_EFFORT_PATTERN = `^(?:${NATIVE_THINKING_EFFORT_PROVIDERS.join("|")}):[a-z0-9][a-z0-9_-]{0,31}$`;

/** 判断字符串是否为 `provider:level` 形状的原生思考档。 */
export function isNativeThinkingEffort(value: unknown): boolean {
  return typeof value === "string" && NATIVE_THINKING_EFFORT_RE.test(value);
}

const NATIVE_THINKING_EFFORT_RE = new RegExp(NATIVE_THINKING_EFFORT_PATTERN);

const SESSION_PROVIDER_SET: ReadonlySet<string> = new Set(SESSION_PROVIDERS);

/** 运行时守卫：把配置、数据库、请求体里的任意值收敛成 SessionProvider。 */
export function isSessionProvider(value: unknown): value is SessionProvider {
  return typeof value === "string" && SESSION_PROVIDER_SET.has(value);
}

/** provider 对应的 CLI 可执行文件名（Qoder 的 CLI 叫 qodercli）。 */
export function providerCliCommand(provider: SessionProvider): string {
  return provider === "qoder" ? "qodercli" : provider;
}

// 新 provider 必须明确配置 runner；不能静默落到 Claude。
const DEFAULT_STRUCTURED_RUNNERS = {
  claude: "claude-cli-print",
  codex: "codex-cli-exec",
  opencode: "opencode-cli-run",
  grok: "grok-cli-headless",
  qoder: "qoder-cli-acp",
  pi: "pi-cli-json",
} as const satisfies Record<SessionProvider, SessionRunner>;

/** CLI 结构化执行的默认 runner；服务端与 Web 创建入口共用。 */
export function defaultStructuredRunner(provider: SessionProvider) {
  return DEFAULT_STRUCTURED_RUNNERS[provider];
}

/**
 * provider 的展示名。缺省不认识的字符串一律回落到 "AI"。
 *
 * `pi` 指的是 Pi CLI（结构化 JSON / PTY 终端），与 Wand 自带的 Agent 是两条独立执行路径：
 * 后者走进程内 SDK，展示名用 `WAND_AGENT_LABEL`，不要拿 provider 名字冒充它。
 */
export const PROVIDER_LABELS: Readonly<Record<SessionProvider, string>> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  grok: "Grok",
  qoder: "Qoder",
  pi: "Pi",
};

/**
 * Wand 自带 Agent（进程内 `core` harness / SDK）的展示名。
 *
 * 它和 `pi` provider 不是同一个东西：`pi` 起 Pi CLI 进程，Wand Agent 在 Wand 进程内用 SDK 跑 agent loop，
 * 因此能力边界（会话级 Skills / MCP、CodeMode、持久化恢复）也不一样。
 */
export const WAND_AGENT_LABEL = "Wand Agent";

/**
 * provider id 别名表：既接受用户/客户端可能写出的别名（`anthropic`、`open-code`），
 * 也接受历史 runner 名（`claude-cli-print`、`codex-cli-exec` …），
 * 供 `normalizeProviderId` 与 `inferProviderFromRunner` 共用。
 */
export const PROVIDER_ALIASES: Readonly<Record<string, SessionProvider>> = {
  anthropic: "claude",
  claude: "claude",
  "claude-cli": "claude",
  "claude-cli-print": "claude",
  // SDK 执行路径已移除；这里仅用于识别旧会话里的历史 runner 值。
  "claude-sdk": "claude",
  codex: "codex",
  "codex-cli": "codex",
  "codex-cli-exec": "codex",
  grok: "grok",
  "grok-cli": "grok",
  "grok-cli-headless": "grok",
  "open-code": "opencode",
  open_code: "opencode",
  opencode: "opencode",
  "opencode-cli-run": "opencode",
  qoder: "qoder",
  "qoder-cli": "qoder",
  "qoder-cli-acp": "qoder",
  "qoder-cli-print": "qoder",
  qodercli: "qoder",
  pi: "pi",
  "pi-cli": "pi",
  "pi-cli-json": "pi",
};

/** 归一化一个已持久化的 provider id 或 runner/别名；无法识别时返回 null。 */
export function normalizeProviderId(value: unknown): SessionProvider | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized ? PROVIDER_ALIASES[normalized] ?? null : null;
}

/** 从 runner 名推断 provider；`pty` 等与 provider 无关的 runner 返回 undefined。 */
export function inferProviderFromRunner(runner: unknown): SessionProvider | undefined {
  return normalizeProviderId(runner) ?? undefined;
}

/** A literal shell word and its original span; resume edits must not re-quote argument data. */
export type ProviderCommandToken = { value: string; start: number; end: number };

/** Parse one simple command. Shell pipelines/substitutions cannot be safely rewritten as a resume. */
function commandTokens(command: string): ProviderCommandToken[] | null {
  const tokens: ProviderCommandToken[] = [];
  let index = 0;
  while (index < command.length) {
    if (/[ \t]/.test(command[index])) { index += 1; continue; }
    const start = index;
    let value = "";
    let quote = "";
    while (index < command.length) {
      const char = command[index];
      if (!quote && /[ \t]/.test(char)) break;
      if (char === quote) { quote = ""; index += 1; continue; }
      if (quote !== "'" && char === "\\") {
        const next = command[index + 1];
        if (next === undefined || /[\r\n]/.test(next)) return null;
        value += quote === '"' && !/[$`"\\]/.test(next) ? `\\${next}` : next;
        index += 2;
        continue;
      }
      if (!quote && (char === "'" || char === '"')) { quote = char; index += 1; continue; }
      if ((!quote && /[;|&<>()\r\n]/.test(char))
        || (quote !== "'" && (char === "`" || (char === "$" && command[index + 1] === "(")))
        || (!quote && char === "#" && index === start)) return null;
      value += char;
      index += 1;
    }
    if (quote) return null;
    tokens.push({ value, start, end: index });
  }
  return tokens;
}

const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "bunx", "yarn", "pnpm", "corepack"]);
const PACKAGE_RUNNER_SUBCOMMANDS = new Set(["dlx", "exec", "x"]);
const PACKAGE_RUNNER_VALUE_OPTIONS = new Set([
  "-p", "--package", "--cache", "--userconfig", "--registry", "--prefix", "--cwd", "--dir", "-C", "--filter", "-F",
]);

function commandExecutableName(value: string): string {
  return value.split(/[\\/]/).pop()?.replace(/\.(?:cmd|exe)$/i, "").toLowerCase() ?? "";
}

/** Startup inference and PTY resume share the same executable and argument boundaries. */
export function parseProviderCommand(command: string): {
  provider: SessionProvider;
  tokens: ProviderCommandToken[];
  executableIndex: number;
} | null {
  const tokens = commandTokens(command);
  if (!tokens?.length) return null;
  let index = 0;
  while (PACKAGE_RUNNERS.has(commandExecutableName(tokens[index]?.value ?? ""))) {
    index += 1;
    while (index < tokens.length) {
      const value = tokens[index].value;
      // npx --call/-c executes shell source, not a following executable token.
      if (value === "-c" || value === "--call" || value.startsWith("--call=")) return null;
      if (PACKAGE_RUNNER_SUBCOMMANDS.has(value) || value === "--") { index += 1; continue; }
      if (!value.startsWith("-")) break;
      index += PACKAGE_RUNNER_VALUE_OPTIONS.has(value) ? 2 : 1;
    }
  }
  const executable = commandExecutableName(tokens[index]?.value ?? "");
  const provider = normalizeProviderId(executable);
  return provider ? { provider, tokens, executableIndex: index } : null;
}

/** Infer the actual CLI, including quoted paths and package runners, never an argument or name prefix. */
export function inferProviderFromCommand(command: unknown): SessionProvider | undefined {
  return typeof command === "string" ? parseProviderCommand(command)?.provider : undefined;
}

/** 每个 provider 在自由文本里可能出现的写法，用于把命令名收敛成可读标签。 */
export function providerDisplayName(value: unknown): string {
  if (typeof value === "string" && value.trim().toLowerCase() === "terminal") return "终端";
  const provider = normalizeProviderId(value);
  if (provider) return PROVIDER_LABELS[provider];
  return typeof value === "string" && value.trim() ? value.trim() : "AI";
}
