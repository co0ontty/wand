import { inferProviderIdFromCommand, normalizeProviderId } from "../../provider-identity";
import type {
  UiAuthPhase,
  UiProvider,
  UiSessionStatus,
  UiSessionVm,
  UiSnapshotData,
} from "./ui-store";
import { isIdleAtPrompt } from "./ui-store";

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

interface LegacySession {
  id?: string;
  provider?: string;
  command?: string;
  sessionKind?: string;
  sessionSource?: string;
  title?: string;
  description?: string;
  summary?: string;
  titleGenerating?: boolean;
  cwd?: string;
  status?: string;
  permissionBlocked?: boolean;
  ptyBusy?: boolean;
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

interface LegacyHistorySession {
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

interface LegacyGitStatus {
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
  thinking: "思考中",
  "waiting-input": "等待输入",
  waiting_input: "等待输入",
  reconnecting: "重连中",
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
  const kind = session.sessionKind === "structured" ? "structured" : "pty";
  if (kind === "structured" && session.structuredState?.inFlight) return "思考中";
  const status = asString(session.status, "idle");
  // provider CLI 进程活着但本轮已结束 → 空闲而不是运行中
  if (isIdleAtPrompt(kind, status, session.provider ?? "", Boolean(session.ptyBusy))) return "空闲";
  return STATUS_LABELS[status] ?? status;
}

function sessionStatusTone(session: LegacySession): string {
  if (session.permissionBlocked) return "permission-blocked";
  const kind = session.sessionKind === "structured" ? "structured" : "pty";
  if (kind === "structured" && session.structuredState?.inFlight) return "running";
  const status = asString(session.status);
  if (isIdleAtPrompt(kind, status, session.provider ?? "", Boolean(session.ptyBusy))) return "idle";
  return status;
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
  const explicitProvider = asString(session.provider);
  const provider = (
    normalizeProviderId(explicitProvider)
    ?? (explicitProvider || inferProviderIdFromCommand(session.command) || "terminal")
  ) as UiProvider;
  const status = asString(session.status, "idle") as UiSessionStatus;
  const kind = session.sessionKind === "structured" ? "structured" : "pty";
  const worktreeEnabled = Boolean(session.worktree?.enabled ?? session.worktreeEnabled);
  const source = isAutomation(session) ? "automation" : "wand";
  const structuredInFlight = kind === "structured" && Boolean(session.structuredState?.inFlight);
  const turnActive = kind === "structured"
    ? structuredInFlight
    : status === "running" && (!Boolean(explicitProvider) || Boolean(session.ptyBusy));

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
      && Boolean(session.claudeSessionId),
    permissionBlocked: Boolean(session.permissionBlocked),
    inFlight: structuredInFlight,
    turnActive,
    titleGenerating: Boolean(session.titleGenerating),
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
  const sessionVms = sessions.map((session) => sessionToVm(session, state, sessionSelection));
  const selected = sessionVms.find((session) => session.id === state.selectedId) ?? null;
  const selectedLegacy = sessions.find((session) => session.id === state.selectedId) ?? null;
  const wand = sortSessionVms(sessionVms.filter((session) => session.source === "wand"));
  const automation = sortSessionVms(sessionVms.filter((session) => session.source === "automation"));

  const mobile = environment.width <= 768;
  const drawerOpen = Boolean(state.sessionsDrawerOpen);
  const sidebarPinned = Boolean(state.sidebarPinned);
  const sidebarCollapsed = Boolean(state.sidebarCollapsed);
  const filePanelOpen = Boolean(state.filePanelOpen);
  const structuredSelected = selected?.kind === "structured";
  const currentView = structuredSelected || state.currentView === "chat" ? "chat" : "terminal";
  const manageMode = Boolean(state.sessionsManageMode);
  const selectedCount = countSelected(sessionSelection);
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
      totalCount: wand.length + automation.length,
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
      titleGenerating: Boolean(selectedLegacy?.titleGenerating),
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
