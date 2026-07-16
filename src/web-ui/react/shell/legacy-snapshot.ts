import type {
  UiAuthPhase,
  UiProvider,
  UiSessionStatus,
  UiSessionVm,
  UiSnapshotData,
} from "./ui-store";

export interface LegacySnapshotState {
  selectedId?: string | null;
  sessions?: readonly LegacySession[];
  config?: { defaultCwd?: string; cwd?: string } | null;
  loginChecked?: boolean;
  bootstrapping?: boolean;
  isOnline?: boolean;
  sessionsDrawerOpen?: boolean;
  sidebarPinned?: boolean;
  sidebarCollapsed?: boolean;
  filePanelOpen?: boolean;
  topbarMoreOpen?: boolean;
  currentView?: string;
  sessionsManageMode?: boolean;
  selectedSessionIds?: Readonly<Record<string, boolean>>;
  selectedClaudeHistoryIds?: Readonly<Record<string, boolean>>;
  selectedCodexHistoryIds?: Readonly<Record<string, boolean>>;
  claudeHistory?: readonly LegacyHistorySession[];
  claudeHistoryLoaded?: boolean;
  codexHistory?: readonly LegacyHistorySession[];
  codexHistoryLoaded?: boolean;
  workingDir?: string;
  currentTask?: { title?: string } | null;
  gitStatus?: LegacyGitStatus | null;
  gitStatusSessionId?: string | null;
}

export interface LegacySession {
  id?: string;
  provider?: string;
  command?: string;
  sessionKind?: string;
  sessionSource?: string;
  title?: string;
  description?: string;
  summary?: string;
  cwd?: string;
  status?: string;
  permissionBlocked?: boolean;
  structuredState?: { inFlight?: boolean } | null;
  startedAt?: string;
  endedAt?: string;
  claudeSessionId?: string;
  currentTaskTitle?: string;
  worktree?: {
    enabled?: boolean;
    branch?: string;
    path?: string;
    mergeStatus?: string;
  } | null;
  worktreeEnabled?: boolean;
  worktreeBranch?: string;
  worktreePath?: string;
  worktreeMergeStatus?: string;
}

export interface LegacyHistorySession {
  claudeSessionId?: string;
  provider?: string;
  cwd?: string;
  firstUserMessage?: string;
  title?: string;
  summary?: string;
  timestamp?: string;
  mtimeMs?: number;
  hasConversation?: boolean;
  managedByWand?: boolean;
}

export interface LegacyGitStatus {
  isGit?: boolean;
  branch?: string;
  modifiedCount?: number;
}

export interface LegacySnapshotEnvironment {
  width: number;
  online: boolean;
  embedTerminal: boolean;
  nativeInput: boolean;
  backToNative: boolean;
  switchServer: boolean;
  automationExpanded?: boolean;
  historyExpanded?: boolean;
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  idle: "空闲",
  stopped: "已停止",
  running: "运行中",
  exited: "已退出",
  failed: "已失败",
};

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function timestamp(value: string | undefined, fallback = 0): number {
  if (!value) return fallback;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

function countSelected(map: Readonly<Record<string, boolean>> | undefined): number {
  if (!map) return 0;
  return Object.values(map).filter(Boolean).length;
}

function authPhase(state: LegacySnapshotState): UiAuthPhase {
  if (state.config) return "authenticated";
  return state.loginChecked ? "anonymous" : "booting";
}

function isAutomation(session: LegacySession): boolean {
  const source = asString(session.sessionSource).toLowerCase();
  return source === "automation" || source === "startup";
}

function sessionStatusLabel(session: LegacySession): string {
  if (session.permissionBlocked) return "等待授权";
  if (session.sessionKind === "structured" && session.structuredState?.inFlight) return "思考中";
  const status = asString(session.status, "idle");
  return STATUS_LABELS[status] ?? status;
}

function sessionStatusTone(session: LegacySession): string {
  if (session.permissionBlocked) return "permission-blocked";
  if (session.sessionKind === "structured" && session.structuredState?.inFlight) return "running";
  return asString(session.status);
}

function defaultCwd(state: LegacySnapshotState): string {
  return asString(state.workingDir)
    || asString(state.config?.defaultCwd)
    || asString(state.config?.cwd)
    || "/tmp";
}

function sessionTitle(session: LegacySession): string {
  return asString(session.title)
    || asString(session.description)
    || asString(session.summary)
    || asString(session.command)
    || "Wand 会话";
}

function sessionToVm(
  session: LegacySession,
  state: LegacySnapshotState,
  manageSelection: Readonly<Record<string, boolean>>,
): UiSessionVm {
  const id = asString(session.id);
  const provider = asString(session.provider, asString(session.command, "claude")) as UiProvider;
  const status = asString(session.status, "idle") as UiSessionStatus;
  const kind = session.sessionKind === "structured" ? "structured" : "pty";
  const worktreeEnabled = Boolean(session.worktree?.enabled ?? session.worktreeEnabled);
  const source = isAutomation(session) ? "automation" : "wand";

  return {
    id,
    source,
    provider,
    kind,
    title: sessionTitle(session),
    description: asString(session.description),
    cwd: asString(session.cwd, defaultCwd(state)),
    status,
    statusLabel: sessionStatusLabel(session),
    active: id !== "" && id === state.selectedId,
    selected: Boolean(manageSelection[id]),
    resumable: kind !== "structured"
      && status !== "running"
      && (provider === "claude" || provider === "codex")
      && Boolean(session.claudeSessionId),
    permissionBlocked: Boolean(session.permissionBlocked),
    inFlight: Boolean(session.structuredState?.inFlight),
    ...(session.startedAt ? { startedAt: session.startedAt } : {}),
    ...(session.endedAt ? { endedAt: session.endedAt } : {}),
    ...(session.claudeSessionId ? { claudeSessionId: session.claudeSessionId } : {}),
    ...(worktreeEnabled ? {
      worktree: {
        enabled: true,
        branch: asString(session.worktree?.branch ?? session.worktreeBranch) || undefined,
        path: asString(session.worktree?.path ?? session.worktreePath) || undefined,
        mergeStatus: asString(session.worktree?.mergeStatus ?? session.worktreeMergeStatus) || undefined,
      },
    } : {}),
  };
}

function historyToVm(
  history: LegacyHistorySession,
  provider: "claude" | "codex",
  state: LegacySnapshotState,
  selected: Readonly<Record<string, boolean>>,
): UiSessionVm {
  const id = asString(history.claudeSessionId);
  const historyStartedAt = history.timestamp
    || (Number.isFinite(history.mtimeMs) && Number(history.mtimeMs) > 0
      ? new Date(Number(history.mtimeMs)).toISOString()
      : undefined);
  return {
    id,
    source: provider === "codex" ? "codex-history" : "claude-history",
    provider,
    kind: "pty",
    title: asString(history.firstUserMessage)
      || asString(history.title)
      || asString(history.summary)
      || "（空会话）",
    description: "",
    cwd: asString(history.cwd, defaultCwd(state)),
    status: "stopped",
    statusLabel: "历史",
    active: false,
    selected: Boolean(selected[id]),
    resumable: Boolean(id),
    permissionBlocked: false,
    inFlight: false,
    ...(historyStartedAt ? { startedAt: historyStartedAt } : {}),
    ...(id ? { claudeSessionId: id } : {}),
  };
}

function visibleHistory(
  histories: readonly LegacyHistorySession[] | undefined,
  managedIds: ReadonlySet<string>,
): LegacyHistorySession[] {
  return (histories ?? []).filter((history) => {
    const id = asString(history.claudeSessionId);
    return Boolean(id)
      && Boolean(history.hasConversation)
      && !history.managedByWand
      && !managedIds.has(id);
  });
}

function sortSessionVms(entries: UiSessionVm[]): UiSessionVm[] {
  return entries.sort((left, right) => timestamp(right.startedAt) - timestamp(left.startedAt));
}

/** Derives the complete low-frequency React shell contract from legacy state. */
export function deriveLegacyUiSnapshot(
  state: LegacySnapshotState,
  environment: LegacySnapshotEnvironment,
): UiSnapshotData {
  const sessions = state.sessions ?? [];
  const sessionSelection = state.selectedSessionIds ?? {};
  const claudeSelection = state.selectedClaudeHistoryIds ?? {};
  const codexSelection = state.selectedCodexHistoryIds ?? {};
  const sessionVms = sessions.map((session) => sessionToVm(session, state, sessionSelection));
  const selected = sessionVms.find((session) => session.id === state.selectedId) ?? null;
  const selectedLegacy = sessions.find((session) => session.id === state.selectedId) ?? null;
  const managedProviderIds = new Set(
    sessions.map((session) => asString(session.claudeSessionId)).filter(Boolean),
  );
  const wand = sortSessionVms(sessionVms.filter((session) => session.source === "wand"));
  const automation = sortSessionVms(sessionVms.filter((session) => session.source === "automation"));
  const histories: UiSessionVm[] = [];
  if (state.claudeHistoryLoaded) {
    histories.push(...visibleHistory(state.claudeHistory, managedProviderIds)
      .map((history) => historyToVm(history, "claude", state, claudeSelection)));
  }
  if (state.codexHistoryLoaded) {
    histories.push(...visibleHistory(state.codexHistory, managedProviderIds)
      .map((history) => historyToVm(history, "codex", state, codexSelection)));
  }
  histories.sort((left, right) => timestamp(right.startedAt) - timestamp(left.startedAt));

  const mobile = environment.width <= 768;
  const drawerOpen = Boolean(state.sessionsDrawerOpen);
  const sidebarPinned = Boolean(state.sidebarPinned);
  const sidebarCollapsed = Boolean(state.sidebarCollapsed);
  const filePanelOpen = Boolean(state.filePanelOpen);
  const structuredSelected = selected?.kind === "structured";
  const currentView = structuredSelected || state.currentView === "chat" ? "chat" : "terminal";
  const manageMode = Boolean(state.sessionsManageMode);
  const selectedCount = countSelected(sessionSelection)
    + countSelected(claudeSelection)
    + countSelected(codexSelection);
  const effectiveCwd = selected?.cwd ?? defaultCwd(state);
  const gitStatus = selected
    && state.gitStatusSessionId === selected.id
    && state.gitStatus?.isGit
    ? {
        branch: asString(state.gitStatus.branch, "?"),
        modifiedCount: Number(state.gitStatus.modifiedCount) || 0,
        clean: (Number(state.gitStatus.modifiedCount) || 0) === 0,
      }
    : null;

  return {
    auth: { phase: authPhase(state) },
    viewport: {
      mobile,
      online: typeof state.isOnline === "boolean" ? state.isOnline : environment.online,
      embedTerminal: environment.embedTerminal,
      nativeInput: environment.nativeInput,
    },
    capabilities: {
      backToNative: environment.backToNative,
      switchServer: environment.switchServer,
    },
    layout: {
      sessionsDrawerOpen: drawerOpen,
      sidebarPinned,
      sidebarCollapsed,
      sidebarAnchored: sidebarCollapsed || (!mobile && (sidebarPinned || drawerOpen)),
      sessionsBackdropVisible: drawerOpen && (mobile || !sidebarPinned),
      filePanelOpen,
      filePanelBackdropVisible: filePanelOpen && mobile,
      topbarMoreOpen: Boolean(state.topbarMoreOpen),
      currentView,
    },
    selected,
    sidebar: {
      interactiveCount: sessions.filter((session) => !isAutomation(session)).length,
      totalCount: wand.length + automation.length + histories.length,
      manageMode,
      selectedCount,
      groups: [
        { kind: "wand", label: "Wand 会话", expanded: true, entries: wand },
        {
          kind: "automation",
          label: "自动化",
          expanded: manageMode || Boolean(environment.automationExpanded),
          entries: automation,
        },
        {
          kind: "history",
          label: "非 Wand 会话",
          expanded: manageMode || Boolean(environment.historyExpanded),
          entries: histories,
        },
      ],
    },
    topbar: {
      title: selected?.title ?? "Wand 控制台",
      description: selected?.description ?? "",
      statusLabel: selected?.statusLabel ?? "",
      statusTone: selectedLegacy ? sessionStatusTone(selectedLegacy) : "",
      cwd: effectiveCwd,
      currentTask: asString(state.currentTask?.title)
        || asString(selectedLegacy?.currentTaskTitle),
      git: gitStatus,
    },
    legacyVisibility: {
      terminal: Boolean(selected) && currentView === "terminal",
      chat: Boolean(selected) && currentView === "chat",
      blank: !selected,
      composer: Boolean(selected),
    },
  };
}
