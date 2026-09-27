import { useSyncExternalStore } from "react";
import type { AttentionItem } from "../../../attention";
import { subscribeAiTeamRunChanges } from "../ai-teams/repository";
import { requestJson } from "../http-adapter";

interface AttentionSnapshot {
  readonly items: AttentionItem[];
}

const EMPTY: AttentionSnapshot = { items: [] };
let snapshot: AttentionSnapshot = EMPTY;
const listeners = new Set<() => void>();
let subscribers = 0;
let unsubscribeTeam: (() => void) | null = null;
let inflight: Promise<void> | null = null;

function publish(next: AttentionSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function refreshAttention(): void {
  if (inflight) return;
  inflight = requestJson<{ items: AttentionItem[] }>("/api/attention")
    .then((body) => {
      publish({ items: Array.isArray(body.items) ? body.items : [] });
    })
    .catch(() => {
      // 拉取失败保留上一份，下一条通知再试。
    })
    .finally(() => {
      inflight = null;
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  subscribers += 1;
  if (subscribers === 1) {
    unsubscribeTeam = subscribeAiTeamRunChanges(() => refreshAttention());
    refreshAttention();
  }
  return () => {
    listeners.delete(listener);
    subscribers -= 1;
    if (subscribers === 0) {
      unsubscribeTeam?.();
      unsubscribeTeam = null;
    }
  };
}

export function useAttentionItems(): readonly AttentionItem[] {
  return useSyncExternalStore(subscribe, () => snapshot.items, () => EMPTY.items);
}
