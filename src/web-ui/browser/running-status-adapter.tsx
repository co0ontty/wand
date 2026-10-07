import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { WandUiProvider } from "../react/theme";
import { RunningStatusBar } from "../react/chat/running-status-bar";
import type { RunningActivityShape } from "../running-activity";

interface Island {
  root: Root;
  lastKey: string;
}

const islands = new Map<HTMLElement, Island>();

function keyOf(activity: RunningActivityShape | null | undefined): string {
  if (!activity) return "";
  const structured = activity.structuredState;
  return [
    activity.status ?? "",
    activity.ptyRunning ? "1" : "0",
    activity.permissionBlocked ? "1" : "0",
    activity.pendingEscalation ? "1" : "0",
    structured?.inFlight ? "1" : "0",
    structured?.phase ?? "",
    structured?.turnStartedAt ?? "",
    structured?.lastActivityAt ?? "",
    activity.turnStartedAt ?? "",
    activity.lastActivityAt ?? "",
    activity.queuedMessages?.length ?? 0,
  ].join("|");
}

function disposeDisconnected(): void {
  for (const [node, island] of islands) {
    if (!node.isConnected) {
      island.root.unmount();
      islands.delete(node);
    }
  }
}

/**
 * 把会话运行事实投影成状态条。只有服务端事实/锚点变化时才重绘，
 * 计时推进由组件内部完成，避免每次输出 chunk 都重新挂载导致读数归零。
 */
export function paintRunningStatusBar(
  host: HTMLElement,
  activity: RunningActivityShape | null | undefined,
): void {
  disposeDisconnected();
  const key = keyOf(activity);
  let island = islands.get(host);
  if (island && island.lastKey === key) return;
  if (!island) {
    island = { root: createRoot(host), lastKey: key };
    islands.set(host, island);
  } else {
    island.lastKey = key;
  }
  island.root.render(<WandUiProvider><RunningStatusBar activity={activity ?? null} /></WandUiProvider>);
}

export function clearRunningStatusBar(host: HTMLElement): void {
  const island = islands.get(host);
  if (island) {
    island.root.unmount();
    islands.delete(host);
  }
  host.replaceChildren();
}
