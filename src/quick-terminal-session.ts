import type { SessionSnapshot } from "./types.js";

/** A quick-terminal claim never takes ownership of an Agent or automation session. */
export function canClaimQuickTerminal(session: SessionSnapshot): boolean {
  return (session.sessionKind ?? "pty") === "pty" && !session.provider && !session.automationId
    && (!session.sessionSource || session.sessionSource === "interactive" || session.sessionSource === "quick-terminal");
}
