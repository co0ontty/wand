import { mergeConversationSync, type ConversationSync } from "../../../conversation-sync-contract.js";
import { teamChatComposer } from "../ai-teams/composer-bridge";
import * as React from "react";
import type { ConversationDetail, ConversationReceipt, ConversationSummary } from "../../../conversation-types.js";
import { createRequestId, HttpResponseError, jsonBody, requestJson } from "../http-adapter";
import { sha256Hex } from "../sha256";
import { subscribeAiTeamRunChanges } from "../ai-teams/repository";
import { subscribeSiliconEmployeeDefinitionChanges } from "../agents/employee-repository";
import { subscribeTaskChanges } from "../task-changes";
import { isSystemAiCall } from "../../../system-ai-call.js";
import { loadSessionList, markSessionListStale, peekSessionList, subscribeSessionList } from "../session-list-snapshot";
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
export function subscribeConversationChanges(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export const conversationsRepository = {
  list: () => requestJson<{ conversations: ConversationSummary[] }>("/api/conversations").then((r) => r.conversations),
  // Workspaces deliberately omit system calls. Read their canonical metadata, not
  // conversation transcripts or a second task projection, for the employee list.
  // The session list is owned by the legacy engine and shared as one snapshot:
  // the initial paint reuses the committed value, an explicit refresh forces a read.
  systemSessions: (options?: { fresh?: boolean; maxAgeMs?: number }) => loadSessionList({ force: options?.fresh, maxAgeMs: options?.maxAgeMs })
    .then(sessions => sessions.filter(session => isSystemAiCall(session) && !!session.employeeId)),
  /** 同步读当前已提交的列表投影：引擎发布新列表时不必再发一次请求。 */
  peekSystemSessions: (): WorkspaceSessionSummary[] => {
    const sessions = peekSessionList();
    return sessions ? sessions.filter(session => isSystemAiCall(session) && !!session.employeeId) : [];
  },
  async updateListState(id: string, patch: { pinned?: boolean; dissolved?: boolean }): Promise<ConversationSummary> {
    const value = await requestJson<ConversationSummary>(`/api/conversations/${encodeURIComponent(id)}/list-state`, jsonBody(patch, "PATCH"));
    notifyConversationChanges(); return value;
  },
  async remove(id: string): Promise<void> {
    await requestJson(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (teamChatComposer.ready()) teamChatComposer.discardScope(`conversation-draft:${location.origin}:local-owner:${id}:`);
    notifyConversationChanges();
  },
  async detail(id: string, previous: ConversationDetail | null = null, older = false): Promise<ConversationDetail> {
    const params = new URLSearchParams();
    if (previous?.id === id && previous.history) {
      params.set("since", previous.history.revision);
      if (previous.history.from) params.set("from", previous.history.from);
    }
    if (older) params.set("older", "1");
    try {
      const update = await requestJson<ConversationSync>(`/api/conversations/${encodeURIComponent(id)}/sync?${params}`);
      return mergeConversationSync(previous, update);
    } catch (error) {
      if (error instanceof HttpResponseError && error.status === 404) return requestJson<ConversationDetail>(`/api/conversations/${encodeURIComponent(id)}`);
      throw error;
    }
  },
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

/** 轮询时允许复用的会话列表读取预算：超过它才重新下载全量。 */
const SESSION_LIST_MAX_AGE_MS = 60_000;

/**
 * 对话列表的读与轮询。
 * `enabled` 是可见性门控：隐藏的列表（用户在别的页面、侧栏收起）不读也不轮询，
 * 6 秒一次的全量刷新只在列表真的可见时跑。已经读到的数据留在组件状态里，
 * 重新可见时补读一次即可，不丢列表、草稿或滚动位置。
 */
export function useConversations(includeSystemSessions = false, enabled = true): { items: ConversationSummary[]; systemSessions: WorkspaceSessionSummary[]; error: string; loaded: boolean; refresh(): void } {
  const [items, setItems] = React.useState<ConversationSummary[]>([]);
  const [systemSessions, setSystemSessions] = React.useState<WorkspaceSessionSummary[]>([]);
  const [error, setError] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);
  const epoch = React.useRef(0);
  // 引擎发布新列表时代次 +1：在途读取的旧结果不得覆盖已经更新的投影。
  const projection = React.useRef(0);
  const load = React.useCallback(async (fresh = false, maxAgeMs?: number) => {
    const current = ++epoch.current;
    const projected = projection.current;
    try {
      const [next, calls] = await Promise.all([conversationsRepository.list(),
        includeSystemSessions ? conversationsRepository.systemSessions({ fresh, maxAgeMs }) : Promise.resolve([])]);
      if (current === epoch.current) { setItems(next); setLoaded(true); setError(""); }
      // 迟到的结果只在没有更新的投影到达时写入。
      if (current === epoch.current && projected === projection.current) setSystemSessions(calls);
    } catch (cause) { if (current === epoch.current) setError(cause instanceof Error ? cause.message : "对话列表读取失败。"); }
  }, [includeSystemSessions]);
  // 用户主动刷新才绕过已提交的会话列表快照；轮询与变更通知复用快照，不重下全量。
  const refresh = React.useCallback(() => { void load(true); }, [load]);
  // 轮询：会话列表只在快照过期（距上一次真实读取超过预算）时才重新下载。
  // 引擎发布的本地投影不重置这个时钟，所以跨端归档最终仍会被读到。
  const reload = React.useCallback(() => { void load(false, SESSION_LIST_MAX_AGE_MS); }, [load]);
  // 员工改名/归档会改写列表投影里的 employeeName 与可见性：把共享快照标记为过期，
  // 下一次读重新拉一次全量；有变更才下载，平时不重复下载。
  const reloadAfterEmployeeChange = React.useCallback(() => {
    markSessionListStale();
    void load(false);
  }, [load]);
  React.useEffect(() => {
    if (!includeSystemSessions) return undefined;
    // 引擎是会话列表的唯一 owner：它发布新列表时直接重投影，不再发请求。
    return subscribeSessionList(() => {
      projection.current++;
      setSystemSessions(conversationsRepository.peekSystemSessions());
    });
  }, [includeSystemSessions]);
  React.useEffect(() => {
    if (!enabled) return undefined;
    void load();
    // 「对话列表变了」的显式通知：重新读一次对话列表；会话列表复用共享快照，
    // 只有引擎发布或快照过期时才重新下载全量。
    listeners.add(reload);
    const unsubscribes = [subscribeAiTeamRunChanges(reload), subscribeTaskChanges(reload), subscribeSiliconEmployeeDefinitionChanges(reloadAfterEmployeeChange)];
    const timer = window.setInterval(() => { if (!document.hidden) void reload(); }, 30_000);
    return () => { ++epoch.current; listeners.delete(reload); unsubscribes.forEach((f) => f()); clearInterval(timer); };
  }, [load, reload, reloadAfterEmployeeChange, enabled]);
  return { items, systemSessions, error, loaded, refresh };
}
