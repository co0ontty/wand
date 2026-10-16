import * as React from "react";
import type { ConversationTarget } from "../../../conversation-types.js";

/** Device-local archive tier, shared by every conversation list projection. */
export type ConversationListFilter = "all" | "active" | "archived";

export interface ConversationUiState {
  mode: "chats" | "tasks";
  active: boolean | null;
  selectedId: string;
  directory: boolean;
  listFilter: ConversationListFilter;
  activityOnly: boolean;
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
    targets: stored.targets ?? {}, filters: stored.filters ?? {}, scrolls: stored.scrolls ?? {}, focusRequest: null };
}
let state = initial();
let selectionRevision = 0;
const listeners = new Set<() => void>();
function update(patch: Partial<ConversationUiState>): void {
  state = { ...state, ...patch };
  try { localStorage.setItem(storageKey, JSON.stringify({ ...state, directory: false, focusRequest: null })); } catch {}
  for (const listener of listeners) listener();
}
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
  mode: (mode: "chats" | "tasks") => update({ mode }),
  listFilter: (value: string) => update({ listFilter: normalizeListFilter(value) }),
  activityOnly: (value: boolean) => update({ activityOnly: value }),
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
