import type { WorkspaceSessionSummary } from "./workspaces/types";
import { parseJsonResponse } from "./http-adapter";
import { createQuerySnapshot } from "../query-snapshot";

/**
 * The raw `GET /api/sessions` list, shared by the legacy session engine and the
 * React conversation projection. Each consumer still applies its own merge and
 * selection rules; only transport and the last server payload are shared.
 */
const snapshot = createQuerySnapshot<WorkspaceSessionSummary[]>(async () => {
  const response = await fetch("/api/sessions", { credentials: "same-origin" });
  const sessions = await parseJsonResponse<WorkspaceSessionSummary[]>(response);
  if (!Array.isArray(sessions) || sessions.some((session) => !session || typeof session.id !== "string")) {
    throw new Error("Invalid session list response");
  }
  return sessions;
});

export function peekSessionList(): WorkspaceSessionSummary[] | null {
  return snapshot.peek();
}

export function loadSessionList(options?: { force?: boolean }): Promise<WorkspaceSessionSummary[]> {
  return snapshot.load(options);
}

export function publishSessionList(sessions: WorkspaceSessionSummary[]): void {
  snapshot.publish(sessions);
}

export function subscribeSessionList(listener: () => void): () => void {
  return snapshot.subscribe(listener);
}

export function invalidateSessionList(): void {
  snapshot.invalidate();
}
