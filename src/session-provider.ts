import type { SessionProvider } from "./types.js";

/** 全部受支持的会话 provider；顺序与 UI / 派发选择器一致。 */
export const SESSION_PROVIDERS = ["claude", "codex", "opencode", "grok", "qoder", "pi"] as const;

const SESSION_PROVIDER_SET: ReadonlySet<string> = new Set(SESSION_PROVIDERS);

/** 运行时守卫：把配置、数据库、请求体里的任意值收敛成 SessionProvider。 */
export function isSessionProvider(value: unknown): value is SessionProvider {
  return typeof value === "string" && SESSION_PROVIDER_SET.has(value);
}

/** provider 对应的 CLI 可执行文件名（Qoder 的 CLI 叫 qodercli）。 */
export function providerCliCommand(provider: SessionProvider): string {
  return provider === "qoder" ? "qodercli" : provider;
}

/** 从 runner 名推断 provider；`pty` 等与 provider 无关的 runner 返回 undefined。 */
export function inferProviderFromRunner(runner: unknown): SessionProvider | undefined {
  if (runner === "claude-cli" || runner === "claude-cli-print" || runner === "claude-sdk") return "claude";
  if (runner === "codex-cli-exec") return "codex";
  if (runner === "opencode-cli-run") return "opencode";
  if (runner === "grok-cli-headless") return "grok";
  if (runner === "qoder-cli-print") return "qoder";
  if (runner === "pi-cli-json") return "pi";
  return undefined;
}

/**
 * 从启动命令推断 provider；无法识别时返回 undefined，由调用方决定默认值。
 *
 * 识别的是命令行的第一个 token：`claude`、`npx claude`、任意路径下的 `claude`
 * 都算 Claude，其余 provider 要求命令以其 CLI 名开头。
 */
export function inferProviderFromCommand(command: string): SessionProvider | undefined {
  const value = command.trim();
  if (/^(?:claude|npx\s+claude|[^\s]+\/claude)(?:\s|$)/i.test(value)) return "claude";
  if (/^codex\b/i.test(value)) return "codex";
  if (/^opencode\b/i.test(value)) return "opencode";
  if (/^grok\b/i.test(value)) return "grok";
  if (/^qodercli\b/i.test(value)) return "qoder";
  if (/^pi\b/i.test(value)) return "pi";
  return undefined;
}
