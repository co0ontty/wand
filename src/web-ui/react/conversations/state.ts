import { normalizeSessionRuntime, type SessionRuntimeFilter } from "./runtime-filter";
import * as React from "react";
import type { ConversationTarget } from "../../../conversation-types.js";
import { normalizeConversationTaskStage, type ConversationTaskStage, type ConversationListFilters } from "./list-filters";
import { hasPageRoute, pageSearch, scheduleReplacePageRoute, subscribePageRoute, updatePageRoute } from "../../page-route";

/** Device-local archive tier, shared by every conversation list projection. */
export type ConversationListFilter = "all" | "active" | "archived";

export interface ConversationUiState {
  mode: "chats" | "tasks";
  active: boolean | null;
  selectedId: string;
  directory: boolean;
  listFilter: ConversationListFilter;
  activityOnly: boolean;
  listRuntime: SessionRuntimeFilter;
  lastCapsuleRuntime: SessionRuntimeFilter;
  lastCapsuleWorkspace: string;
  listTaskStage: ConversationTaskStage;
  listWorkspace: string;
  targets: Record<string, ConversationTarget>;
  filters: Record<string, string>;
  scrolls: Record<string, number>;
  focusRequest: { id: string; revision: number } | null;
}
const storageKey = "wand-conversations-local-owner-v1";
function normalizeListFilter(value: unknown): ConversationListFilter {
  return value === "active" || value === "archived" ? value : "all";
}
function initial(): ConversationUiState {
  let stored: Partial<ConversationUiState> = {};
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) stored = value;
  } catch {}
  return { mode: stored.mode === "tasks" ? "tasks" : "chats", active: stored.active ?? null,
    selectedId: typeof stored.selectedId === "string" ? stored.selectedId : "", directory: false,
    listFilter: normalizeListFilter(stored.listFilter), activityOnly: stored.activityOnly === true,
    listRuntime: normalizeSessionRuntime(stored.listRuntime ?? (stored.activityOnly ? "active" : "all")),
    lastCapsuleRuntime: normalizeSessionRuntime(stored.lastCapsuleRuntime ?? stored.listRuntime) === "all" ? "working" : normalizeSessionRuntime(stored.lastCapsuleRuntime ?? stored.listRuntime),
    lastCapsuleWorkspace: typeof (stored.lastCapsuleWorkspace ?? stored.listWorkspace) === "string" ? (stored.lastCapsuleWorkspace ?? stored.listWorkspace)! : "",
    listTaskStage: normalizeConversationTaskStage(stored.listTaskStage),
    listWorkspace: typeof stored.listWorkspace === "string" && (stored.listWorkspace === "none" || stored.listWorkspace.startsWith("id:")) ? stored.listWorkspace : "all",
    targets: stored.targets ?? {}, filters: stored.filters ?? {}, scrolls: stored.scrolls ?? {}, focusRequest: null };
}
function fromRoute(base: ConversationUiState): ConversationUiState {
  const params = new URLSearchParams(pageSearch());
  if (!hasPageRoute()) return base;
  const view = params.get("view");
  const id = params.get("conversation") ?? "";
  const taskId = params.get("conversationTask") ?? "";
  const runId = params.get("conversationRun");
  const runtime = normalizeSessionRuntime(params.get("chatRuntime") ?? (params.get("chatActivity") === "true" ? "active" : "all"));
  const workspace = params.get("chatWorkspace") ?? "all";
  return { ...base, mode: params.get("sidebar") === "tasks" ? "tasks" : params.get("sidebar") === "chats" || view === "chats" || view === "contacts" ? "chats" : "tasks",
    active: view === "chats" || view === "contacts", directory: view === "contacts", selectedId: id,
    listRuntime: runtime,
    lastCapsuleRuntime: runtime === "all" ? base.lastCapsuleRuntime : runtime,
    lastCapsuleWorkspace: workspace === "all" ? base.lastCapsuleWorkspace : workspace,
    listTaskStage: normalizeConversationTaskStage(params.get("chatTaskStage")),
    listWorkspace: params.get("chatWorkspace") ?? "all",
    listFilter: normalizeListFilter(params.get("chatFilter")), activityOnly: params.get("chatActivity") === "true",
    filters: { "list-query": params.get("chatQuery") ?? "", ...(id ? { [id]: taskId } : {}) },
    targets: id ? { [id]: taskId && runId ? { taskId, runId } : null } : {}, focusRequest: base.selectedId === id ? base.focusRequest : null };
}
let state = fromRoute(initial());
let selectionRevision = 0;
const listeners = new Set<() => void>();
function update(patch: Partial<ConversationUiState>): void {
  state = { ...state, ...patch };
  try { localStorage.setItem(storageKey, JSON.stringify({ ...state, directory: false, focusRequest: null })); } catch {}
  const params: Record<string, string | null> = {};
  if ("mode" in patch) params.sidebar = state.mode;
  if ("active" in patch || "directory" in patch || "selectedId" in patch) {
    params.view = state.directory ? "contacts" : state.active ? "chats" : "workspace";
    params.sidebar = state.mode;
    params.conversation = state.selectedId;
  }
  if ("listRuntime" in patch) params.chatRuntime = state.listRuntime === "all" ? null : state.listRuntime;
  if ("listTaskStage" in patch) params.chatTaskStage = state.listTaskStage === "all" ? null : state.listTaskStage;
  if ("listWorkspace" in patch) params.chatWorkspace = state.listWorkspace === "all" ? null : state.listWorkspace;
  if ("listFilter" in patch) params.chatFilter = state.listFilter === "all" ? null : state.listFilter;
  if ("activityOnly" in patch) params.chatActivity = state.activityOnly ? "true" : null;
  if ("filters" in patch) { params.chatQuery = state.filters["list-query"] ?? ""; params.conversationTask = state.filters[state.selectedId] ?? ""; }
  if ("targets" in patch) { params.conversationTask = state.targets[state.selectedId]?.taskId ?? ""; params.conversationRun = state.targets[state.selectedId]?.runId ?? ""; }
  const navigates = "selectedId" in patch || "active" in patch || "directory" in patch;
  const queryOnly = !navigates && Object.keys(patch).every(key => key === "filters");
  // Only a change of destination earns a history entry; typing and filters settle into one replace.
  if (queryOnly) scheduleReplacePageRoute(params);
  else updatePageRoute(params, navigates ? "push" : "replace");
  for (const listener of listeners) listener();
}
subscribePageRoute(() => {
  const next = fromRoute(state);
  if (next.selectedId !== state.selectedId || next.active !== state.active) ++selectionRevision;
  state = next;
  for (const listener of listeners) listener();
});
export const conversationUi = {
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => state,
  selectionRevision: () => selectionRevision,
  select: (id: string, focusComposer = false) => {
    const revision = ++selectionRevision;
    update({ selectedId: id, active: true, directory: false, focusRequest: focusComposer ? { id, revision } : null });
  },
  openTask: (id: string, taskId: string, runId: string | null) => {
    ++selectionRevision;
    update({ selectedId: id, active: true, directory: false, focusRequest: null,
      filters: { ...state.filters, [id]: taskId }, targets: { ...state.targets, [id]: runId ? { taskId, runId } : null } });
  },
  consumeFocus: (revision: number) => { if (state.focusRequest?.revision === revision) update({ focusRequest: null }); },
  show: () => { ++selectionRevision; update({ active: true, directory: false, focusRequest: null }); },
  suspend: () => { ++selectionRevision; update({ active: false, directory: false, focusRequest: null }); },
  directory: (open: boolean) => { ++selectionRevision; update({ directory: open, active: open ? true : state.active, focusRequest: null }); },
  mode: (mode: "chats" | "tasks") => update({ mode, active: mode === "chats", directory: false, focusRequest: null }),
  listFilter: (value: string) => update({ listFilter: normalizeListFilter(value) }),
  activityOnly: (value: boolean) => update({ activityOnly: value, listRuntime: value ? "active" : "all" }),
  listFacets: (value: ConversationListFilters) => {
    const runtime = normalizeSessionRuntime(value.runtime === "active" && !value.activityOnly ? "all" : value.activityOnly && (!value.runtime || value.runtime === "all") ? "active" : value.runtime);
    update({ listTaskStage: value.taskStage, listWorkspace: value.workspace,
      listFilter: normalizeListFilter(value.archive), activityOnly: value.activityOnly, listRuntime: runtime,
      ...(runtime !== "all" ? { lastCapsuleRuntime: runtime } : {}),
      ...(value.workspace !== "all" ? { lastCapsuleWorkspace: value.workspace } : {}) });
  },
  target: (id: string, target: ConversationTarget) => update({ targets: { ...state.targets, [id]: target } }),
  filter: (id: string, filter: string) => update({ filters: { ...state.filters, [id]: filter } }),
  scroll: (id: string, value: number) => update({ scrolls: { ...state.scrolls, [id]: value } }),
};
export function useConversationUi(): ConversationUiState {
  return React.useSyncExternalStore(conversationUi.subscribe, conversationUi.getSnapshot, conversationUi.getSnapshot);
}
export function conversationDraftKey(id: string, target: ConversationTarget, dispatch = false): string {
  const scope = typeof location === "undefined" ? "server" : location.origin;
  return `conversation-draft:${scope}:local-owner:${id || "unselected"}:${dispatch ? "dispatch" : target ? `${target.taskId}:${target.runId}` : "talk"}`;
}
