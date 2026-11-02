import { siliconEmployeesRepository } from "../agents/employee-repository";
import type { SiliconEmployee } from "../../../ai-team-types.js";
import type { WandTaskAgent } from "../../../task-types.js";
import { AgentFields } from "../issues/agent-fields";
import { ISSUE_AGENT_TARGETS, normalizeIssueModelCatalog, type IssueModelCatalog } from "../issues/task-board-agent";
import { taskBoardRepository } from "../issues/task-board-repository";
import { WandSelect } from "../ui/select";
import * as React from "react";
import { Alert, Card, Checkbox, Empty, Flex, Form, List, Space, Spin, Tag, Typography } from "antd";
import "../issues/library-layout";
import { WandUiBoundary } from "../theme";

import { WandButton } from "../ui/button";
import { WandDialogSurface } from "../ui/dialog";
import { WandIcon } from "../ui/icons";
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
  sourcePath?: string;
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
  busy = false,
}: {
  worktree: WorkspaceWorktreeReview;
  selected: boolean;
  first: boolean;
  onToggle(): void;
  busy?: boolean;
}) {
  const meta = STATE_META[worktree.state];
  const disabled = busy || !worktree.actionable;
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
  sourcePath,
  onStartAgent,
  onDismiss,
}: WorkspaceWorktreeDialogProps) {
  const requestId = React.useRef(crypto.randomUUID());
  const [targetBranch, setTargetBranch] = React.useState("");
  const [employeeId, setEmployeeId] = React.useState("");
  const [employees, setEmployees] = React.useState<SiliconEmployee[]>([]);
  const [agent, setAgent] = React.useState<WandTaskAgent | null>(null);
  const [catalog, setCatalog] = React.useState<IssueModelCatalog | null>(null);
  const editedAgent = React.useRef(false);
  React.useEffect(() => {
    if (!open) { requestId.current = crypto.randomUUID(); setTargetBranch(""); setEmployeeId(""); setAgent(null); editedAgent.current = false; return; }
    let active = true;
    void Promise.all([siliconEmployeesRepository.list(), taskBoardRepository.models()]).then(([roles, models]) => {
      if (active) { setEmployees(roles.filter(role => !role.archivedAt)); setCatalog(normalizeIssueModelCatalog(models)); }
    }).catch(cause => { if (active) setError(describeError(cause, "无法读取执行配置。")); });
    return () => { active = false; };
  }, [open]);
  const [overview, setOverview] = React.useState<WorkspaceWorktreeOverview | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [loading, setLoading] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setLoading(true);
    setSubmitting(false);
    setError("");
    void repository.listWorktrees(workspace.id, { signal: abort.signal, targetBranch, employeeId })
      .then((result) => {
        if (!abort.signal.aborted) {
          setOverview(result);
          if (!editedAgent.current) setAgent(result.execution?.agent ?? null);
          setSelected(current => {
            const available = result.worktrees.filter(tree => tree.actionable);
            const kept = new Set([...current].filter(id => available.some(tree => tree.taskId === id)));
            if (!current.size && sourcePath) for (const tree of available) if (tree.path === sourcePath) kept.add(tree.taskId);
            return kept;
          });
        }
      })
      .catch((loadError) => {
        if (!abort.signal.aborted) setError(describeError(loadError, "无法读取项目 Worktree。"));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [open, repository, workspace.id, targetBranch, employeeId, sourcePath]);

  React.useEffect(() => {
    if (!open) { setOverview(null); setSelected(new Set()); }
  }, [open, workspace.id]);

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
    if (!overview || !agent || selectedCount === 0 || submitting || loading) return;
    setSubmitting(true);
    setError("");
    try {
      const brief = buildWorkspaceMergeAgentBrief(workspace, overview, [...selected]);
      await onStartAgent({ ...brief, requestId: requestId.current, employeeId: employeeId || overview.execution?.employeeId, agent });
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
      title="合并 Worktree"
      description={`${workspace.name} · ${count} 个 Worktree · 默认合并到 ${target}`}
      className="wand-task-library-dialog wand-worktree-modal"
      closeLabel="关闭项目 Worktree"
      testId="workspace-worktree-dialog"
      dismissable={!submitting}
    >
      <Flex vertical gap={16} aria-busy={loading || submitting}>
        {overview ? <Form layout="vertical" component="div" className="worktree-merge-fields">
          <Form.Item label="目标分支"><WandSelect searchable ariaLabel="合并目标分支" value={overview.targetBranch} disabled={submitting || loading}
            options={(overview.branches ?? [overview.targetBranch]).map(branch => ({ value: branch, label: `${branch}${branch === overview.defaultBranch ? "（默认分支）" : ""}` }))}
            onValueChange={setTargetBranch}/></Form.Item>
          <Form.Item label="执行角色"><WandSelect searchable ariaLabel="合并执行角色" value={employeeId || overview.execution?.employeeId} disabled={submitting || loading}
            options={employees.map(role => ({ value: role.id, label: role.name }))} onValueChange={id => { editedAgent.current = false; setEmployeeId(id); }}/></Form.Item>
          {agent ? <AgentFields agent={agent} catalog={catalog} providerOptions={ISSUE_AGENT_TARGETS.map(tool => ({ value: tool.value, label: tool.label }))}
            allowSdkEngine ariaPrefix="合并" disabled={submitting || loading} onChange={next => { editedAgent.current = true; setAgent(next); }}/> : null}
        </Form> : null}
        <Alert type="info" showIcon icon={<WandIcon name="branch" size={18} strokeWidth={1.8}/>}
          title={`${overview?.worktrees.filter(tree => selected.has(tree.taskId)).map(tree => tree.branch).join("、") || "选择来源分支"} → ${target}`}
          description={<Flex vertical gap={4}><Typography.Text code style={{ overflowWrap: "anywhere" }}>{overview?.targetCwd || overview?.repoRoot || workspace.cwd}</Typography.Text>
            <Typography.Text type="secondary">{overview?.targetCheckedOut === false ? "目标分支未检出，确认后会为它创建独立工作目录并启动会话。" : "将在目标分支的工作目录中启动会话。"} 仅执行本次所选工具与模型；不会推送或删除来源 Worktree。</Typography.Text></Flex>}/>
        {loading ? <Spin tip="正在检查所有 Worktree…"><div style={{ minHeight: 100 }} role="status">正在检查所有 Worktree…</div></Spin>
          : overview && overview.worktrees.length > 0 ? <Card size="small" title="选择要交给 Agent 合并的 Worktree"
              extra={!sourcePath && actionable.length > 1 ? <WandButton kind="ghost" type="button" disabled={submitting} onClick={toggleAll}>{selectedCount === actionable.length ? "取消全选" : "全选可合并项"}</WandButton> : null}>
            <List size="small" dataSource={overview.worktrees.filter(tree => !sourcePath || tree.path === sourcePath)} renderItem={(worktree, index) => <List.Item key={worktree.taskId}>
              <WorktreeSelection busy={submitting} worktree={worktree} selected={selected.has(worktree.taskId)} first={index === 0} onToggle={() => toggle(worktree.taskId)}/>
            </List.Item>}/>
          </Card> : overview ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个仓库没有可用的独立 Worktree。"/> : null}
        {error ? <Alert type="error" showIcon role="alert" title={error}/> : null}
        <Flex component="footer" className="wand-dialog-sticky-actions" data-slot="worktree-footer" justify="space-between" align="center" gap={12} wrap>
          <Typography.Text type="secondary">{selectedCount > 0 ? `已选择 ${selectedCount} 个` : "选择后会启动一个托管 Agent"}</Typography.Text>
          <Space>
            <WandButton kind="ghost" disabled={submitting} onClick={onDismiss}>取消</WandButton>
            <WandButton kind="primary" disabled={loading || submitting || selectedCount === 0 || !agent || !catalog} onClick={() => void submit()}>{submitting ? "正在启动 Agent…" : `确认并开始合并${selectedCount ? ` ${selectedCount} 个` : ""}`}</WandButton>
          </Space>
        </Flex>
      </Flex>
    </WandDialogSurface>
  );
}
