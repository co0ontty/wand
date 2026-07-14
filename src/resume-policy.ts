const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PROVIDER_SESSION_ID_PATTERN = new RegExp(`^${UUID_PATTERN}$`, "i");
const RESUME_COMMAND_ID_PATTERN = new RegExp(`(?:^|\\s)--resume\\s+(${UUID_PATTERN})(?:\\s|$)`, "i");
const CODEX_RESUME_COMMAND_ID_PATTERN = new RegExp(`(?:^|\\s)resume\\s+(${UUID_PATTERN})(?:\\s|$)`, "i");

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
