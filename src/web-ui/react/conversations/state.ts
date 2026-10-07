import * as React from "react";
import type { ConversationTarget } from "../../../conversation-types.js";

export interface ConversationUiState {
  mode: "chats" | "tasks";
  active: boolean | null;
  selectedId: string;
  directory: boolean;
  targets: Record<string, ConversationTarget>;
  filters: Record<string, string>;
  scrolls: Record<string, number>;
  focusRequest: { id: string; revision: number } | null;
}
const storageKey = "wand-conversations-local-owner-v1";
function initial(): ConversationUiState {
  let stored: Partial<ConversationUiState> = {};
  try { stored = JSON.parse(localStorage.getItem(storageKey) ?? "{}"); } catch {}
  return { mode: stored.mode === "tasks" ? "tasks" : "chats", active: stored.active ?? null,
    selectedId: typeof stored.selectedId === "string" ? stored.selectedId : "", directory: false,
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
