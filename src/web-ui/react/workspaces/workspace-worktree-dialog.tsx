import * as React from "react";
import { Alert, Card, Checkbox, Empty, Flex, List, Space, Spin, Tag, Typography } from "antd";
import "../issues/library-layout";
import { WandUiBoundary } from "../theme";

import { WandButton, WandDialogSurface, WandIcon } from "../ui";
import { httpWorkspacesRepository } from "./repository";
import {
  buildWorkspaceMergeAgentBrief,
  workspaceWorktreeSummary,
  type WorkspaceMergeAgentBrief,
} from "./workspace-worktree-model";
import type {
  Workspace,
  WorkspaceWorktreeOverview,
  WorkspaceWorktreeReview,
  WorkspacesRepository,
} from "./types";
import { describeError } from "../errors";

interface WorkspaceWorktreeDialogProps {
  open: boolean;
  workspace: Workspace;
  repository?: WorkspacesRepository;
  onStartAgent(brief: WorkspaceMergeAgentBrief): void | Promise<unknown>;
  onDismiss(): void;
}

const STATE_META: Record<WorkspaceWorktreeReview["state"], { label: string }> = {
  ready: { label: "待合并" },
  dirty: { label: "有未提交改动" },
  conflict: { label: "可能冲突" },
  empty: { label: "已同步" },
  unavailable: { label: "不可用" },
};



function WorktreeSelection({
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
    <WandUiBoundary><Checkbox
      checked={selected}
      disabled={disabled}
      data-wand-autofocus={first ? "" : undefined}
      onChange={onToggle}
    >
      <Flex vertical gap={4}>
        <Typography.Text strong>{workspaceWorktreeSummary(worktree)}</Typography.Text>
        <Typography.Text code title={worktree.path}>{worktree.branch}</Typography.Text>
        <Typography.Text type="secondary">{details}</Typography.Text>
        <Tag color={worktree.state === "ready" ? "success" : worktree.state === "dirty" || worktree.state === "conflict" ? "warning" : undefined}>{meta.label}</Tag>
      </Flex>
    </Checkbox></WandUiBoundary>
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
        if (!abort.signal.aborted) setError(describeError(loadError, "无法读取项目 Worktree。"));
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
      const brief = buildWorkspaceMergeAgentBrief(workspace, overview, [...selected]);
      await onStartAgent(brief);
      onDismiss();
    } catch (startError) {
      setError(describeError(startError, "无法启动 Worktree 合并 Agent。"));
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
      className="wand-task-library-dialog wand-worktree-modal"
      closeLabel="关闭项目 Worktree"
      testId="workspace-worktree-dialog"
      dismissable={!submitting}
    >
      <Flex vertical gap={16} aria-busy={loading || submitting}>
        <Alert type="info" showIcon icon={<WandIcon name="branch" size={18} strokeWidth={1.8}/>}
          title={`合并目标：${target}`} description={<Typography.Text code style={{ overflowWrap: "anywhere" }}>{overview?.repoRoot || workspace.cwd}</Typography.Text>}/>
        {loading ? <Spin tip="正在检查所有 Worktree…"><div style={{ minHeight: 100 }} role="status">正在检查所有 Worktree…</div></Spin>
          : overview && overview.worktrees.length > 0 ? <Card size="small" title="选择要交给 Agent 合并的 Worktree"
              extra={actionable.length > 1 ? <WandButton kind="ghost" type="button" disabled={submitting} onClick={toggleAll}>{selectedCount === actionable.length ? "取消全选" : "全选可合并项"}</WandButton> : null}>
            <List size="small" dataSource={[...overview.worktrees]} renderItem={(worktree, index) => <List.Item key={worktree.taskId}>
              <WorktreeSelection worktree={worktree} selected={selected.has(worktree.taskId)} first={index === 0} onToggle={() => toggle(worktree.taskId)}/>
            </List.Item>}/>
          </Card> : overview ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个项目还没有独立 Worktree。请先新建任务。"/> : null}
        {error ? <Alert type="error" showIcon role="alert" title={error}/> : null}
        <Flex component="footer" data-slot="worktree-footer" justify="space-between" align="center" gap={12} wrap>
          <Typography.Text type="secondary">{selectedCount > 0 ? `已选择 ${selectedCount} 个` : "选择后会启动一个托管 Agent"}</Typography.Text>
          <Space>
            <WandButton kind="ghost" disabled={submitting} onClick={onDismiss}>取消</WandButton>
            <WandButton kind="primary" disabled={loading || submitting || selectedCount === 0} onClick={() => void submit()}>{submitting ? "正在启动 Agent…" : `启动 Agent 合并${selectedCount ? ` ${selectedCount} 个` : ""}`}</WandButton>
          </Space>
        </Flex>
      </Flex>
    </WandDialogSurface>
  );
}
