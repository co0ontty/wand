import { agentToolIdFor, type ProviderId } from "../provider-identity.js";

/** Metadata-only switching is restricted to genuinely unstarted interactive conversations. */
export function canSwitchSessionTool(session: any, messageTotal = 0): boolean {
  return !!session && session.sessionKind === "structured" && session.status === "idle" && !session.archived
    && !session.structuredState?.inFlight && !session.claudeSessionId && !session.resumedFromSessionId
    && !session.autoRecovered && !session.automationId
    && (!session.sessionSource || session.sessionSource === "interactive")
    && !(session.messages?.length || session.messageCount || session.messageTotal || messageTotal)
    && !session.queuedMessages?.length;
}

export function sessionToolId(session: any): string {
  return agentToolIdFor(session?.provider as ProviderId, session?.structuredState?.engine === "core" ? "sdk" : "cli");
}
