import "../issues/library-layout";
import { TaskTextArea, TaskForm } from "../issues/form-controls";
import { WandInput } from "../ui";
import { Alert, Button, Card, Checkbox, Collapse, Empty, Flex, Form, List, Space, Tag, Typography } from "antd";
import { type FormEvent, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { workspaceContextStore } from "../workspaces/workspace-context";
import { failureMessage } from "../errors";

import { ProviderLogo } from "../provider-logo";
import { issueAgentProviderLabel } from "../issues/task-board-agent";
import { sortProviderOptions, useProviderUsage } from "../provider-usage";
import { WandButton, WandDialogSurface, WandIcon } from "../ui";
import { milestonesStore, milestoneNameOf } from "../milestones/controller";
import { MilestonePicker } from "../milestones/picker";
import { useDefaultMilestone, usePreselectMilestone } from "../milestones/default-iteration";
import { missionsController, missionsStore } from "./controller";
import { httpMissionsRepository } from "./repository";
import type {
  InboxItem,
  MissionAttempt,
  MissionDetails,
  MissionDiff,
  MissionProvider,
  MissionsRepository,
} from "./types";

const PROVIDERS: Array<{ id: MissionProvider; label: string }> = [
  { id: "claude", label: "Claude" }, { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" }, { id: "grok", label: "Grok" },
  { id: "qoder", label: "Qoder" }, { id: "pi", label: "Pi" },
  { id: "gemini", label: "Gemini" },
];

const STATE_LABELS: Record<string, string> = {
  dispatching: "分派中", queued: "等待中", running: "执行中", working: "执行中",
  needs_input: "等待答复", needs_permission: "等待授权", completed: "已完成",
  done: "已完成", failed: "失败",
};

/**
 * 状态标签唯一出口：认不出来不再漏英文原值，也不再渲染成 undefined 空芯片
 * （原先 :94/:286/:300 三处 `STATE_LABELS[x]` 没有兜底，:278 直接把英文 id 印出来）。
 */
function missionStateLabel(state: string | null | undefined): string {
  if (!state) return "未知状态";
  return STATE_LABELS[state] ?? "未知状态";
}

interface DiffLine {
  key: string;
  text: string;
  path: string | null;
  line: number | null;
  side: "old" | "new";
  kind: "add" | "remove" | "context" | "meta";
}

function parseDiff(patch: string): DiffLine[] {
  let oldFile: string | null = null;
  let newFile: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  return patch.split("\n").slice(0, 5000).map((text, index) => {
    if (text.startsWith("--- ")) {
      const path = text.slice(4).replace(/^a\//, "");
      oldFile = path === "/dev/null" ? null : path;
    }
    if (text.startsWith("+++ ")) {
      const path = text.slice(4).replace(/^b\//, "");
      newFile = path === "/dev/null" ? null : path;
    }
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { key: String(index), text, path: newFile ?? oldFile, line: null, side: "new", kind: "meta" };
    }
    if (text.startsWith("+") && !text.startsWith("+++")) {
      const line = newLine++;
      return { key: String(index), text, path: newFile ?? oldFile, line, side: "new", kind: "add" };
    }
    if (text.startsWith("-") && !text.startsWith("---")) {
      const line = oldLine++;
      return { key: String(index), text, path: oldFile ?? newFile, line, side: "old", kind: "remove" };
    }
    if (text.startsWith(" ")) {
      const line = newLine++;
      oldLine++;
      return { key: String(index), text, path: newFile ?? oldFile, line, side: "new", kind: "context" };
    }
    return { key: String(index), text, path: newFile ?? oldFile, line: null, side: "new", kind: "meta" };
  });
}

function splitPaths(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function AttemptCard({ attempt, onOpen, onDiff }: {
  attempt: MissionAttempt;
  onOpen(): void;
  onDiff(): void;
}) {
  return <Card className="wand-missions-attempt" size="small" title={<Space><ProviderLogo provider={attempt.provider}/>{issueAgentProviderLabel(attempt.provider)}</Space>} extra={<Tag>{missionStateLabel(attempt.state)}</Tag>}>
    <Typography.Paragraph>{attempt.summary || attempt.error || attempt.branch || "正在准备独立 worktree…"}</Typography.Paragraph>
    <Space wrap><WandButton size="small" kind="ghost" disabled={!attempt.sessionId} onClick={onOpen}>打开会话</WandButton>
      <WandButton size="small" kind="outline" disabled={!attempt.worktreePath} onClick={onDiff}>审查 Diff</WandButton></Space>
  </Card>;
}

export function MissionsHost({ repository = httpMissionsRepository }: { repository?: MissionsRepository }) {
  const controller = useSyncExternalStore(missionsStore.subscribe, missionsStore.getSnapshot, missionsStore.getSnapshot);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [missions, setMissions] = useState<MissionDetails[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const providerUsage = useProviderUsage(controller.open);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [milestoneId, setMilestoneId] = useState("");
  const [cwd, setCwd] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [sharedPaths, setSharedPaths] = useState("");
  const [copyPaths, setCopyPaths] = useState("");
  const [providers, setProviders] = useState<Set<MissionProvider>>(new Set(["claude", "codex"]));
  const [diff, setDiff] = useState<MissionDiff | null>(null);
  const [diffAttempt, setDiffAttempt] = useState<MissionAttempt | null>(null);
  const [reviewTarget, setReviewTarget] = useState<{ filePath: string; line: number | null; side: "old" | "new" } | null>(null);
  const [reviewBody, setReviewBody] = useState("");

  const selected = missions.find((mission) => mission.id === selectedId) ?? missions[0] ?? null;
  const milestoneSnapshot = useSyncExternalStore(
    milestonesStore.subscribe,
    milestonesStore.getSnapshot,
    milestonesStore.getSnapshot,
  );
  const activeTaskContext = useSyncExternalStore(
    workspaceContextStore.subscribe,
    workspaceContextStore.getSnapshot,
    workspaceContextStore.getServerSnapshot,
  );
  const linkedTaskName = creating && activeTaskContext.taskId ? activeTaskContext.taskName : null;
  // 派发任务默认挂到「默认迭代」。
  const presetMilestone = useDefaultMilestone(activeTaskContext.workspaceId, creating);
  usePreselectMilestone(creating, presetMilestone, (id) => {
    setMilestoneId((current) => current || id);
  });
  const diffLines = useMemo(() => diff ? parseDiff(diff.patch) : [], [diff]);

  const refresh = async () => {
    const [nextMissions, nextInbox] = await Promise.all([
      repository.list(),
      repository.listInbox().catch(() => [] as InboxItem[]),
    ]);
    setMissions(nextMissions);
    setInbox(nextInbox);
    setSelectedId((current) => current && nextMissions.some((mission) => mission.id === current) ? current : nextMissions[0]?.id ?? null);
  };

  useEffect(() => {
    if (!controller.open) return;
    setCwd((value) => value || missionsStore.getRuntime()?.effectiveCwd() || "");
    setError("");
    void milestonesStore.load();
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "无法加载任务。"));
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 4000);
    return () => window.clearInterval(timer);
  }, [controller.open, controller.revision]);

  const openSession = (sessionId: string) => {
    void missionsStore.getRuntime()?.openSession(sessionId);
    missionsController.close();
  };

  const submitMission = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    if (!prompt.trim() || !cwd.trim() || providers.size === 0) {
      setCreateError("请填写任务目标、项目目录，并选择至少一个工具。");
      return;
    }
    missionsController.setDismissable(false);
    setSubmitting(true);
    setCreateError("");
    try {
      const created = await repository.create({
        title: title.trim() || undefined, prompt, cwd, providers: [...providers],
        baseRef: baseRef.trim() || undefined,
        sharedDirectories: splitPaths(sharedPaths), copyPaths: splitPaths(copyPaths),
        // 打开并行任务时若处于某个任务的上下文中，派发会话归属该任务。
        taskId: workspaceContextStore.getSnapshot().taskId ?? undefined,
        milestoneId: milestoneId || null,
      });
      setMissions((current) => [created, ...current.filter((mission) => mission.id !== created.id)]);
      setCreating(false); setPrompt(""); setTitle(""); setMilestoneId(""); setSelectedId(created.id);
      setError("");
      await refresh().catch((cause) => {
        setError(`任务已创建，但列表刷新失败：${failureMessage(cause, "请稍后重新打开并行任务。")}`);
      });
    } catch (cause) {
      setCreateError(failureMessage(cause, "创建任务失败，请重试。"));
    } finally {
      missionsController.setDismissable(true);
      setSubmitting(false);
    }
  };

  const openDiff = async (mission: MissionDetails, attempt: MissionAttempt) => {
    setBusy(true); setError("");
    try {
      setDiff(await repository.diff(mission.id, attempt.id));
      setDiffAttempt(attempt);
      setReviewTarget(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法读取 Diff。"); }
    finally { setBusy(false); }
  };

  const addComment = async () => {
    if (!selected || !diffAttempt || !reviewTarget || !reviewBody.trim()) return;
    setBusy(true); setError("");
    try {
      await repository.addComment(selected.id, diffAttempt.id, { ...reviewTarget, body: reviewBody });
      setReviewBody("");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法保存 Review。" ); }
    finally { setBusy(false); }
  };

  const sendReview = async () => {
    if (!selected || !diffAttempt) return;
    setBusy(true); setError("");
    try { await repository.sendReview(selected.id, diffAttempt.id); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法发送 Review。" ); }
    finally { setBusy(false); }
  };

  const pendingComments = selected && diffAttempt
    ? selected.comments.filter((comment) => comment.attemptId === diffAttempt.id && comment.status === "pending")
    : [];

  // 空态和工具栏的「新任务」是同一条路：就地展开新建表单，不跳页、不新造页面。
  const startCreateMission = (): void => {
    setCreateError("");
    setCreating(true);
  };

  return (
    <WandDialogSurface
      open={controller.open}
      title="并行任务"
      description="把同一个目标分派给多个 Agent，在独立 worktree 中并行尝试，并审查 Diff。"
      className="wand-task-library-dialog wand-missions-library-dialog wand-task-library-dialog-wide"
      dismissable={!creating && controller.dismissable}
      onOpenChange={(open) => { if (!open) missionsController.close(); }}
    >
      <Flex vertical gap={16}>
        <Flex align="center" justify="space-between" gap={12}>
          <Typography.Text type="secondary">{missions.length} 个任务</Typography.Text>
          <WandButton kind="primary" size="small" disabled={busy || submitting} onClick={startCreateMission}><WandIcon name="plus" slot="start" size={13}/>新任务</WandButton>
        </Flex>
        {error ? <Alert type="error" showIcon role="alert" title={error}/> : null}
        <Flex gap={16} wrap>
          <Flex vertical gap={8} component="aside" style={{ flex: "1 1 220px", minWidth: 0, maxHeight: "60vh", overflow: "auto" }}>
            {inbox.length ? <Card size="small" title="收件箱">
              <List size="small" dataSource={inbox} renderItem={(item) => <List.Item key={item.sessionId}>
                <WandButton kind="ghost" type="button" style={{ height: "auto", width: "100%", justifyContent: "flex-start" }} onClick={() => {
                  void repository.markInboxRead(item.sessionId).catch(() => undefined);
                  if (item.sessionId) void openSession(item.sessionId);
                }}><Flex vertical align="flex-start"><Typography.Text strong>{item.title}</Typography.Text><Typography.Text type="secondary">{missionStateLabel(item.state)}{item.summary ? ` · ${item.summary}` : ""}</Typography.Text></Flex></WandButton>
              </List.Item>}/>
            </Card> : null}
            {missions.map((mission) => <WandButton kind={selected?.id === mission.id ? "soft" : "ghost"} key={mission.id}
              style={{ height: "auto", width: "100%", justifyContent: "flex-start" }} onClick={() => { setSelectedId(mission.id); setDiff(null); }}>
              <Flex vertical align="flex-start" gap={4} style={{ minWidth: 0 }}>
                <Typography.Text strong ellipsis>{mission.title}</Typography.Text>
                <Typography.Text type="secondary">{mission.attempts.length} 个 Agent · {missionStateLabel(mission.status)}</Typography.Text>
                {mission.milestoneId ? <Typography.Text type="secondary"><WandIcon name="milestone" size={11}/> {milestoneNameOf(milestoneSnapshot.items, mission.milestoneId) || "里程碑"}</Typography.Text> : null}
              </Flex>
            </WandButton>)}
            {!missions.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有并行任务。创建一个，让多个 Agent 在独立 worktree 中并行尝试。"><WandButton kind="soft" size="small" disabled={creating} onClick={startCreateMission}>新建任务</WandButton></Empty> : null}
          </Flex>
          <Flex vertical gap={16} component="main" style={{ flex: "3 1 280px", minWidth: 0, maxHeight: "60vh", overflow: "auto" }}>
            {selected ? <>
              <Flex align="center" justify="space-between" gap={12} wrap>
                <Flex vertical><Typography.Title level={4} style={{ margin: 0 }}>{selected.title}</Typography.Title><Typography.Text type="secondary">{selected.cwd} · 基线 {selected.worktree.baseRef || "当前分支"}</Typography.Text></Flex>
                <Tag>{missionStateLabel(selected.status)}</Tag>
              </Flex>
              {selected.milestoneId ? <Typography.Text type="secondary"><WandIcon name="milestone" size={12}/> {milestoneNameOf(milestoneSnapshot.items, selected.milestoneId) || "里程碑"}</Typography.Text> : null}
              <Typography.Paragraph style={{ whiteSpace: "pre-wrap" }}>{selected.prompt}</Typography.Paragraph>
              <Flex gap={12} wrap>{selected.attempts.map((attempt) => <div key={attempt.id} style={{ flex: "1 1 240px", minWidth: 0 }}><AttemptCard attempt={attempt} onOpen={() => attempt.sessionId && openSession(attempt.sessionId)} onDiff={() => void openDiff(selected, attempt)}/></div>)}</Flex>
              {diff && diffAttempt ? <Card size="small" title={`${issueAgentProviderLabel(diffAttempt.provider)} 的 Diff`} extra={<WandButton size="small" kind="ghost" onClick={() => setDiff(null)}>收起</WandButton>}>
                <Flex vertical gap={12}>
                  <Typography.Text type="secondary">{diff.files.length} 个文件{diff.truncated ? " · 内容已截断" : ""}</Typography.Text>
                  <div className="wand-missions-diff" role="list" aria-label="任务 Diff" style={{ maxHeight: "48vh", overflow: "auto" }}>
                    <Flex vertical style={{ minWidth: "max-content" }}>
                      {diffLines.map((line) => <Button key={line.key} type="text" color={line.kind === "add" ? "green" : line.kind === "remove" ? "danger" : undefined}
                        variant={line.kind === "add" || line.kind === "remove" ? "filled" : undefined}
                        style={{ justifyContent: "flex-start", height: "auto", fontFamily: "var(--font-mono)" }}
                        disabled={!line.path || line.line === null} title={line.path && line.line ? `在 ${line.path}:${line.line} 添加意见` : undefined}
                        onClick={() => line.path && setReviewTarget({ filePath: line.path, line: line.line, side: line.side })}>
                        <span style={{ display: "inline-block", minWidth: 40 }}>{line.line ?? ""}</span><code style={{ whiteSpace: "pre" }}>{line.text || " "}</code>
                      </Button>)}
                    </Flex>
                  </div>
                  {reviewTarget ? <Form component={false} layout="vertical"><Form.Item htmlFor="wand-missions-review-body" label={`${reviewTarget.filePath}${reviewTarget.line ? `:${reviewTarget.line}` : ""}`}>
                    <TaskTextArea className="resize-none" id="wand-missions-review-body" value={reviewBody} onChange={(event) => setReviewBody(event.target.value)} placeholder="写下具体、可执行的修改意见…"/>
                    <WandButton kind="primary" size="small" disabled={busy || !reviewBody.trim()} onClick={() => void addComment()}>{busy ? "处理中…" : "加入 Review"}</WandButton>
                  </Form.Item></Form> : null}
                  {pendingComments.length ? <>
                    <List size="small" dataSource={pendingComments} renderItem={(comment) => <List.Item key={comment.id}><Flex vertical><Typography.Text strong>{comment.filePath}{comment.line ? `:${comment.line}` : ""}</Typography.Text><Typography.Text>{comment.body}</Typography.Text></Flex></List.Item>}/>
                    <WandButton kind="primary" disabled={busy} onClick={() => void sendReview()}>{busy ? "处理中…" : `发送 ${pendingComments.length} 条意见`}</WandButton>
                  </> : null}
                </Flex>
              </Card> : null}
            </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择或创建一个任务，看每个 Agent 的尝试与 Diff。"><WandButton kind="soft" size="small" disabled={creating} onClick={startCreateMission}>新建任务</WandButton></Empty>}
          </Flex>
        </Flex>
      </Flex>
      <WandDialogSurface
        open={creating}
        title="新建并行任务"
        description="创建后立即分派给所选工具，在独立 Worktree 中执行。"
        className="wand-ui-dialog-content wand-task-library-dialog wand-missions-create-library-dialog"
        closeLabel="关闭新建并行任务"
        dismissable={!submitting}
        onOpenChange={(open) => { if (!open && !submitting) setCreating(false); }}
      >
        <TaskForm className="wand-missions-create" noValidate aria-busy={submitting} onSubmit={(event) => void submitMission(event)}>
          <Flex vertical gap={16}>
            <Form.Item label="任务标题（可选）"><WandInput disabled={submitting} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：重构会话恢复流程"/></Form.Item>
            <Form.Item label="里程碑（可选）">
              <MilestonePicker
                value={milestoneId || null}
                workspaceId={activeTaskContext.workspaceId}
                disabled={submitting}
                onChange={(next) => setMilestoneId(next ?? "")}
              />
            </Form.Item>
            <Form.Item label="目标"><TaskTextArea className="resize-none" data-wand-autofocus disabled={submitting} required value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述清楚完成条件、限制和验证要求…"/></Form.Item>
            {linkedTaskName ? (
              <Alert type="info" title={`派发的 Agent 会话将关联到当前任务「${linkedTaskName}」。`}/>
            ) : null}
            <Form.Item label="项目目录"><WandInput required disabled={submitting} value={cwd} onChange={(event) => setCwd(event.target.value)}/></Form.Item>
            <Space wrap role="group" aria-label="执行工具">
              {providerUsage === null ? <p role="status">正在加载工具列表…</p> : sortProviderOptions(
                PROVIDERS, providerUsage, (provider) => provider.id,
              ).map((provider) => (
                <Checkbox key={provider.id} className={providers.has(provider.id) ? "active" : ""} disabled={submitting} checked={providers.has(provider.id)} onChange={() => setProviders((current) => {
                    const next = new Set(current); if (next.has(provider.id)) next.delete(provider.id); else next.add(provider.id); return next;
                  })}>
                  <ProviderLogo provider={provider.id}/><span>{provider.label}</span>
                </Checkbox>
              ))}
            </Space>
            <Collapse items={[{ key: "worktree", label: "Worktree 高级选项", children: <>
              <Form.Item label="基线 ref"><WandInput disabled={submitting} value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="当前分支"/></Form.Item>
              <Form.Item label="共享目录（仅 gitignored）"><WandInput disabled={submitting} value={sharedPaths} onChange={(event) => setSharedPaths(event.target.value)} placeholder="node_modules, .venv"/></Form.Item>
              <Form.Item label="复制路径（仅 gitignored）"><WandInput disabled={submitting} value={copyPaths} onChange={(event) => setCopyPaths(event.target.value)} placeholder=".env.local"/></Form.Item>
            </> }]}/>
          {createError ? <Alert type="error" showIcon role="alert" title={createError}/> : null}
          <Flex justify="flex-end" gap={8}>
            <WandButton kind="ghost" disabled={submitting} onClick={() => setCreating(false)}>取消</WandButton>
            <WandButton kind="primary" type="submit" disabled={submitting || !prompt.trim() || !cwd.trim() || providers.size === 0}>
              {submitting ? "正在分派…" : `分派给 ${providers.size} 个 Agent`}
            </WandButton>
          </Flex>
          </Flex>
        </TaskForm>
      </WandDialogSurface>
    </WandDialogSurface>
  );
}
