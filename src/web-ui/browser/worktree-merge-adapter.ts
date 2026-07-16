import { folderPickerController } from "../react/folder-picker/controller";
import { newSessionController } from "../react/new-session/controller";
import { quickCommitController } from "../react/quick-commit/controller";
import { settingsController } from "../react/settings/controller";
import {
  configureWorktreeMergeRuntime,
  worktreeMergeController,
} from "../react/worktree-merge/controller";
import type {
  WorktreeMergeIntent,
  WorktreeMergeOpenContext,
  WorktreeMergeRuntimeAdapter,
  WorktreeMergeStatus,
  WorktreeMergeToastTone,
} from "../react/worktree-merge/types";
import { prepareFilePreviewForCompetingOverlay } from "./file-preview-adapter";

type UnknownRecord = Record<string, unknown>;

const MERGE_STATUSES = new Set<WorktreeMergeStatus>([
  "ready",
  "checking",
  "merging",
  "merged",
  "failed",
]);

/** Small structural view accepted from both current and persisted browser sessions. */
export interface LegacyWorktreeMergeSession {
  id?: unknown;
  status?: unknown;
  worktree?: {
    branch?: unknown;
    path?: unknown;
  } | null;
  worktreeBranch?: unknown;
  worktreePath?: unknown;
  worktreeMergeStatus?: unknown;
  worktreeMergeInfo?: {
    targetBranch?: unknown;
    mergeCommit?: unknown;
    mergedAt?: unknown;
    cleanupDone?: unknown;
  } | null;
}

/** The only legacy capabilities the Worktree React module needs. */
export interface WorktreeMergeLegacyAdapterDependencies {
  getSession(sessionId: string): LegacyWorktreeMergeSession | null | undefined;
  refreshSessions(sessionId: string): void | Promise<unknown>;
  toast(message: string, tone: WorktreeMergeToastTone): void;
  onOpen?(context: WorktreeMergeOpenContext): void;
  onClose?(context: WorktreeMergeOpenContext): void;
}

interface ActiveInstallation {
  dependencies: WorktreeMergeLegacyAdapterDependencies;
  dispose(): void;
}

let activeInstallation: ActiveInstallation | null = null;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function optionalMergeStatus(value: unknown): WorktreeMergeStatus | undefined {
  return typeof value === "string" && MERGE_STATUSES.has(value as WorktreeMergeStatus)
    ? value as WorktreeMergeStatus
    : undefined;
}

/** Normalizes all legacy session shapes before they cross the React seam. */
export function buildWorktreeMergeOpenContext(
  session: LegacyWorktreeMergeSession | null | undefined,
  intent?: WorktreeMergeIntent,
): WorktreeMergeOpenContext | null {
  if (!session) return null;
  const sessionId = optionalText(session.id);
  if (!sessionId) return null;

  const worktree = isRecord(session.worktree) ? session.worktree : {};
  const mergeInfo = isRecord(session.worktreeMergeInfo) ? session.worktreeMergeInfo : {};
  const sourceBranch = optionalText(worktree.branch) ?? optionalText(session.worktreeBranch);
  const worktreePath = optionalText(worktree.path) ?? optionalText(session.worktreePath);
  const targetBranch = optionalText(mergeInfo.targetBranch);
  const sessionStatus = optionalText(session.status);
  const mergeStatus = optionalMergeStatus(session.worktreeMergeStatus);
  const cleanupPending = mergeStatus === "merged" && mergeInfo.cleanupDone === false;

  return {
    sessionId,
    intent: intent ?? (cleanupPending ? "cleanup" : "merge"),
    ...(sourceBranch ? { sourceBranch } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    ...(targetBranch ? { targetBranch } : {}),
    ...(sessionStatus ? { sessionStatus } : {}),
    ...(mergeStatus ? { mergeStatus } : {}),
    cleanupPending,
  };
}

function closeCompetingReactOverlays(): boolean {
  for (const controller of [
    quickCommitController,
    folderPickerController,
    newSessionController,
    settingsController,
  ]) {
    if (controller.isOpen() && !controller.closeIfOpen()) return false;
  }
  return true;
}

function reportRefreshFailure(
  dependencies: WorktreeMergeLegacyAdapterDependencies,
  error: unknown,
): void {
  const suffix = error instanceof Error && error.message ? `：${error.message}` : "";
  dependencies.toast(`Worktree 已更新，但会话列表刷新失败${suffix}`, "error");
}

function refreshSessions(
  dependencies: WorktreeMergeLegacyAdapterDependencies,
  sessionId: string,
): void {
  try {
    void Promise.resolve(dependencies.refreshSessions(sessionId)).catch((error) => {
      reportRefreshFailure(dependencies, error);
    });
  } catch (error) {
    reportRefreshFailure(dependencies, error);
  }
}

function createRuntime(
  dependencies: WorktreeMergeLegacyAdapterDependencies,
): WorktreeMergeRuntimeAdapter {
  return {
    onOpen(context): void {
      closeCompetingReactOverlays();
      dependencies.onOpen?.(context);
    },

    onClose(context): void {
      dependencies.onClose?.(context);
    },

    onRepositoryChanged(sessionId): void {
      refreshSessions(dependencies, sessionId);
    },

    toast(message, tone): void {
      dependencies.toast(message, tone);
    },
  };
}

/** Installs one runtime adapter; replacing it safely disposes the old adapter. */
export function installWorktreeMergeLegacyAdapter(
  dependencies: WorktreeMergeLegacyAdapterDependencies,
): () => void {
  if (activeInstallation?.dependencies === dependencies) return activeInstallation.dispose;
  activeInstallation?.dispose();

  const uninstallRuntime = configureWorktreeMergeRuntime(createRuntime(dependencies));
  let disposed = false;
  const installation: ActiveInstallation = {
    dependencies,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      uninstallRuntime();
      if (activeInstallation === installation) activeInstallation = null;
    },
  };
  activeInstallation = installation;
  return installation.dispose;
}

/** Opens by stable session id so event/render callers never assemble React context. */
export function openWorktreeMergeForSession(
  sessionId: string,
  intent?: WorktreeMergeIntent,
): boolean {
  const installation = activeInstallation;
  const normalizedId = sessionId.trim();
  if (!installation || !normalizedId) return false;

  const openIntent = (): void => {
    openWorktreeMergeNow(installation, normalizedId, intent);
  };
  if (!prepareFilePreviewForCompetingOverlay(openIntent)) return false;
  return openWorktreeMergeNow(installation, normalizedId, intent);
}

function openWorktreeMergeNow(
  installation: ActiveInstallation,
  normalizedId: string,
  intent?: WorktreeMergeIntent,
): boolean {
  if (!closeCompetingReactOverlays()) return false;

  const context = buildWorktreeMergeOpenContext(
    installation.dependencies.getSession(normalizedId),
    intent,
  );
  if (!context) {
    installation.dependencies.toast("未找到可操作的 worktree 会话。", "error");
    return false;
  }
  if (worktreeMergeController.open(context)) return true;
  installation.dependencies.toast("Worktree 合并界面尚未就绪，请刷新后重试。", "error");
  return false;
}

export function closeWorktreeMergeFromLegacy(): boolean {
  return worktreeMergeController.closeIfOpen();
}
