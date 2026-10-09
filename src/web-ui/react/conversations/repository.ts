import { teamChatComposer } from "../ai-teams/composer-bridge";
import * as React from "react";
import type { ConversationDetail, ConversationReceipt, ConversationSummary } from "../../../conversation-types.js";
import { HttpResponseError, jsonBody, requestJson } from "../http-adapter";
import { subscribeAiTeamRunChanges } from "../ai-teams/repository";
import { subscribeSiliconEmployeeDefinitionChanges } from "../agents/employee-repository";
import { subscribeTaskChanges } from "../task-changes";

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
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path + "\0" + JSON.stringify(body)));
    const fingerprint = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
    const previous = unresolved.get(fingerprint);
    if (previous) throw new UnconfirmedConversationError(previous);
    if (unresolved.size >= 200) throw new HttpResponseError("请先核对未确认请求，再继续提交。", 400);
    const requestId = crypto.randomUUID();
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

export function useConversations(): { items: ConversationSummary[]; error: string; loaded: boolean; refresh(): void } {
  const [items, setItems] = React.useState<ConversationSummary[]>([]);
  const [error, setError] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);
  const epoch = React.useRef(0);
  const load = React.useCallback(async () => {
    const current = ++epoch.current;
    try { const next = await conversationsRepository.list(); if (current === epoch.current) { setItems(next); setLoaded(true); setError(""); } }
    catch (cause) { if (current === epoch.current) setError(cause instanceof Error ? cause.message : "对话列表读取失败。"); }
  }, []);
  React.useEffect(() => {
    void load(); listeners.add(load);
    const unsubscribes = [subscribeAiTeamRunChanges(load), subscribeTaskChanges(load), subscribeSiliconEmployeeDefinitionChanges(load)];
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 6000);
    return () => { ++epoch.current; listeners.delete(load); unsubscribes.forEach((f) => f()); clearInterval(timer); };
  }, [load]);
  return { items, error, loaded, refresh: () => { void load(); } };
}
