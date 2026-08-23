import * as React from "react";

import { WandButton, WandDialogSurface, WandIcon } from "../ui";
import { httpWorkspacesRepository } from "./repository";
import {
  buildWorkspaceMergeAgentPrompt,
  workspaceWorktreeSummary,
} from "./workspace-worktree-model";
import type {
  Workspace,
  WorkspaceWorktreeOverview,
  WorkspaceWorktreeReview,
  WorkspacesRepository,
} from "./types";

interface WorkspaceWorktreeDialogProps {
  open: boolean;
  workspace: Workspace;
  repository?: WorkspacesRepository;
  onStartAgent(prompt: string): void | Promise<unknown>;
  onDismiss(): void;
}

const STATE_META: Record<WorkspaceWorktreeReview["state"], { label: string; tone: string }> = {
  ready: { label: "待合并", tone: "ready" },
  dirty: { label: "有未提交改动", tone: "dirty" },
  conflict: { label: "可能冲突", tone: "conflict" },
  empty: { label: "已同步", tone: "empty" },
  unavailable: { label: "不可用", tone: "unavailable" },
};



function presentError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message || error.message === "Failed to fetch") return fallback;
  return error.message;
}

function WorktreeBubble({
  worktree,
  selected,
  first,
  onToggle,
}: {
  worktree: WorkspaceWorktreeReview;
  selected: boolean;
  first: boolean;
  onToggle(): void;
}) {
  const meta = STATE_META[worktree.state];
  const disabled = !worktree.actionable;
  const details = [
    worktree.aheadCount > 0 ? `${worktree.aheadCount} commits` : "",
    worktree.hasUncommittedChanges ? "工作区有改动" : "",
    worktree.hasConflicts ? "需处理冲突" : "",
  ].filter(Boolean).join(" · ") || worktree.reason || "没有新的待合并改动";
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      disabled={disabled}
      className={`workspace-worktree-bubble is-${meta.tone}${selected ? " is-selected" : ""}`}
      data-wand-autofocus={first ? "" : undefined}
      onClick={onToggle}
    >
      <span className="workspace-worktree-bubble-check" aria-hidden="true">{selected ? <WandIcon name="check" size={12}/> : ""}</span>
      <span className="workspace-worktree-bubble-copy">
        <strong>{workspaceWorktreeSummary(worktree)}</strong>
        <code title={worktree.path}>{worktree.branch}</code>
        <small>{details}</small>
      </span>
      <span className={`workspace-worktree-state is-${meta.tone}`}>{meta.label}</span>
    </button>
  );
}

export function WorkspaceWorktreeDialog({
  open,
  workspace,
  repository = httpWorkspacesRepository,
  onStartAgent,
  onDismiss,
}: WorkspaceWorktreeDialogProps) {
  const [overview, setOverview] = React.useState<WorkspaceWorktreeOverview | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [loading, setLoading] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setOverview(null);
    setSelected(new Set());
    setLoading(true);
    setSubmitting(false);
    setError("");
    void repository.listWorktrees(workspace.id, { signal: abort.signal })
      .then((result) => {
        if (!abort.signal.aborted) setOverview(result);
      })
      .catch((loadError) => {
        if (!abort.signal.aborted) setError(presentError(loadError, "无法读取项目 Worktree。"));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [open, repository, workspace.id]);

  const actionable = overview?.worktrees.filter((worktree) => worktree.actionable) ?? [];
  const selectedCount = actionable.filter((worktree) => selected.has(worktree.taskId)).length;

  function toggle(taskId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  function toggleAll(): void {
    if (selectedCount === actionable.length) {
      setSelected(new Set());
      return;
    }
    setSelected(new Set(actionable.map((worktree) => worktree.taskId)));
  }

  async function submit(): Promise<void> {
    if (!overview || selectedCount === 0 || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const prompt = buildWorkspaceMergeAgentPrompt(workspace, overview, [...selected]);
      await onStartAgent(prompt);
      onDismiss();
    } catch (startError) {
      setError(presentError(startError, "无法启动 Worktree 合并 Agent。"));
    } finally {
      setSubmitting(false);
    }
  }

  const target = overview?.targetBranch || "项目默认分支";
  const count = overview?.worktrees.length ?? workspace.worktreeCount ?? 0;
  return (
    <WandDialogSurface
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) onDismiss(); }}
      title="项目 Worktrees"
      description={`${workspace.name} · ${count} 个 Worktree · 默认合并到 ${target}`}
      className="workspace-worktree-dialog"
      overlayClassName="workspace-worktree-overlay"
      titleClassName="workspace-worktree-title"
      descriptionClassName="workspace-worktree-description"
      headerClassName="workspace-worktree-header"
      closeLabel="关闭项目 Worktree"
      testId="workspace-worktree-dialog"
      dismissable={!submitting}
    >
      <div className="workspace-worktree-body" aria-busy={loading || submitting}>
        <section className="workspace-worktree-lens" aria-label="合并目标">
          <span className="workspace-worktree-lens-icon"><WandIcon name="branch" size={18} strokeWidth={1.8}/></span>
          <span>
            <small>合并目标</small>
            <strong>{target}</strong>
          </span>
          <code title={overview?.repoRoot || workspace.cwd}>{overview?.repoRoot || workspace.cwd}</code>
        </section>

        {loading ? (
          <p className="workspace-worktree-loading" role="status">正在检查所有 Worktree…</p>
        ) : overview && overview.worktrees.length > 0 ? (
          <fieldset className="workspace-worktree-picker">
            <legend>
              <span>选择要交给 Agent 合并的 Worktree</span>
              {actionable.length > 1 ? (
                <button type="button" disabled={submitting} onClick={toggleAll}>
                  {selectedCount === actionable.length ? "取消全选" : "全选可合并项"}
                </button>
              ) : null}
            </legend>
            <div className="workspace-worktree-bubbles">
              {overview.worktrees.map((worktree, index) => (
                <WorktreeBubble
                  key={worktree.taskId}
                  worktree={worktree}
                  selected={selected.has(worktree.taskId)}
                  first={index === 0}
                  onToggle={() => toggle(worktree.taskId)}
                />
              ))}
            </div>
          </fieldset>
        ) : overview ? (
          <p className="workspace-worktree-empty">这个项目还没有独立 Worktree。请先新建任务。</p>
        ) : null}

        {error ? <p className="workspace-worktree-error" role="alert">{error}</p> : null}
      </div>
      <footer className="workspace-worktree-footer">
        <span>{selectedCount > 0 ? `已选择 ${selectedCount} 个` : "选择后会启动一个托管 Agent"}</span>
        <div>
          <WandButton kind="ghost" disabled={submitting} onClick={onDismiss}>取消</WandButton>
          <WandButton
            kind="primary"
            disabled={loading || submitting || selectedCount === 0}
            onClick={() => void submit()}
          >
            {submitting ? "正在启动 Agent…" : `启动 Agent 合并${selectedCount ? ` ${selectedCount} 个` : ""}`}
          </WandButton>
        </div>
      </footer>
    </WandDialogSurface>
  );
}
