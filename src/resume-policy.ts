import { parseProviderCommand, type ProviderCommandToken } from "./provider-catalog.js";
import type { SessionProvider } from "./types.js";

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PROVIDER_SESSION_ID_PATTERN = new RegExp(`^${UUID_PATTERN}$`, "i");
const SAFE_PROVIDER_SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,199}$/i;

/** Claude session IDs and Codex thread IDs are UUID-shaped identifiers. */
export function isProviderSessionId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_SESSION_ID_PATTERN.test(value);
}

/**
 * Provider-native IDs are not uniformly UUIDs: OpenCode uses `ses_*` and
 * older Qoder releases also emitted `qs_*`. Keep the accepted alphabet shell
 * inert before an ID is interpolated into a PTY command.
 */
export function isSafeProviderSessionId(value: unknown): value is string {
  return typeof value === "string" && SAFE_PROVIDER_SESSION_ID_PATTERN.test(value);
}

const CODEX_VALUE_OPTIONS = new Set([
  "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env",
  "-i", "--image", "-m", "--model", "--local-provider", "-p", "--profile",
  "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval",
]);

// These arguments may contain text that looks exactly like a resume option.
const PROMPT_VALUE_OPTIONS = new Set([
  "--system-prompt", "--append-system-prompt", "--system-prompt-override",
  "--prompt", "--prompt-interactive", "--rules", "--agents", "--settings", "--mcp-config",
]);

function resumeFlags(provider: SessionProvider): readonly string[] {
  if (provider === "opencode") return ["--session", "-s"];
  if (provider === "pi") return ["--session"];
  return ["--resume", "-r"];
}

function assignedIdFlags(provider: SessionProvider): readonly string[] {
  if (provider === "codex" || provider === "opencode") return [];
  return provider === "grok" ? ["--session-id", "-s"] : ["--session-id"];
}

function firstCodexPositional(tokens: ProviderCommandToken[], start: number, afterTerminator = false): number {
  for (let index = start; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === "--") return afterTerminator && index + 1 < tokens.length ? index + 1 : -1;
    if (!value.startsWith("-")) return index;
    if (CODEX_VALUE_OPTIONS.has(value)) index += 1;
  }
  return -1;
}

type ResumeArguments = {
  resumedId: string | null;
  assignedId: string | null;
  remove: Set<number>;
};

function readResumeArguments(provider: SessionProvider, tokens: ProviderCommandToken[], start: number): ResumeArguments {
  const result: ResumeArguments = { resumedId: null, assignedId: null, remove: new Set() };
  if (provider === "codex") {
    const subcommand = firstCodexPositional(tokens, start);
    if (subcommand < 0 || tokens[subcommand].value !== "resume") return result;
    result.remove.add(subcommand);
    let resumeLast = false;
    for (let index = subcommand + 1; index < tokens.length; index += 1) {
      if (tokens[index].value === "--") break;
      if (CODEX_VALUE_OPTIONS.has(tokens[index].value)) { index += 1; continue; }
      if (tokens[index].value === "--last") {
        result.remove.add(index);
        resumeLast = true;
      }
    }
    // With --last Codex treats the positional text as the prompt, not an explicit ID.
    if (!resumeLast) {
      const idIndex = firstCodexPositional(tokens, subcommand + 1, true);
      if (idIndex >= 0) {
        const id = tokens[idIndex].value;
        result.resumedId = isSafeProviderSessionId(id) ? id : null;
        result.remove.add(idIndex);
      }
    }
    return result;
  }

  for (let index = start; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === "--") break;
    if (PROMPT_VALUE_OPTIONS.has(value)) { index += 1; continue; }
    const equal = value.indexOf("=");
    const flag = equal < 0 ? value : value.slice(0, equal);
    const resumed = resumeFlags(provider).includes(flag);
    const assigned = assignedIdFlags(provider).includes(flag);
    if (resumed || assigned) {
      result.remove.add(index);
      let id: string | undefined = equal < 0 ? tokens[index + 1]?.value : value.slice(equal + 1);
      if (equal < 0 && id !== undefined && !id.startsWith("-")) result.remove.add(++index);
      else if (equal < 0) id = undefined;
      if (isSafeProviderSessionId(id)) {
        if (resumed) result.resumedId = id;
        else result.assignedId = id;
      }
    } else if (value === "--continue" || value === "-c"
      || (provider === "pi" && (value === "--resume" || value === "-r"))) {
      result.remove.add(index);
    }
  }
  return result;
}

export function getProviderResumeCommandSessionId(provider: SessionProvider, command: string): string | null {
  const parsed = parseProviderCommand(command);
  if (parsed?.provider !== provider) return null;
  return readResumeArguments(provider, parsed.tokens, parsed.executableIndex + 1).resumedId;
}

/** Read only actual command arguments, never an ID embedded in a prompt or shell script. */
export function getProviderCommandSessionId(provider: SessionProvider, command: string): string | null {
  const parsed = parseProviderCommand(command);
  if (parsed?.provider !== provider) return null;
  const ids = readResumeArguments(provider, parsed.tokens, parsed.executableIndex + 1);
  return ids.resumedId ?? ids.assignedId;
}

/** Build one explicit resume while preserving the invocation prefix and untouched argument bytes. */
export function buildProviderResumeCommand(
  provider: SessionProvider,
  command: string,
  providerSessionId: string,
): string {
  if (!isSafeProviderSessionId(providerSessionId)) throw new Error("Provider 会话 ID 格式无效。");
  const parsed = parseProviderCommand(command);
  if (parsed?.provider !== provider) throw new Error("无法安全恢复此 Provider 命令。");
  const { tokens, executableIndex } = parsed;
  const { remove } = readResumeArguments(provider, tokens, executableIndex + 1);
  const executableEnd = tokens[executableIndex].end;
  const resume = provider === "codex" ? "resume" : resumeFlags(provider)[0];
  let result = `${command.slice(0, executableEnd)} ${resume} ${providerSessionId}`;
  let offset = executableEnd;
  for (let index = executableIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    // Remove each obsolete selector with its preceding gap; untouched arguments retain their bytes.
    if (!remove.has(index)) result += command.slice(offset, token.end);
    offset = token.end;
  }
  return result + command.slice(offset);
}
