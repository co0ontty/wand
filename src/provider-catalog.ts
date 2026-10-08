/**
 * Provider 的唯一真源：受支持的 CLI 列表、展示名、别名表与推断规则。
 *
 * 这个模块必须保持"纯数据 + 纯函数"，不能 import 任何 `node:*`：
 * 服务端（`src/session-provider.ts`）与浏览器 bundle（`src/web-ui/provider-identity.ts`）
 * 都直接复用它，避免同一个 provider 概念散落在两处各写一份。
 */

/** 全部受支持的会话 provider；顺序即 UI / 派发选择器里的展示顺序。 */
export const SESSION_PROVIDERS = ["claude", "codex", "opencode", "grok", "qoder", "pi", "gemini"] as const;

export type SessionProvider = (typeof SESSION_PROVIDERS)[number];

/**
 * 拥有原生思考档位（`provider:level`）的 provider。
 * Gemini CLI 没有档位开关，所以不出现在这里：`gemini:max` 这种值不应该被当成合法档位保留。
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
  gemini: "Gemini",
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
  "qoder-cli-print": "qoder",
  qodercli: "qoder",
  pi: "pi",
  "pi-cli": "pi",
  "pi-cli-json": "pi",
  gemini: "gemini",
  "gemini-cli": "gemini",
  "gemini-cli-json": "gemini",
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

/** 这些是包管理器式的启动前缀：`npx claude`、`pnpm dlx codex` 等要看到后面的真实可执行名。 */
const PACKAGE_RUNNER_PREFIXES: ReadonlySet<string> = new Set(["npx", "pnpx", "bunx", "yarn", "pnpm", "corepack"]);

/** 包管理器的子命令（没有它们时，`pnpm dlx codex` 会误把 `dlx` 当可执行名）。 */
const PACKAGE_RUNNER_SUBCOMMANDS: ReadonlySet<string> = new Set(["dlx", "exec", "x"]);

/** 拆出命令行第一个可执行 token，去掉引号、目录前缀与 Windows 可执行后缀。 */
function commandExecutableName(command: string): string {
  const match = command.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const executablePath = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  return executablePath.split(/[\\/]/).pop()?.replace(/\.(?:cmd|exe)$/i, "") ?? "";
}

/**
 * 从启动命令推断 provider；识别的是命令行里真正的可执行名。
 *
 * - `/opt/homebrew/bin/claude --resume abc` → claude
 * - `open-code run` / `qodercli --print` → opencode / qoder
 * - `npx claude` / `pnpm dlx codex` → 看包管理器后面的真实 CLI
 *
 * 参数与父目录名不能冒充别的 provider（`claude -p codex` 仍是 claude）。
 */
export function inferProviderFromCommand(command: unknown): SessionProvider | undefined {
  if (typeof command !== "string") return undefined;
  const value = command.trim();
  if (!value) return undefined;

  // 先把命令行按空白切成 token，跳过包管理器前缀与它自己的 flag（--yes 之类）。
  const tokens = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  let index = 0;
  if (PACKAGE_RUNNER_PREFIXES.has(commandExecutableName(tokens[0] ?? "").toLowerCase())) {
    index = 1;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token.startsWith("-")) { index += 1; continue; }
      if (PACKAGE_RUNNER_SUBCOMMANDS.has(commandExecutableName(token).toLowerCase())) { index += 1; continue; }
      break;
    }
  }
  return normalizeProviderId(commandExecutableName(tokens[index] ?? "")) ?? undefined;
}

/** 每个 provider 在自由文本里可能出现的写法，用于把命令名收敛成可读标签。 */
export function providerDisplayName(value: unknown): string {
  if (typeof value === "string" && value.trim().toLowerCase() === "terminal") return "终端";
  const provider = normalizeProviderId(value);
  if (provider) return PROVIDER_LABELS[provider];
  return typeof value === "string" && value.trim() ? value.trim() : "AI";
}
