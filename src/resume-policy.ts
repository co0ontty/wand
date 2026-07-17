import type { SessionProvider } from "./types.js";

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PROVIDER_SESSION_ID_PATTERN = new RegExp(`^${UUID_PATTERN}$`, "i");
const RESUME_COMMAND_ID_PATTERN = new RegExp(`(?:^|\\s)--resume\\s+(${UUID_PATTERN})(?:\\s|$)`, "i");
const CODEX_RESUME_COMMAND_ID_PATTERN = new RegExp(`(?:^|\\s)resume\\s+(${UUID_PATTERN})(?:\\s|$)`, "i");
const SAFE_PROVIDER_SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,199}$/i;
const SAFE_PROVIDER_SESSION_ID_SOURCE = "([a-z0-9][a-z0-9._:-]{0,199})";

/** Claude session IDs and Codex thread IDs are UUID-shaped identifiers. */
export function isProviderSessionId(value: unknown): value is string {
  return typeof value === "string" && PROVIDER_SESSION_ID_PATTERN.test(value);
}

export function getResumeCommandSessionId(command: string): string | null {
  const match = RESUME_COMMAND_ID_PATTERN.exec(command);
  return match?.[1] ?? null;
}

export function getCodexResumeCommandSessionId(command: string): string | null {
  const match = CODEX_RESUME_COMMAND_ID_PATTERN.exec(command);
  return match?.[1] ?? null;
}

/**
 * Provider-native IDs are not uniformly UUIDs: OpenCode uses `ses_*` and
 * older Qoder releases also emitted `qs_*`. Keep the accepted alphabet shell
 * inert before an ID is interpolated into a PTY command.
 */
export function isSafeProviderSessionId(value: unknown): value is string {
  return typeof value === "string" && SAFE_PROVIDER_SESSION_ID_PATTERN.test(value);
}

function resumeArgumentPattern(provider: SessionProvider): RegExp {
  if (provider === "codex") {
    return new RegExp(`(?:^|\\s)resume\\s+${SAFE_PROVIDER_SESSION_ID_SOURCE}(?=\\s|$)`, "i");
  }
  if (provider === "opencode") {
    return new RegExp(`(?:^|\\s)(?:--session|-s)\\s+${SAFE_PROVIDER_SESSION_ID_SOURCE}(?=\\s|$)`, "i");
  }
  return new RegExp(`(?:^|\\s)(?:--resume|-r)\\s+${SAFE_PROVIDER_SESSION_ID_SOURCE}(?=\\s|$)`, "i");
}

function assignedSessionIdPattern(): RegExp {
  return new RegExp(`(?:^|\\s)--session-id\\s+${SAFE_PROVIDER_SESSION_ID_SOURCE}(?=\\s|$)`, "i");
}

export function getProviderResumeCommandSessionId(
  provider: SessionProvider,
  command: string,
): string | null {
  return resumeArgumentPattern(provider).exec(command)?.[1] ?? null;
}

/** Read either a resume ID or a caller-assigned ID from a provider command. */
export function getProviderCommandSessionId(provider: SessionProvider, command: string): string | null {
  const resumed = getProviderResumeCommandSessionId(provider, command);
  if (resumed) return resumed;
  if (provider === "codex" || provider === "opencode") return null;
  return assignedSessionIdPattern().exec(command)?.[1] ?? null;
}

function stripProviderResumeArgument(provider: SessionProvider, command: string): string {
  const withoutResume = command.replace(resumeArgumentPattern(provider), " ");
  const withoutAssignedId = provider === "codex" || provider === "opencode"
    ? withoutResume
    : withoutResume.replace(assignedSessionIdPattern(), " ");
  return withoutAssignedId.replace(/\s+/g, " ").trim();
}

/** Build the interactive resume command used by PTY sessions. */
export function buildProviderResumeCommand(
  provider: SessionProvider,
  command: string,
  providerSessionId: string,
): string {
  if (!isSafeProviderSessionId(providerSessionId)) {
    throw new Error("Provider 会话 ID 格式无效。");
  }
  const base = stripProviderResumeArgument(provider, command) || (provider === "qoder" ? "qodercli" : provider);
  if (provider === "codex") return `${base} resume ${providerSessionId}`;
  if (provider === "opencode") return `${base} --session ${providerSessionId}`;
  return `${base} --resume ${providerSessionId}`;
}
