import { teamChatComposer } from "../ai-teams/composer-bridge";
import * as React from "react";
import type { ConversationDetail, ConversationReceipt, ConversationSummary } from "../../../conversation-types.js";
import { createRequestId, HttpResponseError, jsonBody, requestJson } from "../http-adapter";
import { sha256Hex } from "../sha256";
import { subscribeAiTeamRunChanges } from "../ai-teams/repository";
import { subscribeSiliconEmployeeDefinitionChanges } from "../agents/employee-repository";
import { subscribeTaskChanges } from "../task-changes";
import { isSystemAiCall } from "../../../system-ai-call.js";
import { loadSessionList } from "../session-list-snapshot";
import type { WorkspaceSessionSummary } from "../workspaces/types";

export class UnconfirmedConversationError extends Error {
  readonly __wandAmbiguousDelivery = true;
  constructor(readonly requestId: string) { super("送达未确认，请先核对记录，勿重复发送。"); }
}
async function readReceipt(path: string, init?: RequestInit): Promise<ConversationReceipt> {
  const response = await fetch(path, init);
  const value = await response.json() as ConversationReceipt & { error?: string };
  if (!response.ok) throw new HttpResponseError(value.error || "请求失败。", response.status);
  if (!value || typeof value.requestId !== "string" || !["pending", "accepted", "rejected"].includes(value.state)) {
    throw new Error("无法确认接受回执。");
  }
  return value;
}
const pendingKey = "wand-conversation-requests-v1";
const unresolved = new Map<string, string>();
try {
  const saved = JSON.parse(localStorage.getItem(pendingKey) ?? "{}") as Record<string, string>;
  Object.entries(saved).slice(0, 200).forEach(([key, id]) => { if (typeof id === "string") unresolved.set(key, id); });
} catch {}
function savePending(): void {
  try { localStorage.setItem(pendingKey, JSON.stringify(Object.fromEntries(unresolved))); } catch {}
}
const listeners = new Set<() => void>();
export function notifyConversationChanges(): void { for (const listener of listeners) listener(); }
export const conversationsRepository = {
  list: () => requestJson<{ conversations: ConversationSummary[] }>("/api/conversations").then((r) => r.conversations),
  // Workspaces deliberately omit system calls. Read their canonical metadata, not
  // conversation transcripts or a second task projection, for the employee list.
  // Initial paint reuses the committed list; explicit refreshes force a read.
  systemSessions: (options?: { fresh?: boolean }) => loadSessionList({ force: options?.fresh })
    .then(sessions => sessions.filter(session => isSystemAiCall(session) && !!session.employeeId)),
  async updateListState(id: string, patch: { pinned?: boolean; dissolved?: boolean }): Promise<ConversationSummary> {
    const value = await requestJson<ConversationSummary>(`/api/conversations/${encodeURIComponent(id)}/list-state`, jsonBody(patch, "PATCH"));
    notifyConversationChanges(); return value;
  },
  async remove(id: string): Promise<void> {
    await requestJson(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (teamChatComposer.ready()) teamChatComposer.discardScope(`conversation-draft:${location.origin}:local-owner:${id}:`);
    notifyConversationChanges();
  },
  detail: (id: string) => requestJson<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}`),
  receipt: (requestId: string) => readReceipt(`/api/conversations/requests/${encodeURIComponent(requestId)}`),
  async post(path: string, body: Record<string, unknown>): Promise<ConversationReceipt> {
    const fingerprint = await sha256Hex(path + "\0" + JSON.stringify(body));
    const previous = unresolved.get(fingerprint);
    if (previous) throw new UnconfirmedConversationError(previous);
    if (unresolved.size >= 200) throw new HttpResponseError("请先核对未确认请求，再继续提交。", 400);
    const requestId = createRequestId();
    unresolved.set(fingerprint, requestId); savePending();
    try {
      const receipt = await readReceipt(path, jsonBody({ ...body, requestId }));
      if (receipt.requestId !== requestId || receipt.state === "pending") throw new UnconfirmedConversationError(requestId);
      if (receipt.state === "rejected") throw new HttpResponseError(receipt.error || "请求未接受。", 400);
      unresolved.delete(fingerprint); savePending();
      notifyConversationChanges();
      return receipt;
    } catch (error) {
      // Failed JSON parsing after 2xx, transport errors and 5xx/408/409 are all uncertain.
      if (error instanceof HttpResponseError && error.status >= 400 && error.status < 500
        && error.status !== 408 && error.status !== 409) {
        unresolved.delete(fingerprint); savePending();
        throw Object.assign(error, { httpStatus: error.status });
      }
      throw new UnconfirmedConversationError(requestId);
    }
  },
  pending: () => [...unresolved.values()],
  async reconcile(requestId: string): Promise<ConversationReceipt> {
    const receipt = await this.receipt(requestId);
    if (receipt.state !== "pending") {
      for (const [key, id] of unresolved) if (id === requestId) unresolved.delete(key);
      savePending();
      notifyConversationChanges();
    }
    return receipt;
  },
};

export function useConversations(includeSystemSessions = false): { items: ConversationSummary[]; systemSessions: WorkspaceSessionSummary[]; error: string; loaded: boolean; refresh(): void } {
  const [items, setItems] = React.useState<ConversationSummary[]>([]);
  const [systemSessions, setSystemSessions] = React.useState<WorkspaceSessionSummary[]>([]);
  const [error, setError] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);
  const epoch = React.useRef(0);
  const load = React.useCallback(async (fresh = false) => {
    const current = ++epoch.current;
    try {
      const [next, calls] = await Promise.all([conversationsRepository.list(),
        includeSystemSessions ? conversationsRepository.systemSessions({ fresh }) : Promise.resolve([])]);
      if (current === epoch.current) { setItems(next); setSystemSessions(calls); setLoaded(true); setError(""); }
    } catch (cause) { if (current === epoch.current) setError(cause instanceof Error ? cause.message : "对话列表读取失败。"); }
  }, [includeSystemSessions]);
  const refresh = React.useCallback(() => { void load(true); }, [load]);
  React.useEffect(() => {
    void load();
    listeners.add(refresh);
    const unsubscribes = [subscribeAiTeamRunChanges(refresh), subscribeTaskChanges(refresh), subscribeSiliconEmployeeDefinitionChanges(refresh)];
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 6000);
    return () => { ++epoch.current; listeners.delete(refresh); unsubscribes.forEach((f) => f()); clearInterval(timer); };
  }, [load, refresh]);
  return { items, systemSessions, error, loaded, refresh };
}
