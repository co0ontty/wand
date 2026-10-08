import * as React from "react";
import { isSessionJustCompleted } from "../../../session-completion-state.js";
import { ptyTurnActive } from "../../session-activity.js";

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
    case "active": return "在跑";
    default: return "展开";
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
  // Provider liveness and an open shell are not work. Provider turns use ptyBusy/inFlight;
  // a blank terminal uses the server-observed foreground command, including silent work.
  if (session.archived) return false;
  return session.ptyBusy === true
    || session.inFlight === true
    || session.status === "thinking"
    || ptyTurnActive(session);
}

/** 「活动」= 在跑或等你处理；群聊条目按同一规则判定。 */
export function isSessionActive(session: WorkspaceSessionSummary): boolean {
  return isSessionAttention(session) || isSessionRunning(session) || isSessionJustCompleted(session);
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
      // 「只看活动」不展示归档区（归档会话本就不在跑）。
      return sessions.length ? [{ ...task, sessions, archivedSessions: [] }] : [];
    });
    const standaloneSessions = group.standaloneSessions.filter(keep);
    if (!tasks.length && !standaloneSessions.length) return [];
    return [{ ...group, tasks, standaloneSessions, archivedSessions: [] }];
  });
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

/** One presentation scope for the full list, rail and peek; never a business registry. */
export interface SidebarPresentation {
  mode: SidebarDisplayMode;
  query: string;
  setMode(mode: SidebarDisplayMode): void;
  setQuery(query: string): void;
  normal: Readonly<Record<string, boolean>>;
  setNormal(key: string, collapsed: boolean): void;
  overrides: Readonly<Record<string, boolean>>;
  setOverride(key: string, open: boolean): void;
}

export const SidebarPresentationContext = React.createContext<SidebarPresentation | null>(null);

export function sidebarModeOverrides(
  previous: SidebarDisplayMode,
  next: SidebarDisplayMode,
  overrides: Readonly<Record<string, boolean>>,
): Readonly<Record<string, boolean>> {
  return previous === next ? overrides : {};
}

export function sidebarExpansionOpen(
  mode: SidebarDisplayMode,
  normalOpen: boolean,
  override: boolean | undefined,
  foldedOpen: boolean,
  searching: boolean,
): boolean {
  if (searching) return true;
  if (mode === "full") return normalOpen;
  return override ?? (mode === "active" || foldedOpen);
}

export function useSidebarPresentation(): SidebarPresentation {
  const [mode, , persistMode] = useSidebarDisplayMode();
  const [query, setQuery] = React.useState("");
  const [normal, setNormalState] = React.useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = React.useState<Readonly<Record<string, boolean>>>({});
  const setMode = React.useCallback((next: SidebarDisplayMode): void => {
    setOverrides((current) => sidebarModeOverrides(mode, next, current));
    persistMode(next);
  }, [mode, persistMode]);
  const setNormal = React.useCallback((key: string, collapsed: boolean): void => {
    setNormalState((current) => ({ ...current, [key]: collapsed }));
  }, []);
  const setOverride = React.useCallback((key: string, open: boolean): void => {
    setOverrides((current) => ({ ...current, [key]: open }));
  }, []);
  return React.useMemo(() => ({
    mode, query, setMode, setQuery, normal, setNormal, overrides, setOverride,
  }), [mode, query, setMode, normal, setNormal, overrides, setOverride]);
}
