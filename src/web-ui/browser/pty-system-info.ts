interface SessionLike {
  sessionKind?: string;
  runner?: string;
}

const STRUCTURED_RUNNERS = new Set([
  "claude-sdk",
  "claude-cli-print",
  "codex-cli-exec",
  "opencode-cli-run",
  "grok-cli-headless",
  "qoder-cli-print",
]);

/**
 * PTY banner extraction is valid only for terminal transcripts. Structured
 * sessions also expose an `output` compatibility field, but it contains
 * assistant output and must never be projected as a leading system card.
 */
export function shouldExtractPtySystemInfo(session: SessionLike | null | undefined): boolean {
  if (!session || session.sessionKind === "structured") return false;
  return typeof session.runner !== "string" || !STRUCTURED_RUNNERS.has(session.runner);
}
