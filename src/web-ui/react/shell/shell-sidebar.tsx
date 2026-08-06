import * as React from "react";
import { normalizeProviderId, providerDisplayName } from "../../provider-identity";
import { ProviderLogo } from "../provider-logo";
import { WandPopover } from "../ui";
import { classNames } from "../ui/class-names";

import {
  httpSessionDirectoryRepository,
  type DirectorySessionEntry,
  type SessionDirectoryNode,
  type SessionDirectoryResponse,
} from "./session-directory-repository";
import { useUiDispatch, useUiStoreSnapshot } from "./ui-store-react";
import type {
  UiAction,
  UiManageTarget,
  UiNativeHistoryProvider,
  UiSessionVm,
  UiSidebarGroupVm,
} from "./ui-store";

export interface ShellSidebarEntryActions {
  readonly primary: UiAction;
  readonly resume: UiAction | null;
  readonly delete: UiAction | null;
  readonly merge: UiAction | null;
  readonly cleanup: UiAction | null;
}

export function getSidebarEntryTarget(entry: Readonly<UiSessionVm>): UiManageTarget {
  if (entry.source.endsWith("-history")) return entry.source as UiManageTarget;
  return "session";
}

function isHistoryEntry(entry: Readonly<UiSessionVm>): boolean {
  return entry.source.endsWith("-history");
}

function historyProviderFor(entry: Readonly<UiSessionVm>): UiNativeHistoryProvider | null {
  if (!isHistoryEntry(entry)) return null;
  const provider = entry.source.slice(0, -"-history".length);
  return provider === "codex" || provider === "opencode" || provider === "qoder"
    ? provider
    : "claude";
}

export function getShellSidebarEntryActions(
  entry: Readonly<UiSessionVm>,
  manageMode: boolean,
): ShellSidebarEntryActions {
  const target = getSidebarEntryTarget(entry);
  if (manageMode) {
    return {
      primary: { type: "session.manage.select", target, id: entry.id },
      resume: null,
      delete: null,
      merge: null,
      cleanup: null,
    };
  }

  const historyProvider = historyProviderFor(entry);
  const historyResume: UiAction | null = historyProvider
    ? { type: "session.resumeHistory", provider: historyProvider, id: entry.id, cwd: entry.cwd }
    : null;
  const cleanup = entry.worktree?.enabled && entry.worktree.mergeStatus === "merged"
    ? { type: "session.cleanup", id: entry.id } satisfies UiAction
    : null;
  const merge = entry.worktree?.enabled
    && entry.worktree.branch
    && entry.worktree.path
    && entry.worktree.mergeStatus !== "merged"
    ? { type: "session.merge", id: entry.id } satisfies UiAction
    : null;

  return {
    primary: historyResume ?? { type: "session.select", id: entry.id },
    resume: historyResume ?? (entry.resumable ? { type: "session.resume", id: entry.id } : null),
    delete: { type: "session.delete", target, id: entry.id },
    merge,
    cleanup,
  };
}

function Icon({ name, size = 14, className }: {
  name: "back" | "check" | "chevron" | "cleanup" | "close" | "edit" | "file" | "gear"
    | "history" | "inbox" | "logout" | "merge" | "more" | "pin" | "resume" | "server"
    | "spark" | "trash";
  size?: number;
  className?: string;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
  switch (name) {
    case "back":
      return <svg {...common}><rect x="10" y="3" width="11" height="18" rx="2"/><path d="M7 8l-4 4 4 4M3 12h11"/></svg>;
    case "check":
      return <svg {...common}><path d="M20 6L9 17l-5-5"/></svg>;
    case "chevron":
      return <svg {...common}><path d="M6 9l6 6 6-6"/></svg>;
    case "cleanup":
    case "trash":
      return <svg {...common}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>;
    case "close":
      return <svg {...common}><path d="M6 6l12 12M18 6L6 18"/></svg>;
    case "edit":
      return <svg {...common}><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L8 18l-4 1 1-4z"/></svg>;
    case "file":
      return <svg {...common}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;
    case "gear":
      return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9L7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>;
    case "history":
      return <svg {...common}><path d="M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.7L3 8M3 3v5h5M12 7v5l3 2"/></svg>;
    case "inbox":
      return <svg {...common}><path d="M4 4h16l2 10v6H2v-6L4 4zM2 14h6l2 3h4l2-3h6"/></svg>;
    case "logout":
      return <svg {...common}><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>;
    case "merge":
      return <svg {...common}><path d="M7 7h10M7 12h10M7 17h10M5 7L3 9l2 2M19 15l2 2-2 2"/></svg>;
    case "more":
      return <svg {...common}><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>;
    case "pin":
      return <svg {...common}><path d="M12 17v5M5 17h14M9 12V6H8a2 2 0 010-4h8a2 2 0 010 4h-1v6"/></svg>;
    case "resume":
      return <svg {...common}><path d="M1 4v6h6M3.5 15A9 9 0 109 3.6L3 10"/></svg>;
    case "server":
      return <svg {...common}><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/></svg>;
    case "spark":
      return <svg {...common}><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/><circle cx="12" cy="12" r="3"/></svg>;
  }
}

function ActionButton({
  action,
  dispatch,
  actionName,
  label,
  icon,
  className,
  disabled,
  data,
}: {
  action: UiAction;
  dispatch(action: UiAction): void | Promise<unknown>;
  actionName: string;
  label: string;
  icon: "cleanup" | "merge" | "resume" | "trash";
  className?: string;
  disabled?: boolean;
  data?: Record<string, string>;
}) {
  return (
    <button
      type="button"
      className={classNames("session-action-btn", className)}
      data-action={actionName}
      data-session-id={data?.sessionId}
      data-claude-session-id={data?.historyId}
      data-cwd={data?.cwd}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        void dispatch(action);
      }}
    >
      <Icon name={icon}/>
    </button>
  );
}

function ManageCheckbox({
  entry,
  dispatch,
}: {
  entry: Readonly<UiSessionVm>;
  dispatch(action: UiAction): void | Promise<unknown>;
}) {
  const target = getSidebarEntryTarget(entry);
  const legacyKind = target === "session" ? "sessions" : target === "codex-history" ? "codex" : "history";
  return (
    <label className="session-manage-check" onClick={(event) => event.stopPropagation()}>
      <input
        type="checkbox"
        data-action="toggle-selection"
        data-kind={legacyKind}
        data-id={entry.id}
        checked={entry.selected}
        aria-label={`选择会话 ${entry.title}`}
        onChange={() => void dispatch({ type: "session.manage.select", target, id: entry.id })}
      />
      <span/>
    </label>
  );
}

function WorktreeBadges({ entry }: { entry: Readonly<UiSessionVm> }) {
  if (!entry.worktree?.enabled) return null;
  const labels: Readonly<Record<string, string>> = {
    ready: "可合并",
    checking: "检查中",
    merging: "合并中",
    merged: "已合并",
    failed: "合并失败",
  };
  const title = [
    entry.worktree.branch && `Worktree: ${entry.worktree.branch}`,
    entry.worktree.path && `Path: ${entry.worktree.path}`,
  ].filter(Boolean).join("\n");
  return (
    <>
      <span className="session-kind-badge worktree" title={title || undefined}>Worktree</span>
      {entry.worktree.mergeStatus && (
        <span className={classNames("session-kind-badge worktree-merge", entry.worktree.mergeStatus)}>
          {labels[entry.worktree.mergeStatus] ?? entry.worktree.mergeStatus}
        </span>
      )}
    </>
  );
}

function formatEntryTime(entry: Readonly<UiSessionVm>): string {
  const value = entry.endedAt ?? entry.startedAt;
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  if (!entry.endedAt && entry.status === "running" && entry.startedAt) {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(entry.startedAt).getTime()) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  const delta = Math.max(0, Date.now() - parsed.getTime());
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}小时前`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}天前`;
  return parsed.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function ProviderMark({ entry }: { entry: Readonly<UiSessionVm> }) {
  const label = providerDisplayName(entry.provider);
  const provider = normalizeProviderId(entry.provider);
  return (
    <span
      className={classNames("session-provider-mark", `provider-${provider ?? "generic"}`)}
      aria-hidden="true"
      title={label}
    >
      <ProviderLogo provider={provider}/>
    </span>
  );
}

function PathReveal({ path }: { path: string }) {
  const containerRef = React.useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = React.useState(0);
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  const separator = normalized.lastIndexOf("/");
  const prefix = separator >= 0 ? normalized.slice(0, separator + 1) : "";
  const leaf = separator >= 0 ? normalized.slice(separator + 1) : normalized;
  const staggerMs = Array.from(normalized).reduce((sum, character) => sum + character.charCodeAt(0), 0) % 1_200;

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const inner = container.firstElementChild as HTMLElement | null;
      setOverflow(Math.max(0, (inner?.scrollWidth ?? 0) - container.clientWidth));
    };
    const frame = requestAnimationFrame(measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [normalized]);

  const travelSeconds = Math.max(4.8, overflow / 28);
  if (!path) return null;
  return (
    <span
      ref={containerRef}
      className={classNames("session-path", "tail-marquee-path", overflow > 1 && "is-overflowing")}
      title={path}
      aria-label={path}
      style={{
        "--tail-marquee-shift": `${overflow}px`,
        "--tail-marquee-duration": `${Math.min(8, travelSeconds)}s`,
        "--tail-marquee-delay": `${1.8 + staggerMs / 1_000}s`,
      } as React.CSSProperties}
    >
      <span className="tail-marquee-path-inner">
        <span className="tail-marquee-prefix">{prefix}</span>
        <span className="tail-marquee-leaf">{leaf}</span>
      </span>
    </span>
  );
}

function SessionEntry({
  entry,
  manageMode,
  dispatch,
}: {
  entry: Readonly<UiSessionVm>;
  manageMode: boolean;
  dispatch(action: UiAction): void | Promise<unknown>;
}) {
  const actions = getShellSidebarEntryActions(entry, manageMode);
  const isHistory = isHistoryEntry(entry);
  const provider = historyProviderFor(entry) ?? "claude";
  const data: Record<string, string> = isHistory
    ? { historyId: entry.id, cwd: entry.cwd }
    : { sessionId: entry.id };
  const activate = () => void dispatch(actions.primary);
  const time = formatEntryTime(entry);
  const prominentStatus = !isHistory && (
    entry.permissionBlocked
    || entry.inFlight
    || ["running", "thinking", "waiting-input", "waiting_input", "reconnecting"].includes(entry.status)
  );
  const prominentWarning = entry.permissionBlocked
    || ["waiting-input", "waiting_input", "reconnecting"].includes(entry.status);

  return (
    <div
      className={classNames(
        "session-item",
        isHistory && "non-wand-session",
        entry.active && "active",
        manageMode && entry.selected && "selected",
        manageMode && "session-managing",
        prominentStatus && "status-prominent",
        prominentWarning && "status-prominent-warning",
      )}
      data-session-id={isHistory ? undefined : entry.id}
      data-claude-history-id={isHistory ? entry.id : undefined}
      data-provider={isHistory ? provider : undefined}
      data-cwd={isHistory ? entry.cwd : undefined}
      role="button"
      tabIndex={0}
      aria-current={entry.active ? "page" : undefined}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        activate();
      }}
    >
      {!manageMode && !isHistory && actions.delete && (
        <div className="session-swipe-bg" aria-hidden="true">
          <button
            className="session-swipe-delete"
            data-action="swipe-delete-session"
            data-session-id={entry.id}
            type="button"
            tabIndex={-1}
            aria-label="删除会话"
            onClick={(event) => {
              event.stopPropagation();
              void dispatch(actions.delete!);
            }}
          >
            <Icon name="trash" size={18}/><span>删除</span>
          </button>
        </div>
      )}
      <div className="session-item-content">
        <div className="session-item-row">
          {manageMode && <ManageCheckbox entry={entry} dispatch={dispatch}/>} 
          <div className="session-main">
            <div className="session-title-row">
              <span className="session-leading-slot"><ProviderMark entry={entry}/></span>
              <div
                className={classNames(
                  isHistory ? "session-command claude-history-preview" : "session-title",
                  entry.titleGenerating && "title-generating",
                )}
                aria-busy={entry.titleGenerating || undefined}
              >
                {entry.title}
              </div>
            </div>
            {entry.description && <div className="session-description">{entry.description}</div>}
            <div className="session-meta">
              <span className="session-leading-slot session-time">{time}</span>
              {isHistory ? (
                <>
                  <span className="session-context session-context-recoverable"><Icon name="history" size={11}/>可恢复</span>
                  <PathReveal path={entry.cwd}/>
                </>
              ) : (
                <>
                  <span className={classNames("session-status", entry.permissionBlocked
                    ? "permission-blocked"
                    : entry.inFlight
                      ? "running"
                      : entry.status)}>
                    {entry.statusLabel}
                  </span>
                  <PathReveal path={entry.cwd}/>
                  <WorktreeBadges entry={entry}/>
                </>
              )}
            </div>
          </div>
          {!manageMode && (
            <span className="session-actions">
              {actions.resume && (
                <ActionButton
                  action={actions.resume}
                  dispatch={dispatch}
                  actionName={isHistory
                    ? provider === "claude" ? "resume-history" : `resume-${provider}-history`
                    : "resume"}
                  label={isHistory ? `恢复此 ${providerDisplayName(provider)} 会话` : "恢复会话"}
                  icon="resume"
                  data={data}
                />
              )}
              {actions.merge && (
                <ActionButton
                  action={actions.merge}
                  dispatch={dispatch}
                  actionName="worktree-merge"
                  label="合并到主分支"
                  icon="merge"
                  className="merge-btn"
                  disabled={entry.status === "running" || entry.worktree?.mergeStatus === "merging"}
                  data={data}
                />
              )}
              {actions.cleanup && (
                <ActionButton
                  action={actions.cleanup}
                  dispatch={dispatch}
                  actionName="worktree-cleanup"
                  label="重试清理 worktree"
                  icon="cleanup"
                  className="merge-btn"
                  data={data}
                />
              )}
              {actions.delete && (
                <ActionButton
                  action={actions.delete}
                  dispatch={dispatch}
                  actionName={isHistory
                    ? provider === "claude" ? "delete-history" : `delete-${provider}-history`
                    : "delete-session"}
                  label="删除会话"
                  icon="trash"
                  className="delete-btn"
                  data={data}
                />
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

type SidebarViewMode = "sessions" | "directories";

const SIDEBAR_VIEW_MODE_KEY = "wand-sidebar-view-mode";

function readSidebarViewMode(): SidebarViewMode {
  if (typeof window === "undefined") return "sessions";
  try {
    return window.localStorage.getItem(SIDEBAR_VIEW_MODE_KEY) === "directories"
      ? "directories"
      : "sessions";
  } catch {
    return "sessions";
  }
}

function writeSidebarViewMode(mode: SidebarViewMode): void {
  try {
    window.localStorage.setItem(SIDEBAR_VIEW_MODE_KEY, mode);
  } catch {}
}

function statusLabel(status: string, permissionBlocked: boolean, inFlight: boolean): string {
  if (permissionBlocked) return "等待授权";
  if (inFlight) return "思考中";
  const labels: Record<string, string> = {
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
  return labels[status] ?? status;
}

function directoryEntryToVm(
  entry: DirectorySessionEntry,
  selectedId: string | null,
): UiSessionVm {
  if (entry.type === "recoverable") {
    const provider = entry.history.provider === "codex"
      || entry.history.provider === "opencode"
      || entry.history.provider === "qoder"
      ? entry.history.provider
      : "claude";
    return {
      id: entry.history.claudeSessionId,
      source: `${provider}-history`,
      provider,
      kind: "pty",
      title: entry.history.firstUserMessage || "（空会话）",
      description: "",
      cwd: entry.history.cwd || "",
      status: "stopped",
      statusLabel: "历史",
      active: false,
      selected: false,
      resumable: true,
      permissionBlocked: false,
      inFlight: false,
      titleGenerating: false,
      startedAt: entry.history.timestamp
        || (entry.history.mtimeMs ? new Date(entry.history.mtimeMs).toISOString() : undefined),
      claudeSessionId: entry.history.claudeSessionId,
    };
  }

  const session = entry.session;
  const id = session.id;
  const status = session.status || "idle";
  const permissionBlocked = Boolean(session.permissionBlocked);
  const inFlight = Boolean(session.structuredState?.inFlight);
  const worktreeEnabled = Boolean(session.worktree?.enabled ?? session.worktreeEnabled);
  return {
    id,
    source: session.sessionSource === "automation" || session.sessionSource === "startup"
      ? "automation"
      : "wand",
    provider: session.provider || "terminal",
    kind: session.sessionKind === "structured" ? "structured" : "pty",
    title: session.title || "Wand 会话",
    description: session.description || "",
    cwd: session.cwd || "",
    status,
    statusLabel: statusLabel(status, permissionBlocked, inFlight),
    active: id === selectedId,
    selected: false,
    resumable: session.sessionKind !== "structured"
      && status !== "running"
      && Boolean(session.claudeSessionId),
    permissionBlocked,
    inFlight,
    titleGenerating: Boolean(session.titleGenerating),
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    claudeSessionId: session.claudeSessionId,
    ...(worktreeEnabled ? {
      worktree: {
        enabled: true,
        branch: session.worktree?.branch ?? session.worktreeBranch,
        path: session.worktree?.path ?? session.worktreePath,
        mergeStatus: session.worktree?.mergeStatus ?? session.worktreeMergeStatus,
      },
    } : {}),
  };
}

function useSessionDirectories(enabled: boolean, refreshKey: number): {
  data: SessionDirectoryResponse | null;
  loading: boolean;
  error: string;
  rename(path: string, name: string): Promise<void>;
} {
  const [data, setData] = React.useState<SessionDirectoryResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const loadGenerationRef = React.useRef(0);
  const activeLoadRef = React.useRef<AbortController | null>(null);
  const renameInFlightRef = React.useRef(false);

  const loadLatest = React.useCallback(async (
    showLoading: boolean,
    propagateError = false,
  ): Promise<void> => {
    const generation = ++loadGenerationRef.current;
    activeLoadRef.current?.abort();
    const abort = new AbortController();
    activeLoadRef.current = abort;
    if (showLoading) setLoading(true);
    try {
      const value = await httpSessionDirectoryRepository.load(abort.signal);
      if (!abort.signal.aborted && generation === loadGenerationRef.current) {
        setData(value);
        setError("");
      }
    } catch (fetchError: unknown) {
      if (!abort.signal.aborted && generation === loadGenerationRef.current) {
        const loadError = fetchError instanceof Error ? fetchError : new Error("无法加载会话目录");
        setError(loadError.message);
        if (propagateError) throw loadError;
      }
    } finally {
      if (generation === loadGenerationRef.current) {
        activeLoadRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  React.useEffect(() => {
    if (!enabled) return;
    setError("");
    void loadLatest(data === null);
    const interval = window.setInterval(() => void loadLatest(false), 10_000);
    return () => {
      window.clearInterval(interval);
      loadGenerationRef.current += 1;
      activeLoadRef.current?.abort();
      activeLoadRef.current = null;
    };
  // data is intentionally excluded: retaining stale content avoids a blank flash during refresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, refreshKey, loadLatest]);

  const rename = React.useCallback(async (path: string, name: string) => {
    if (renameInFlightRef.current) throw new Error("另一个工作区名称正在保存，请稍候。");
    renameInFlightRef.current = true;
    setError("");
    loadGenerationRef.current += 1;
    activeLoadRef.current?.abort();
    activeLoadRef.current = null;
    try {
      await httpSessionDirectoryRepository.rename(path, name);
      await loadLatest(false, true);
    } finally {
      renameInFlightRef.current = false;
    }
  }, [loadLatest]);

  return { data, loading, error, rename };
}

function nodeContainsActive(node: SessionDirectoryNode, selectedId: string | null): boolean {
  if (!selectedId) return false;
  return node.entries.some((entry) => entry.type === "managed" && entry.session.id === selectedId)
    || node.children.some((child) => nodeContainsActive(child, selectedId));
}

export function getSessionDirectoryLabels(node: Pick<SessionDirectoryNode, "customName" | "name" | "path">): {
  displayName: string;
  directoryName: string;
  path: string;
} {
  const customName = node.customName?.trim() ?? "";
  return {
    displayName: customName || node.name,
    directoryName: customName && customName !== node.name ? node.name : "",
    path: node.path || node.name,
  };
}

export function normalizeSessionDirectoryCustomName(input: string, defaultName: string): string {
  const trimmed = input.trim();
  return trimmed === defaultName ? "" : trimmed;
}

function DirectoryNode({
  node,
  depth,
  selectedId,
  dispatch,
  renameDirectory,
}: {
  node: SessionDirectoryNode;
  depth: number;
  selectedId: string | null;
  dispatch(action: UiAction): void | Promise<unknown>;
  renameDirectory(path: string, name: string): Promise<void>;
}) {
  const activeWithin = nodeContainsActive(node, selectedId);
  const [open, setOpen] = React.useState(depth === 0 || activeWithin);
  const [renaming, setRenaming] = React.useState(false);
  const [renameDraft, setRenameDraft] = React.useState("");
  const [renameError, setRenameError] = React.useState("");
  const [renameSaving, setRenameSaving] = React.useState(false);
  const renameInputRef = React.useRef<HTMLInputElement>(null);
  const renameTriggerRef = React.useRef<HTMLButtonElement>(null);
  const labels = getSessionDirectoryLabels(node);
  const renameLength = Array.from(renameDraft.trim()).length;
  const renameTooLong = renameLength > 80;
  const renameHasInvalidCharacters = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(renameDraft.trim());
  React.useEffect(() => {
    if (activeWithin) setOpen(true);
  }, [activeWithin]);
  React.useEffect(() => {
    if (!renaming) return;
    const frame = requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [renaming]);
  const hasContents = node.entries.length > 0 || node.children.length > 0;
  const restoreRenameTriggerFocus = () => {
    requestAnimationFrame(() => {
      renameTriggerRef.current?.focus();
    });
  };
  const beginRename = () => {
    setRenameDraft(node.customName?.trim() || node.name);
    setRenameError("");
    setRenaming(true);
  };
  const cancelRename = () => {
    if (renameSaving) return;
    setRenaming(false);
    setRenameError("");
    restoreRenameTriggerFocus();
  };
  const saveRename = async () => {
    if (renameSaving) return;
    const submittedName = normalizeSessionDirectoryCustomName(renameDraft, node.name);
    const currentName = node.customName?.trim() ?? "";
    if (submittedName === currentName) {
      setRenaming(false);
      setRenameError("");
      restoreRenameTriggerFocus();
      return;
    }
    if (renameTooLong || renameHasInvalidCharacters) {
      setRenameError(renameHasInvalidCharacters
        ? "工作区名称不能包含换行或控制字符"
        : "工作区名称最多 80 个字符");
      return;
    }
    setRenameSaving(true);
    setRenameError("");
    try {
      await renameDirectory(node.path, submittedName);
      setRenaming(false);
      restoreRenameTriggerFocus();
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "无法更新工作区名称");
    } finally {
      setRenameSaving(false);
    }
  };

  return (
    <section
      className={classNames("session-directory-node", activeWithin && "active-path")}
      style={{ "--directory-depth": Math.min(depth, 6) } as React.CSSProperties}
    >
      <div className="session-directory-row">
        {renaming ? (
          <form
            className="session-directory-rename-form"
            aria-busy={renameSaving || undefined}
            onSubmit={(event) => {
              event.preventDefault();
              void saveRename();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              cancelRename();
            }}
          >
            <Icon name="file" size={15}/>
            <input
              ref={renameInputRef}
              className="session-directory-rename-input"
              value={renameDraft}
              disabled={renameSaving}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={renameTooLong || renameHasInvalidCharacters || undefined}
              aria-label={`为 ${node.name} 设置工作区名称`}
              placeholder="工作区名称（留空恢复目录名）"
              onChange={(event) => {
                setRenameDraft(event.currentTarget.value);
                setRenameError("");
              }}
            />
            <button
              type="submit"
              className="session-directory-rename-action save"
              disabled={renameSaving || renameTooLong || renameHasInvalidCharacters}
              title="保存名称"
              aria-label="保存工作区名称"
            >
              <Icon name="check" size={14}/>
            </button>
            <button
              type="button"
              className="session-directory-rename-action"
              disabled={renameSaving}
              title="取消"
              aria-label="取消重命名"
              onClick={cancelRename}
            >
              <Icon name="close" size={14}/>
            </button>
          </form>
        ) : (
          <>
            <button
              type="button"
              className="session-directory-main"
              aria-expanded={open}
              aria-label={`${labels.displayName}，${node.totalCount} 个会话，目录 ${labels.path}`}
              title={labels.path}
              onClick={() => { if (hasContents) setOpen((current) => !current); }}
            >
              <Icon name="chevron" size={12} className={classNames("session-directory-chevron", open && "open")}/>
              <Icon name="file" size={15}/>
              <span className="session-directory-label">
                <span className="session-directory-name">{labels.displayName}</span>
                {labels.directoryName && (
                  <span className="session-directory-default-name">{labels.directoryName}</span>
                )}
              </span>
              <span className="session-directory-count" aria-label={`${node.totalCount} 个会话`}>
                {node.totalCount}
              </span>
            </button>
            {!node.synthetic && node.path && (
              <span className="session-directory-actions">
                <button
                  ref={renameTriggerRef}
                  type="button"
                  className="session-directory-rename"
                  title={`设置 ${labels.displayName} 的工作区名称`}
                  aria-label={`重命名工作区 ${labels.displayName}`}
                  onClick={beginRename}
                >
                  <Icon name="edit" size={14}/>
                </button>
                <button
                  type="button"
                  className="session-directory-add"
                  title={`在 ${node.path} 新建会话`}
                  aria-label={`在 ${node.path} 新建会话`}
                  onClick={() => void dispatch({ type: "session.newAt", cwd: node.path })}
                >
                  <span aria-hidden="true">＋</span>
                </button>
              </span>
            )}
          </>
        )}
      </div>
      {renaming && (renameTooLong || renameHasInvalidCharacters || renameError) && (
        <div className="session-directory-rename-error" role="alert">
          {renameHasInvalidCharacters
            ? "工作区名称不能包含换行或控制字符"
            : renameTooLong
              ? `工作区名称最多 80 个字符（当前 ${renameLength} 个）`
              : renameError}
        </div>
      )}
      {open && (
        <div className="session-directory-contents">
          {node.entries.length > 0 && (
            <div className="session-directory-sessions">
              {node.entries.map((entry) => {
                const vm = directoryEntryToVm(entry, selectedId);
                return <SessionEntry key={entry.key} entry={vm} manageMode={false} dispatch={dispatch}/>;
              })}
            </div>
          )}
          {node.children.map((child) => (
            <DirectoryNode
              key={child.path || child.name}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              dispatch={dispatch}
              renameDirectory={renameDirectory}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DirectoryTree({
  response,
  loading,
  error,
  selectedId,
  dispatch,
  renameDirectory,
}: {
  response: SessionDirectoryResponse | null;
  loading: boolean;
  error: string;
  selectedId: string | null;
  dispatch(action: UiAction): void | Promise<unknown>;
  renameDirectory(path: string, name: string): Promise<void>;
}) {
  if (loading && !response) return <div className="session-directory-state">正在整理目录…</div>;
  if (error && !response) return <div className="session-directory-state error">{error}</div>;
  if (!response || response.roots.length === 0) {
    return <div className="empty-state"><strong>还没有会话目录</strong><br/>创建会话后会按工作目录显示在这里。</div>;
  }
  return (
    <div className="session-directory-tree" aria-label="会话目录树">
      {response.roots.map((node) => (
        <DirectoryNode
          key={node.path || node.name}
          node={node}
          depth={0}
          selectedId={selectedId}
          dispatch={dispatch}
          renameDirectory={renameDirectory}
        />
      ))}
    </div>
  );
}

function SidebarViewSwitch({
  mode,
  onChange,
}: {
  mode: SidebarViewMode;
  onChange(mode: SidebarViewMode): void;
}) {
  return (
    <div className="sidebar-view-switch" role="tablist" aria-label="侧栏展示方式">
      {(["sessions", "directories"] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={mode === value}
          className={classNames(mode === value && "active")}
          onClick={() => onChange(value)}
        >
          {value === "sessions" ? "会话" : "目录"}
        </button>
      ))}
    </div>
  );
}

function SessionGroup({
  group,
  manageMode,
  dispatch,
}: {
  group: Readonly<UiSidebarGroupVm>;
  manageMode: boolean;
  dispatch(action: UiAction): void | Promise<unknown>;
}) {
  if (group.entries.length === 0) return null;
  const entries = (
    <section className={classNames(
      "session-group",
      group.kind === "automation" && "automation-session-list",
      group.kind === "history" && "non-wand-session-list",
    )}>
      {group.entries.map((entry) => (
        <SessionEntry key={`${entry.source}:${entry.id}`} entry={entry} manageMode={manageMode} dispatch={dispatch}/>
      ))}
    </section>
  );
  if (group.kind === "wand") return entries;

  const automation = group.kind === "automation";
  return (
    <details
      className={classNames(
        automation ? "automation-session-group" : "non-wand-session-group",
        manageMode && "manage-mode",
      )}
      open={manageMode || group.expanded}
      onToggle={(event) => {
        if (manageMode) return;
        void dispatch({
          type: "layout.drawer.group.set",
          group: automation ? "automation" : "history",
          expanded: event.currentTarget.open,
        });
      }}
    >
      <summary
        className={automation ? "automation-session-summary" : "non-wand-session-summary"}
        title={automation
          ? "由自动化或启动任务创建，不参与普通 Wand 会话排序"
          : "Claude 与 Codex 的本机原生会话，不参与 Wand 会话排序"}
        onClick={manageMode ? (event) => event.preventDefault() : undefined}
      >
        <span className={automation ? "automation-session-icon" : "non-wand-session-icon"} aria-hidden="true">
          <Icon name={automation ? "spark" : "history"}/>
        </span>
        <span className={automation ? "automation-session-title" : "non-wand-session-title"}>{group.label}</span>
        <span
          className={automation ? "automation-session-count" : "non-wand-session-count"}
          aria-label={`${group.entries.length} 个会话`}
        >
          {group.entries.length}
        </span>
        <Icon
          name="chevron"
          className={automation ? "automation-session-chevron" : "non-wand-session-chevron"}
        />
      </summary>
      {entries}
    </details>
  );
}

function ManageBar({
  manageMode,
  selectedCount,
  totalCount,
  dispatch,
}: {
  manageMode: boolean;
  selectedCount: number;
  totalCount: number;
  dispatch(action: UiAction): void | Promise<unknown>;
}) {
  if (!manageMode) {
    return (
      <div className="session-manage-bar">
        <span className="sidebar-intro">Wand 会话</span>
        <button
          className="btn btn-ghost btn-xs session-manage-toggle"
          data-action="toggle-manage-mode"
          type="button"
          onClick={() => void dispatch({ type: "session.manage.toggle" })}
        >
          <span>管理</span>
        </button>
      </div>
    );
  }

  const allSelected = totalCount > 0 && selectedCount >= totalCount;
  return (
    <div className="session-manage-bar active">
      <button
        className="session-manage-exit"
        data-action="toggle-manage-mode"
        type="button"
        aria-label="退出管理模式"
        title="退出管理模式"
        onClick={() => void dispatch({ type: "session.manage.toggle" })}
      >
        <Icon name="close"/>
      </button>
      <div className="session-manage-summary">
        {selectedCount > 0 ? (
          <><span className="session-manage-count">{selectedCount}</span><span className="session-manage-summary-label">已选择</span></>
        ) : (
          <span className="session-manage-summary-label muted">选择要管理的项目</span>
        )}
      </div>
      <div className="session-manage-actions">
        <button
          className="btn btn-ghost btn-xs"
          data-action={allSelected ? "clear-selection" : "select-all-visible"}
          type="button"
          disabled={totalCount === 0}
          onClick={() => void dispatch({
            type: allSelected ? "session.manage.clear" : "session.manage.selectAll",
          })}
        >
          {allSelected ? "取消全选" : "全选"}
        </button>
        <button
          className="btn btn-danger btn-xs"
          data-action="delete-selected"
          type="button"
          disabled={selectedCount === 0}
          onClick={() => void dispatch({ type: "session.manage.deleteSelected" })}
        >
          删除{selectedCount > 0 ? ` ${selectedCount}` : ""}
        </button>
      </div>
    </div>
  );
}

function CollapsedSessions({
  groups,
  dispatch,
}: {
  groups: readonly Readonly<UiSidebarGroupVm>[];
  dispatch(action: UiAction): void | Promise<unknown>;
}) {
  const wand = groups.find((group) => group.kind === "wand")?.entries ?? [];
  const automation = groups.find((group) => group.kind === "automation")?.entries ?? [];
  const history = groups.find((group) => group.kind === "history")?.entries ?? [];
  return (
    <div className="sidebar-collapsed-tiles">
      {wand.map((entry) => (
        <button
          key={entry.id}
          className={classNames(
            "sidebar-collapsed-tile",
            `provider-${normalizeProviderId(entry.provider) ?? "generic"}`,
            entry.active && "active",
          )}
          type="button"
          data-collapsed-session-id={entry.id}
          title={entry.title}
          aria-label={`${entry.title} · ${providerDisplayName(entry.provider)}`}
          onClick={() => void dispatch({ type: "session.select", id: entry.id })}
        >
          <span className="sidebar-collapsed-provider-mark" aria-hidden="true">
            <ProviderLogo provider={entry.provider}/>
          </span>
        </button>
      ))}
      {automation.length > 0 && (
        <button
          className={classNames(
            "sidebar-collapsed-tile automation-count-tile",
            automation.some((entry) => entry.active) && "active-group",
          )}
          type="button"
          data-expand-session-group="automation"
          title={`展开查看 ${automation.length} 个自动化会话`}
          aria-label={`展开查看 ${automation.length} 个自动化会话`}
          onClick={() => void dispatch({ type: "layout.drawer.expandGroup", group: "automation" })}
        >
          <Icon name="spark" size={16}/>
          <span className="non-wand-count-badge">{automation.length > 99 ? "99+" : automation.length}</span>
        </button>
      )}
      {history.length > 0 && (
        <button
          className="sidebar-collapsed-tile non-wand-count-tile"
          type="button"
          data-expand-session-group="non-wand"
          title={`展开查看 ${history.length} 个非 Wand 会话`}
          aria-label={`展开查看 ${history.length} 个非 Wand 会话`}
          onClick={() => void dispatch({ type: "layout.drawer.expandGroup", group: "history" })}
        >
          <Icon name="history" size={16}/>
          <span className="non-wand-count-badge">{history.length > 99 ? "99+" : history.length}</span>
        </button>
      )}
      <button
        className="sidebar-collapsed-tile add"
        type="button"
        data-collapsed-new-session="1"
        title="新建会话"
        aria-label="新建会话"
        onClick={() => void dispatch({ type: "session.new" })}
      >
        <span aria-hidden="true">＋</span>
      </button>
    </div>
  );
}

export function ShellSidebar() {
  const snapshot = useUiStoreSnapshot();
  const dispatch = useUiDispatch();
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [viewMode, setViewMode] = React.useState<SidebarViewMode>(readSidebarViewMode);
  const directories = useSessionDirectories(viewMode === "directories", snapshot.revision);
  const narrow = snapshot.layout.sidebarPinned && snapshot.layout.sidebarCollapsed;
  const sidebarClass = classNames(
    "sidebar",
    snapshot.layout.sessionsDrawerOpen && "open",
    snapshot.layout.sidebarAnchored && "pinned",
    narrow && "collapsed",
  );
  const changeViewMode = (next: SidebarViewMode) => {
    setViewMode(next);
    writeSidebarViewMode(next);
    if (next === "directories" && snapshot.sidebar.manageMode) {
      void dispatch({ type: "session.manage.toggle" });
    }
  };

  return (
    <>
      <div
        id="sessions-drawer-backdrop"
        className={classNames("drawer-backdrop", snapshot.layout.sessionsBackdropVisible && "open")}
        aria-hidden="true"
        onClick={() => void dispatch({ type: "layout.drawer.close" })}
      />
      <aside id="sessions-drawer" className={sidebarClass} aria-label="会话侧栏">
        <div className="sidebar-header">
          <div className="sidebar-header-main">
            <div className="topbar-logo-icon">W</div>
            <SidebarViewSwitch mode={viewMode} onChange={changeViewMode}/>
            <span className="session-count" id="session-count">
              {viewMode === "directories"
                ? directories.data?.directoryCount ?? "…"
                : snapshot.sidebar.interactiveCount}
            </span>
          </div>
          <div className="sidebar-header-actions">
            <div className="sidebar-header-more">
              <WandPopover
                open={moreOpen}
                onOpenChange={setMoreOpen}
                align="end"
                sideOffset={6}
                portalled={false}
                forceMount
                showArrow={false}
                contentId="sidebar-overflow-menu"
                contentRole="menu"
                ariaLabel="侧栏更多操作"
                className={classNames("sidebar-header-overflow", "wand-shell-menu-popover", moreOpen && "open")}
                trigger={(
                  <button
                    id="sidebar-more-btn"
                    className="btn btn-ghost btn-sm"
                    type="button"
                    title="更多操作"
                    aria-haspopup="menu"
                    aria-expanded={moreOpen}
                    aria-controls="sidebar-overflow-menu"
                  >
                    <Icon name="more"/>
                  </button>
                )}
              >
                  <button
                    className="overflow-item"
                    id="sidebar-home-btn"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      void dispatch({ type: "nav.home" });
                    }}
                  >
                    <span>回到首页</span>
                  </button>
                  <button
                    className="overflow-item"
                    id="sidebar-refresh-btn"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      void dispatch({ type: "nav.refresh" });
                    }}
                  >
                    <span>刷新页面</span>
                  </button>
              </WandPopover>
            </div>
            <button
              id="sidebar-pin-btn"
              className={classNames("btn btn-ghost btn-sm sidebar-pin-toggle", snapshot.layout.sidebarPinned && "pinned")}
              type="button"
              title={snapshot.layout.sidebarPinned ? "已固定常驻（点击解除锁定）" : "固定侧栏常驻"}
              aria-label={snapshot.layout.sidebarPinned ? "解除固定常驻" : "固定侧栏常驻"}
              aria-pressed={snapshot.layout.sidebarPinned}
              onClick={() => void dispatch({ type: "layout.drawer.pin" })}
            >
              <Icon name="pin"/>
            </button>
            <button
              id="sidebar-collapse-btn"
              className={classNames("btn btn-ghost btn-sm sidebar-collapse-toggle", narrow && "collapsed")}
              type="button"
              title={narrow ? "展开为全尺寸" : "收起为窄条"}
              aria-label={narrow ? "展开为全尺寸" : "收起为窄条"}
              onClick={() => void dispatch({ type: "layout.drawer.collapse" })}
            >
              <Icon name="chevron"/>
            </button>
            <button
              id="close-drawer-button"
              className="btn btn-ghost btn-icon sidebar-close drawer-close-btn"
              type="button"
              aria-label="关闭菜单"
              onClick={() => void dispatch({ type: "layout.drawer.close" })}
            >
              <Icon name="close"/>
            </button>
          </div>
        </div>
        <div className="sidebar-body">
          <div id="sessions-panel">
            <div className="sessions-list" id="sessions-list">
              {narrow ? (
                <CollapsedSessions groups={snapshot.sidebar.groups} dispatch={dispatch}/>
              ) : viewMode === "directories" ? (
                <DirectoryTree
                  response={directories.data}
                  loading={directories.loading}
                  error={directories.error}
                  selectedId={snapshot.selected?.id ?? null}
                  dispatch={dispatch}
                  renameDirectory={directories.rename}
                />
              ) : (
                <>
                  <ManageBar
                    manageMode={snapshot.sidebar.manageMode}
                    selectedCount={snapshot.sidebar.selectedCount}
                    totalCount={snapshot.sidebar.totalCount}
                    dispatch={dispatch}
                  />
                  {snapshot.sidebar.totalCount === 0 ? (
                    <div className="empty-state">
                      <strong>还没有会话记录</strong><br/>点击上方「新对话」开始你的第一次对话。
                    </div>
                  ) : snapshot.sidebar.groups.map((group) => (
                    <SessionGroup key={group.kind} group={group} manageMode={snapshot.sidebar.manageMode} dispatch={dispatch}/>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
        <div className="sidebar-footer">
          <button
            id="drawer-new-session-button"
            className="btn btn-primary btn-block"
            type="button"
            onClick={() => void dispatch({ type: "session.new" })}
          >
            <span>+</span> 新会话
          </button>
          <div className="sidebar-footer-actions">
            <button
              id="missions-button"
              className="btn btn-ghost btn-sm"
              type="button"
              title="Agent Inbox"
              onClick={() => void dispatch({ type: "missions.open" })}
            >
              <Icon name="inbox" size={16}/><span>任务</span>
            </button>
            <button
              id="file-panel-toggle-btn"
              className={classNames("btn btn-ghost btn-sm", snapshot.layout.filePanelOpen && "active")}
              type="button"
              title="查看文件"
              onClick={() => void dispatch({ type: "layout.files.toggle" })}
            >
              <Icon name="file" size={16}/><span>文件</span>
            </button>
            <button
              id="settings-button"
              className="btn btn-ghost btn-sm"
              type="button"
              title="设置"
              onClick={() => void dispatch({ type: "settings.open" })}
            >
              <Icon name="gear" size={16}/><span>设置</span>
            </button>
            {snapshot.capabilities.backToNative && (
              <button
                id="back-to-native-button"
                className="btn btn-ghost btn-sm sidebar-back-to-native"
                type="button"
                title="返回 App 原生界面"
                onClick={() => void dispatch({ type: "native.back" })}
              >
                <Icon name="back" size={16}/><span>返回App</span>
              </button>
            )}
            {snapshot.capabilities.switchServer && (
              <button
                id="switch-server-button"
                className="btn btn-ghost btn-sm sidebar-switch-server"
                type="button"
                title="切换服务器"
                onClick={() => void dispatch({ type: "native.switchServer" })}
              >
                <Icon name="server" size={16}/><span>切换</span>
              </button>
            )}
            <button
              id="logout-button"
              className="btn btn-ghost btn-sm sidebar-logout"
              type="button"
              title="退出登录"
              onClick={() => void dispatch({ type: "auth.logout" })}
            >
              <Icon name="logout" size={16}/><span>退出</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
