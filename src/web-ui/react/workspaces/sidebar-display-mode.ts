import * as React from "react";

import type { TaskDirectoryGroup, WorkspaceSessionSummary } from "./types";

/**
 * 侧栏三态显示模式，循环切换、设备本地持久化（和聊天宽度偏好一样不上服务端）：
 * full = 全部会话照常展开；folded = 终端一律收起，只看目录和任务；
 * active = 只留下在跑的或等你的，其余整条不显示。
 */
export type SidebarDisplayMode = "full" | "folded" | "active";

export const SIDEBAR_DISPLAY_MODE_STORAGE_KEY = "wand.sidebar.displayMode";

const SIDEBAR_DISPLAY_MODES: readonly SidebarDisplayMode[] = ["full", "folded", "active"];

/** 等用户处理的会话状态，和任务行的「待处理」同一套词表。 */
const ATTENTION_STATUSES = new Set([
  "failed",
  "waiting-input",
  "waiting_input",
  "permission-blocked",
  "reconnecting",
]);

export function parseSidebarDisplayMode(raw: string | null | undefined): SidebarDisplayMode {
  return SIDEBAR_DISPLAY_MODES.includes(raw as SidebarDisplayMode)
    ? (raw as SidebarDisplayMode)
    : "full";
}

export function nextSidebarDisplayMode(mode: SidebarDisplayMode): SidebarDisplayMode {
  const index = SIDEBAR_DISPLAY_MODES.indexOf(mode);
  return SIDEBAR_DISPLAY_MODES[(index + 1) % SIDEBAR_DISPLAY_MODES.length];
}

export function sidebarDisplayModeLabel(mode: SidebarDisplayMode): string {
  switch (mode) {
    case "folded": return "收起";
    case "active": return "只看活动";
    default: return "全部";
  }
}

/** 按钮说明当前状态，标题里点明下一次点击会去哪一档。 */
export function sidebarDisplayModeHint(mode: SidebarDisplayMode): string {
  switch (mode) {
    case "folded": return "显示模式：收起终端 · 点击展开全部";
    case "active": return "显示模式：只看活动会话 · 点击回到全部";
    default: return "显示模式：全部会话 · 点击收起终端";
  }
}

export function isSessionAttention(session: WorkspaceSessionSummary): boolean {
  return ATTENTION_STATUSES.has(String(session.status ?? ""));
}

export function isSessionRunning(session: WorkspaceSessionSummary): boolean {
  // Provider CLIs stay alive at their prompt between turns, so liveness alone
  // (`providerCliActive`) is not "running". Only a real in-flight turn counts:
  // ptyBusy for PTY (bridge or quiet-window tracker) and inFlight for structured.
  return session.ptyBusy === true
    || session.inFlight === true
    || session.status === "thinking";
}

/** 「活动」= 在跑或等你处理；群聊条目按同一规则判定。 */
export function isSessionActive(session: WorkspaceSessionSummary): boolean {
  return isSessionAttention(session) || isSessionRunning(session);
}

/** 只看活动：任务里只留在动的会话，没有活动会话的任务和目录整条不显示；正在看的那条始终保留。 */
export function filterActiveGroups(
  groups: readonly TaskDirectoryGroup[],
  selectedSessionId?: string | null,
): TaskDirectoryGroup[] {
  return groups.flatMap((group) => {
    const keep = (session: WorkspaceSessionSummary): boolean => (
      isSessionActive(session) || session.id === selectedSessionId
    );
    const tasks = group.tasks.flatMap((task) => {
      const sessions = task.sessions.filter(keep);
      return sessions.length ? [{ ...task, sessions }] : [];
    });
    const standaloneSessions = group.standaloneSessions.filter(keep);
    if (!tasks.length && !standaloneSessions.length) return [];
    return [{ ...group, tasks, standaloneSessions }];
  });
}

/** 跨目录收集活动会话，供列表上方的「正在运行」条使用。 */
export interface ActiveSessionEntry {
  session: WorkspaceSessionSummary;
  group: TaskDirectoryGroup;
  taskName: string | null;
}

export function collectActiveSessions(
  groups: readonly TaskDirectoryGroup[],
  limit = 6,
): ActiveSessionEntry[] {
  const entries: ActiveSessionEntry[] = [];
  for (const group of groups) {
    for (const task of group.tasks) {
      for (const session of task.sessions) {
        if (isSessionActive(session)) entries.push({ session, group, taskName: task.name });
      }
    }
    for (const session of group.standaloneSessions) {
      if (isSessionActive(session)) entries.push({ session, group, taskName: null });
    }
  }
  // 等你的排在前面，其次是在跑的；同样状态按最近启动。
  const rank = (entry: ActiveSessionEntry): number => (isSessionAttention(entry.session) ? 0 : 1);
  return entries
    .sort((left, right) => {
      const byRank = rank(left) - rank(right);
      if (byRank) return byRank;
      return Date.parse(right.session.startedAt || "") - Date.parse(left.session.startedAt || "");
    })
    .slice(0, Math.max(0, limit));
}

export function useSidebarDisplayMode(): [SidebarDisplayMode, () => void, (mode: SidebarDisplayMode) => void] {
  const [mode, setMode] = React.useState<SidebarDisplayMode>(() => {
    try {
      return parseSidebarDisplayMode(window.localStorage.getItem(SIDEBAR_DISPLAY_MODE_STORAGE_KEY));
    } catch {
      return "full";
    }
  });
  const update = React.useCallback((next: SidebarDisplayMode): void => {
    setMode(next);
    try {
      window.localStorage.setItem(SIDEBAR_DISPLAY_MODE_STORAGE_KEY, next);
    } catch {
      return;
    }
  }, []);
  const cycle = React.useCallback(() => update(nextSidebarDisplayMode(mode)), [mode, update]);
  return [mode, cycle, update];
}
