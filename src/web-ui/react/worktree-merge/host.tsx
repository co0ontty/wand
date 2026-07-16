import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { WandButton, WandDialogSurface } from "../ui";
import { worktreeMergeController, worktreeMergeStore } from "./controller";
import {
  canConfirmWorktreeMerge,
  inspectionStatusMessage,
  worktreeMergeAvailability,
  worktreeMergeResultMessage,
} from "./model";
import {
  httpWorktreeMergeRepository,
  WorktreeMergeRepositoryError,
} from "./repository";
import type {
  WorktreeMergeInspection,
  WorktreeMergeRepository,
  WorktreeMergeResult,
} from "./types";

export interface WorktreeMergeHostProps {
  repository?: WorktreeMergeRepository;
}

function presentError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message || error.message === "Failed to fetch") return fallback;
  return error.message;
}

function MergeDetail({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warning" | "success" | "error";
}) {
  const valueClassName = tone
    ? `wand-worktree-value wand-worktree-value-${tone}`
    : "wand-worktree-value";
  return (
    <div className="wand-worktree-row">
      <span className="wand-worktree-label">{label}</span>
      <strong className={valueClassName}>{value || "-"}</strong>
    </div>
  );
}

function InspectionDetails({ inspection }: { inspection: WorktreeMergeInspection }) {
  return (
    <>
      <MergeDetail label="目标分支" value={inspection.targetBranch} />
      <MergeDetail label="待合并提交" value={String(inspection.aheadCount)} />
      <MergeDetail
        label="未提交改动"
        value={inspection.hasUncommittedChanges ? "有" : "无"}
        tone={inspection.hasUncommittedChanges ? "warning" : "success"}
      />
      <MergeDetail
        label="冲突风险"
        value={inspection.hasConflicts ? "有" : "无"}
        tone={inspection.hasConflicts ? "error" : "success"}
      />
      {inspection.commits.length > 0 ? (
        <section className="wand-worktree-commits" aria-labelledby="worktree-merge-commits-title">
          <p className="wand-worktree-commits-title" id="worktree-merge-commits-title">
            <strong>待合并提交列表（{inspection.commits.length}）</strong>
          </p>
          <div className="wand-worktree-commit-list" role="list" aria-label="待合并提交">
            {inspection.commits.map((commit) => (
              <div className="wand-worktree-row" role="listitem" key={commit.hash}>
                <span><code>{commit.shortHash}</code></span>
                <strong className="wand-worktree-value">{commit.subject || commit.hash}</strong>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <p className={`wand-worktree-status wand-worktree-status-${inspection.ok ? "success" : inspection.hasConflicts ? "error" : "warning"}`}>
        {inspectionStatusMessage(inspection)}
      </p>
    </>
  );
}

export function WorktreeMergeHost({
  repository = httpWorktreeMergeRepository,
}: WorktreeMergeHostProps) {
  const controller = useSyncExternalStore(
    worktreeMergeStore.subscribe,
    worktreeMergeStore.getSnapshot,
    worktreeMergeStore.getSnapshot,
  );
  const context = controller.context;
  const availability = useMemo(
    () => context ? worktreeMergeAvailability(context) : { allowed: false, reason: "" },
    [context],
  );
  const [inspection, setInspection] = useState<WorktreeMergeInspection | null>(null);
  const [mergeResult, setMergeResult] = useState<WorktreeMergeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const cancelButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!controller.open || !context) return;
    const abort = new AbortController();
    setInspection(null);
    setMergeResult(null);
    setSubmitting(false);
    setError("");

    if (!availability.allowed || context.intent === "cleanup") {
      setLoading(false);
      return () => abort.abort();
    }

    setLoading(true);
    void repository.inspect(context.sessionId, { signal: abort.signal })
      .then((result) => {
        if (!abort.signal.aborted) {
          setInspection(result);
          worktreeMergeStore.getRuntime()?.onRepositoryChanged(context.sessionId);
        }
      })
      .catch((inspectError) => {
        if (!abort.signal.aborted) {
          setError(presentError(inspectError, "无法检查 worktree 合并状态。"));
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [availability.allowed, context?.intent, context?.sessionId, controller.open, controller.revision, repository]);

  useEffect(() => {
    if (!controller.open || loading) return;
    const frame = window.requestAnimationFrame(() => cancelButton.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [controller.open, loading, inspection, mergeResult]);

  function notifyChanged(sessionId: string): void {
    worktreeMergeStore.getRuntime()?.onRepositoryChanged(sessionId);
  }

  async function confirmMerge(): Promise<void> {
    if (!context || submitting || !canConfirmWorktreeMerge(inspection)) return;
    worktreeMergeController.setDismissable(false);
    setSubmitting(true);
    setError("");
    try {
      const result = await repository.merge(context.sessionId);
      setMergeResult(result);
      notifyChanged(context.sessionId);
      const message = worktreeMergeResultMessage(result);
      worktreeMergeStore.getRuntime()?.toast(message, result.cleanupDone ? "success" : "info");
      if (result.cleanupDone) worktreeMergeController.close();
    } catch (mergeError) {
      if (mergeError instanceof WorktreeMergeRepositoryError && mergeError.result) {
        setMergeResult(mergeError.result);
        notifyChanged(context.sessionId);
      }
      setError(presentError(mergeError, "无法合并 worktree。"));
    } finally {
      worktreeMergeController.setDismissable(true);
      setSubmitting(false);
    }
  }

  async function confirmCleanup(): Promise<void> {
    if (!context || submitting) return;
    worktreeMergeController.setDismissable(false);
    setSubmitting(true);
    setError("");
    try {
      const result = await repository.cleanup(context.sessionId);
      if (!result.ok) throw new Error("无法清理 worktree。");
      notifyChanged(context.sessionId);
      worktreeMergeStore.getRuntime()?.toast("已完成 worktree 清理。", "success");
      worktreeMergeController.close();
    } catch (cleanupError) {
      setError(presentError(cleanupError, "无法清理 worktree。"));
    } finally {
      worktreeMergeController.setDismissable(true);
      setSubmitting(false);
    }
  }

  const cleanupRequired = context?.intent === "cleanup"
    || (mergeResult != null && mergeResult.cleanupDone === false && !!mergeResult.mergeCommit);
  const mergeAllowed = availability.allowed && canConfirmWorktreeMerge(inspection);
  const title = cleanupRequired ? "清理 Worktree" : "合并 Worktree";
  const description = cleanupRequired
    ? "完成已合并分支遗留的 worktree 清理。"
    : "检查当前任务分支并安全合并到目标分支。";

  return (
    <WandDialogSurface
      open={controller.open}
      onOpenChange={(open) => { if (!open) worktreeMergeController.close(); }}
      title={title}
      description={description}
      className="wand-ui-dialog-content wand-worktree-dialog"
      headerClassName="wand-worktree-header"
      titleClassName="wand-worktree-title"
      descriptionClassName="wand-worktree-description"
      closeLabel="关闭 Worktree 合并"
      testId="worktree-merge-dialog"
      dismissable={!submitting}
    >
      <div className="wand-worktree-body">
        <div className="wand-worktree-content" aria-busy={loading || submitting}>
          {context ? (
            <>
              <MergeDetail
                label="来源分支"
                value={inspection?.sourceBranch || context.sourceBranch || "-"}
              />
              <MergeDetail
                label="工作目录"
                value={inspection?.worktreePath || context.worktreePath || "-"}
              />
            </>
          ) : null}

          {!availability.allowed ? (
            <p className="wand-worktree-status wand-worktree-status-warning" role="status">
              {availability.reason}
            </p>
          ) : loading ? (
            <p className="wand-worktree-status" role="status">正在检查 worktree 合并状态…</p>
          ) : inspection && !cleanupRequired ? (
            <InspectionDetails inspection={inspection} />
          ) : cleanupRequired ? (
            <>
              <MergeDetail
                label="目标分支"
                value={mergeResult?.targetBranch || context?.targetBranch || "主分支"}
              />
              {mergeResult?.mergeCommit ? (
                <MergeDetail label="合并提交" value={mergeResult.mergeCommit.slice(0, 12)} />
              ) : null}
              <p className="wand-worktree-status wand-worktree-status-warning">
                合并结果已经保留；此操作只重试删除遗留 worktree 和任务分支。
              </p>
            </>
          ) : null}

          {error ? <p className="wand-worktree-error" role="alert">{error}</p> : null}
        </div>

        <div className="wand-worktree-actions">
          <WandButton
            ref={cancelButton}
            kind="secondary"
            disabled={submitting}
            onClick={() => worktreeMergeController.close()}
          >
            {availability.allowed ? "取消" : "关闭"}
          </WandButton>
          {cleanupRequired && availability.allowed ? (
            <WandButton kind="primary" disabled={submitting} onClick={() => void confirmCleanup()}>
              {submitting ? "清理中…" : "重试清理"}
            </WandButton>
          ) : context?.intent === "merge" && availability.allowed ? (
            <WandButton
              kind="primary"
              disabled={!mergeAllowed || submitting || loading}
              onClick={() => void confirmMerge()}
            >
              {submitting ? "合并中…" : "确认合并并清理"}
            </WandButton>
          ) : null}
        </div>
      </div>
    </WandDialogSurface>
  );
}
