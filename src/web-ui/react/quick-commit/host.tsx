import "../issues/library-layout";
import { TaskForm, TaskTextArea } from "../issues/form-controls";
import { WandInput } from "../ui";
import { Alert, Card, Empty, Flex, Form, List, Radio, Space, Spin, Tag, Typography } from "antd";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as React from "react";
import { WandButton, WandDialogSurface, WandSwitch } from "../ui";
import { quickCommitController, quickCommitStore } from "./controller";
import {
  buildQuickCommitInput,
  buildQuickCommitOutcome,
  hasQuickCommitChanges,
  QUICK_COMMIT_ACTIONS,
  quickCommitActionMeta,
  quickCommitStatusBadge,
} from "./model";
import { httpQuickCommitRepository } from "./repository";
import { IterationContextPanel } from "./iteration-panel";
import type {
  QuickCommitAction,
  QuickCommitContextMode,
  QuickCommitForm,
  QuickCommitIterationContext,
  QuickCommitOutcome,
  QuickCommitRepository,
  QuickCommitSelection,
  QuickCommitStatus,
} from "./types";
import { describeError } from "../errors";
import { MOTION_DWELL_FAILED_MS, MOTION_DWELL_SENT_MS } from "../ui/motion-tokens";
import { notifyTasksChanged } from "../task-changes";

export interface QuickCommitHostProps {
  repository?: QuickCommitRepository;
}

const EMPTY_FORM: QuickCommitForm = { message: "", tag: "", tagEdited: false };

function statusDescription(status: QuickCommitStatus | null): string {
  if (!status) return "加载 Git 状态并准备提交。";
  const parts = [
    status.branch || "(no branch)",
    status.modifiedCount > 0 ? `${status.modifiedCount} 个改动` : "工作区干净",
  ];
  if (status.ahead > 0) parts.push(`↑${status.ahead}`);
  if (status.behind > 0) parts.push(`↓${status.behind}`);
  return parts.join(" · ");
}

function commitSummary(outcome: QuickCommitOutcome): string {
  const submodule = outcome.submoduleCount > 0
    ? `已先提交 ${outcome.submoduleCount} 个 submodule，`
    : "";
  const commit = outcome.commitHash ? ` ${outcome.commitHash}` : "";
  const tag = outcome.tagName ? `，已打 Tag ${outcome.tagName}` : "";
  return `${submodule}已提交${commit}${tag}`;
}

function CommitValue({ hash, subject, empty }: { hash: string; subject: string; empty: string }) {
  if (!hash) return <Typography.Text type="secondary">{empty}</Typography.Text>;
  return <Flex vertical gap={4}>
    <Typography.Text code>{hash}</Typography.Text>
    {subject ? <Typography.Text type="secondary" ellipsis title={subject}>{subject}</Typography.Text> : null}
  </Flex>;
}

function ResultPair({ label, before, after }: {
  label: string; before: React.ReactNode; after: React.ReactNode;
}) {
  return <Card size="small" title={label}>
    <Flex gap={12} align="center" wrap>
      {before}<Typography.Text type="secondary" aria-hidden="true">→</Typography.Text>{after}
    </Flex>
  </Card>;
}

const FILE_TONES: Record<string, string | undefined> = {
  added: "success", untracked: "success", modified: "warning", deleted: "error", renamed: "processing",
};

function ChangedFiles({ status }: { status: QuickCommitStatus }) {
  return <Card size="small" title={<span id="wand-quick-files-title">改动文件</span>} extra={<Tag>{status.modifiedCount}</Tag>} aria-labelledby="wand-quick-files-title">
    {status.files.length > 0 ? <List size="small" style={{ maxHeight: 148, overflow: "auto" }}
      dataSource={[...status.files]} renderItem={(file) => {
        const badge = quickCommitStatusBadge(file.status);
        const submoduleLabels = file.submoduleState
          ? [file.submoduleState.commitChanged ? "新指针" : "", file.submoduleState.hasTrackedChanges ? "有改动" : "", file.submoduleState.hasUntracked ? "未跟踪" : ""].filter(Boolean)
          : [];
        return <List.Item key={file.path} title={file.path}>
          <Flex gap={8} align="center" style={{ minWidth: 0, width: "100%" }}>
            <Tag color={FILE_TONES[badge.tone]} role="img" title={badge.label} aria-label={badge.label}>{badge.letter}</Tag>
            <Typography.Text ellipsis style={{ minWidth: 0, flex: 1 }} title={file.path}>{file.path}</Typography.Text>
            {file.isSubmodule ? <Tag color="processing">submodule{submoduleLabels.length ? ` · ${submoduleLabels.join(" / ")}` : ""}</Tag> : null}
          </Flex>
        </List.Item>;
      }}/>
      : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可提交的改动。"/>}
  </Card>;
}

/** 提交前先明确当前分支与工作区状态，避免表单脱离上下文。 */
function CommitWorkspaceLens({ status }: { status: QuickCommitStatus }) {
  const hasChanges = status.modifiedCount > 0;
  const state = hasChanges ? `${status.modifiedCount} 个改动待处理`
    : status.ahead > 0 ? `${status.ahead} 个 commit 待推送` : "工作区干净";
  return <Alert aria-label="当前工作区" showIcon type={hasChanges ? "info" : "success"}
    title={status.branch || "未识别分支"} description={state}
    action={hasChanges && status.ahead > 0 ? <Tag color="success">↑{status.ahead}</Tag> : undefined}/>;
}

export function QuickCommitHost({ repository = httpQuickCommitRepository }: QuickCommitHostProps) {
  const controller = useSyncExternalStore(
    quickCommitStore.subscribe,
    quickCommitStore.getSnapshot,
    quickCommitStore.getSnapshot,
  );
  const [status, setStatus] = useState<QuickCommitStatus | null>(null);
  const [form, setForm] = useState<QuickCommitForm>(EMPTY_FORM);
  const [action, setAction] = useState<QuickCommitAction>("commit");
  const [includeSubmodule, setIncludeSubmodule] = useState(false);
  const [archiveRelatedTasks, setArchiveRelatedTasks] = useState(false);
  const [iterationContext, setIterationContext] = useState<QuickCommitIterationContext | null>(null);
  const [contextMode, setContextMode] = useState<QuickCommitContextMode>("iteration");
  // null = 用服务端给的默认勾选（上次提交以来的条目）；用户一动手就换成显式集合。
  const [selectedOverride, setSelectedOverride] = useState<string[] | null>(null);
  const [includeDiff, setIncludeDiff] = useState(false);
  const [generatedFrom, setGeneratedFrom] = useState<{ source: QuickCommitContextMode; count: number } | null>(null);
  const [outcome, setOutcome] = useState<QuickCommitOutcome | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitPhase, setSubmitPhase] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [submitResult, setSubmitResult] = useState("");
  const [resultNote, setResultNote] = useState("");
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState("");
  const [pushError, setPushError] = useState("");
  const generationAbort = useRef<AbortController | null>(null);
  const messageInput = useRef<HTMLTextAreaElement | null>(null);
  const context = controller.context;

  /**
   * 面板自己拉状态：顺手把同一份结果交给顶栏徽章，避免面板显示“3 个改动”
   * 而右上角还停在上一轮快照。
   */
  async function loadStatusWithBadgeSync(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<QuickCommitStatus> {
    const requestedAt = quickCommitStore.getRuntime()?.nextStatusRequestTime() ?? Date.now();
    const loaded = await repository.loadStatus(sessionId, signal ? { signal } : {});
    quickCommitStore.getRuntime()?.onStatusLoaded(sessionId, loaded, requestedAt);
    return loaded;
  }

  useEffect(() => {
    if (!controller.open || !context) return;
    const abort = new AbortController();
    generationAbort.current?.abort();
    generationAbort.current = null;
    setStatus(null);
    setSubmitPhase("idle");
    setSubmitResult("");
    setResultNote("");
    setForm(EMPTY_FORM);
    setAction("commit");
    setIncludeSubmodule(false);
    setArchiveRelatedTasks(false);
    setIterationContext(null);
    setSelectedOverride(null);
    setIncludeDiff(false);
    setGeneratedFrom(null);
    setOutcome(null);
    setLoading(true);
    setGenerating(false);
    setError("");
    setPushError("");
    void loadStatusWithBadgeSync(context.sessionId, abort.signal)
      .then((loaded) => {
        if (abort.signal.aborted) return;
        setStatus(loaded);
        if (!loaded.isGit) setError(loaded.error || "当前目录不是 Git 仓库。");
      })
      .catch((loadError) => {
        if (!abort.signal.aborted) setError(describeError(loadError, "无法加载 Git 状态。"));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    // 本轮迭代的提示词清单：能拉到就用它当默认输入，拉不到（老服务端）就退回读 diff。
    void repository.loadContext(context.sessionId, { signal: abort.signal })
      .then((loaded) => {
        if (abort.signal.aborted) return;
        setIterationContext(loaded);
        setContextMode(loaded.mode);
      })
      .catch(() => {
        if (!abort.signal.aborted) setIterationContext(null);
      });
    return () => {
      abort.abort();
      generationAbort.current?.abort();
      generationAbort.current = null;
    };
  }, [controller.open, controller.revision, context?.sessionId, repository]);

  useEffect(() => {
    if (!controller.open || loading || !status || outcome) return;
    const frame = window.requestAnimationFrame(() => messageInput.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [controller.open, loading, outcome, status]);

  const selectedMeta = useMemo(() => quickCommitActionMeta(action), [action]);
  const busy = submitting || pushing;
  const canCommit = hasQuickCommitChanges(status) && !busy && !loading;
  const selectedEntryIds = useMemo<ReadonlySet<string>>(
    () => new Set(selectedOverride ?? iterationContext?.defaultEntryIds ?? []),
    [selectedOverride, iterationContext],
  );

  /** 传给服务端的选择：模式 + 本次算作已提交的条目（默认就是「上次提交以来」）。 */
  function contextSelection(): QuickCommitSelection | undefined {
    if (!iterationContext) return undefined;
    return { mode: contextMode, entryIds: [...selectedEntryIds] };
  }

  function changeContextMode(mode: QuickCommitContextMode): void {
    setContextMode(mode);
    if (!context) return;
    // 记住选择；失败不阻塞提交，下次打开回落到服务端默认。
    void repository.saveContextMode(context.sessionId, mode).catch(() => undefined);
  }

  function toggleEntry(id: string, checked: boolean): void {
    setSelectedOverride(() => {
      const next = new Set(selectedEntryIds);
      if (checked) next.add(id);
      else next.delete(id);
      return [...next];
    });
  }

  function selectEntries(scope: "pending" | "all" | "none"): void {
    if (!iterationContext) return;
    if (scope === "none") {
      setSelectedOverride([]);
      return;
    }
    if (scope === "all") {
      setSelectedOverride(iterationContext.entries.map((entry) => entry.id));
      return;
    }
    setSelectedOverride(null);
  }

  async function reloadStatus(sessionId: string): Promise<void> {
    try {
      const loaded = await loadStatusWithBadgeSync(sessionId);
      if (quickCommitStore.getSnapshot().context?.sessionId === sessionId) setStatus(loaded);
    } catch {
      // The operation already succeeded; a stale status panel is non-fatal.
    }
  }

  /** 提交后刷新一轮变更清单：刚提交的全被标记为「已提交」，默认勾选随之清空。 */
  async function reloadContext(sessionId: string): Promise<void> {
    try {
      const loaded = await repository.loadContext(sessionId);
      if (quickCommitStore.getSnapshot().context?.sessionId !== sessionId) return;
      setIterationContext(loaded);
      setSelectedOverride(null);
      setGeneratedFrom(null);
    } catch {
      // 提交已经成功，面板上留着旧清单比报错好。
    }
  }

  async function generateSuggestion(): Promise<void> {
    if (!context || generating || submitting) return;
    generationAbort.current?.abort();
    const abort = new AbortController();
    generationAbort.current = abort;
    setGenerating(true);
    setError("");
    try {
      const suggestion = await repository.generate(context.sessionId, {
        signal: abort.signal,
        selection: contextSelection(),
        includeDiff,
      });
      if (abort.signal.aborted) return;
      setForm((current) => ({
        message: current.message.trim() ? current.message : suggestion.message,
        tag: current.tagEdited ? current.tag : (suggestion.suggestedTag || current.tag),
        tagEdited: current.tagEdited,
      }));
      // 告诉用户这次是靠提示词总结的还是读了 diff：省 token 这件事要看得见。
      setGeneratedFrom({ source: suggestion.contextSource, count: suggestion.entryIds.length });
      if (suggestion.suggestedTag) setAction("commit-tag");
    } catch (generateError) {
      if (!abort.signal.aborted) setError(describeError(generateError, "AI 生成失败。"));
    } finally {
      if (!abort.signal.aborted) setGenerating(false);
      if (generationAbort.current === abort) generationAbort.current = null;
    }
  }

  async function submit(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    if (!context || !status || !canCommit || submitting || submitPhase === "pending" || submitPhase === "success") return;
    const operationSessionId = context.sessionId;
    const operationRevision = quickCommitStore.getSnapshot().revision;
    const ownsCurrentSurface = () =>
      quickCommitController.isCurrentLifecycle(operationRevision, operationSessionId);
    setSubmitting(true);
    setSubmitPhase("pending");
    setSubmitResult("");
    setResultNote("");
    setError("");
    setPushError("");
    try {
      const response = await repository.commit(
        operationSessionId,
        buildQuickCommitInput(form, action, includeSubmodule, contextSelection(), includeDiff, archiveRelatedTasks),
      );
      if (!response.ok) throw new Error("快捷提交失败。");
      const nextOutcome = buildQuickCommitOutcome(
        action,
        includeSubmodule,
        form,
        status,
        response,
      );
      const summary = commitSummary(nextOutcome);
      const hash = nextOutcome.commitHash ? nextOutcome.commitHash.slice(0, 7) : "";
      if (response.archivedTaskIds?.length || response.archivedSessionIds?.length) {
        notifyTasksChanged();
        quickCommitStore.getRuntime()?.onArchived?.();
      }
      const archivedParts = [
        response.archivedTaskIds?.length ? `${response.archivedTaskIds.length} 个关联任务` : "",
        response.archivedSessionIds?.length ? `${response.archivedSessionIds.length} 个无任务会话` : "",
      ].filter(Boolean);
      const archiveNote = archiveRelatedTasks
        ? `；${archivedParts.length ? `已归档 ${archivedParts.join("、")}` : "没有可归档的任务或会话"}`
        : "";
      if (!response.pushError) {
        void reloadStatus(operationSessionId);
        void reloadContext(operationSessionId);
        if (ownsCurrentSurface()) {
          setSubmitResult(hash ? `已提交 ${hash}` : "已提交");
          // 原来只有 toast 承载的细节（submodule 数、tag、是否推送、归档结果）改在页脚原位显示。
          setResultNote(`${summary}${selectedMeta.push ? "，已推送" : ""}${archiveNote}。`);
          setSubmitPhase("success");
          setSubmitting(false);
          // 归档失败是这次操作唯一的坏消息，弹层要关掉它，只能靠原位 alert 读完。
          if (response.archiveError) setError(`提交已完成，但归档任务与会话未全部完成：${response.archiveError}`);
        }
        await new Promise((resolve) => {
          window.setTimeout(resolve, response.archiveError ? MOTION_DWELL_FAILED_MS : MOTION_DWELL_SENT_MS);
        });
        if (ownsCurrentSurface()) quickCommitController.close();
        return;
      }
      if (ownsCurrentSurface()) {
        setOutcome(nextOutcome);
        setPushError(response.pushError);
        setSubmitResult("已提交，推送失败");
        setSubmitPhase("error");
        setResultNote(`${summary}${archiveNote}。`);
        if (response.archiveError) setError(`归档任务与会话未全部完成：${response.archiveError}`);
      }
      await Promise.all([
        reloadStatus(operationSessionId),
        reloadContext(operationSessionId),
      ]);
      await new Promise((resolve) => { window.setTimeout(resolve, MOTION_DWELL_FAILED_MS); });
      if (ownsCurrentSurface()) setSubmitPhase("idle");
    } catch (commitError) {
      const message = describeError(commitError, "快捷提交失败。");
      if (ownsCurrentSurface()) {
        setError(message);
        setSubmitResult("提交失败");
        setSubmitPhase("error");
      }
      await new Promise((resolve) => { window.setTimeout(resolve, MOTION_DWELL_FAILED_MS); });
      if (ownsCurrentSurface()) setSubmitPhase("idle");
    } finally {
      if (ownsCurrentSurface()) setSubmitting(false);
    }
  }

  async function pushAndClose(): Promise<void> {
    if (!context || !outcome || pushing) return;
    const operationSessionId = context.sessionId;
    const operationRevision = quickCommitStore.getSnapshot().revision;
    const ownsCurrentSurface = () =>
      quickCommitController.isCurrentLifecycle(operationRevision, operationSessionId);
    setPushing(true);
    setPushError("");
    try {
      const response = await repository.push(operationSessionId, {
        pushCommits: true,
        pushTags: !!outcome.tagName,
        submodule: outcome.includeSubmodule,
        tag: outcome.tagName,
      });
      if (!response.ok || response.error) {
        if (ownsCurrentSurface()) setPushError(response.error || "推送失败。");
        return;
      }
      const pushed = [response.pushedCommits ? "提交" : "", response.pushedTags ? "标签" : ""]
        .filter(Boolean)
        .join(" 和 ") || "（无内容）";
      void reloadStatus(operationSessionId);
      if (ownsCurrentSurface()) {
        setResultNote(`已推送 ${pushed}。`);
        setOutcome({ ...outcome, pushed: true });
      }
      await new Promise((resolve) => { window.setTimeout(resolve, MOTION_DWELL_SENT_MS); });
      if (ownsCurrentSurface()) quickCommitController.close();
    } catch (pushFailure) {
      if (ownsCurrentSurface()) setPushError(describeError(pushFailure, "推送失败。"));
    } finally {
      setPushing(false);
    }
  }

  function submitShortcut(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    void submit();
  }

  return (
    <WandDialogSurface
      open={controller.open}
      onOpenChange={(open) => { if (!open) quickCommitController.close(); }}
      title="快捷提交"
      description={statusDescription(status)}
      className="wand-task-library-dialog wand-quick-library-dialog"
      closeLabel="关闭快捷提交"
      testId="quick-commit-dialog"
    >
      {loading ? (
        <Spin tip="正在加载 Git 状态…"><div style={{ minHeight: 100 }} role="status">正在加载 Git 状态…</div></Spin>
      ) : outcome ? (
        <Flex vertical gap={16} component="section" aria-label="提交结果">
          <ResultPair label="Commit"
            before={<CommitValue hash={outcome.oldCommitHash} subject={outcome.oldCommitSubject} empty="无"/>}
            after={<CommitValue hash={outcome.commitHash} subject={outcome.commitMessage} empty="无"/>}/>
          <ResultPair label="Tag"
            before={outcome.oldTag ? <Typography.Text code>{outcome.oldTag}</Typography.Text> : <Typography.Text type="secondary">无 tag</Typography.Text>}
            after={outcome.tagName ? <Typography.Text code>{outcome.tagName}</Typography.Text> : <Typography.Text type="secondary">未打 tag</Typography.Text>}/>
          {outcome.submoduleCount > 0 ? <Typography.Text>已提交 {outcome.submoduleCount} 个 submodule。</Typography.Text> : null}
          {resultNote ? <Typography.Text>{resultNote}</Typography.Text> : null}
          {outcome.pushError || pushError ? <Alert type="error" showIcon role="alert" title={pushError || outcome.pushError}/> : null}
          {error ? <Alert type="error" showIcon role="alert" title={error}/> : null}
          <Flex justify="flex-end" gap={8} align="center">
            <WandButton kind="ghost" onClick={() => quickCommitController.close()}>关闭</WandButton>
            {outcome.pushed ? <Tag color="success">已推送</Tag> : <WandButton kind="primary" disabled={pushing} onClick={() => void pushAndClose()}>{pushing ? "推送中…" : "推送并关闭"}</WandButton>}
          </Flex>
        </Flex>
      ) : status ? (
        <TaskForm noValidate aria-busy={busy} onSubmit={(event) => void submit(event)}>
          <Flex vertical gap={16}>
            <CommitWorkspaceLens status={status}/>
            <ChangedFiles status={status}/>
            {iterationContext ? <IterationContextPanel
              context={iterationContext} mode={contextMode} selectedIds={selectedEntryIds}
              includeDiff={includeDiff} disabled={busy} onModeChange={changeContextMode}
              onToggleEntry={toggleEntry} onSelectAll={selectEntries} onIncludeDiffChange={setIncludeDiff}/> : null}
            <Card size="small" title={<span id="wand-quick-editor-title">提交信息</span>} aria-labelledby="wand-quick-editor-title"
              extra={<WandButton kind="ghost" size="small" disabled={generating || submitting || !hasQuickCommitChanges(status)} title="AI 生成 commit message 与 tag" onClick={() => void generateSuggestion()}>{generating ? "生成中…" : "✦ AI"}</WandButton>}>
              <Form.Item htmlFor="wand-quick-message" label="新的 Commit 信息">
                <TaskTextArea className="resize-none" id="wand-quick-message" ref={messageInput}
                  data-wand-autofocus="" rows={3} value={form.message} disabled={submitting}
                  placeholder="留空则自动生成" onChange={(event) => setForm({ ...form, message: event.currentTarget.value })}
                  onKeyDown={submitShortcut}/>
              </Form.Item>
              {generatedFrom ? <Typography.Paragraph type="secondary">{generatedFrom.source === "iteration"
                ? `已依据 ${generatedFrom.count} 条迭代提示词生成，没有读取代码。` : "已依据完整 diff 生成。"}</Typography.Paragraph> : null}
              <Form.Item htmlFor="wand-quick-tag" label="Tag（可选）" style={{ marginBottom: 0 }}>
                <WandInput id="wand-quick-tag" type="text" value={form.tag} disabled={submitting}
                  placeholder="选择 Tag 动作时，留空则自动生成" autoComplete="off" spellCheck={false}
                  onChange={(event) => setForm({ ...form, tag: event.currentTarget.value, tagEdited: true })}/>
              </Form.Item>
            </Card>
            <Card size="small" title="执行动作">
              <Flex vertical gap={16}>
                <Radio.Group className="wand-quick-action-grid" aria-label="执行动作" name="wand-quick-action" value={action} disabled={!hasQuickCommitChanges(status) || busy} onChange={(event) => setAction(event.target.value)}>
                  <Space wrap>{QUICK_COMMIT_ACTIONS.map((item) => <Radio key={item.action} value={item.action}>{item.label}</Radio>)}</Space>
                </Radio.Group>
                {status.hasSubmodule ? <Flex justify="space-between" align="center" gap={12}>
                  <Flex vertical><Typography.Text strong>包含 Submodule</Typography.Text><Typography.Text type="secondary">递归执行 commit、tag 和 push。</Typography.Text></Flex>
                  <WandSwitch id="wand-quick-submodule" checked={includeSubmodule} disabled={busy} ariaLabel="包含 Submodule" onCheckedChange={setIncludeSubmodule}/>
                </Flex> : null}
                <Flex justify="space-between" align="center" gap={12}>
                  <Flex vertical><Typography.Text strong>归档任务与会话</Typography.Text><Typography.Text type="secondary">提交成功后，归档当前任务及选中的已完成任务，并整理本项目全部无任务会话。保留历史与正在运行的会话。</Typography.Text></Flex>
                  <WandSwitch id="wand-quick-archive-tasks" checked={archiveRelatedTasks} disabled={busy || !hasQuickCommitChanges(status)} ariaLabel="提交后归档任务与会话" onCheckedChange={setArchiveRelatedTasks}/>
                </Flex>
              </Flex>
            </Card>
            {error ? <Alert type="error" showIcon role="alert" title={error}/> : null}
            <Flex component="footer" justify="space-between" gap={12} align="center" wrap className="wand-dialog-sticky-actions">
              <Typography.Text type="secondary">{resultNote || (hasQuickCommitChanges(status) ? "⌘/Ctrl + Enter 快速执行" : "工作区干净，无可提交改动")}</Typography.Text>
              <Space>
                <WandButton kind="ghost" onClick={() => quickCommitController.close()}>取消</WandButton>
                <WandButton kind="primary" type="submit" aria-live="polite" disabled={!canCommit || submitting || submitPhase === "pending" || submitPhase === "success"}>
                  {submitPhase === "pending" ? (form.message.trim() ? "执行中…" : "AI 生成 + 提交中…")
                    : submitPhase === "success" || submitPhase === "error" ? submitResult : selectedMeta.verb}
                </WandButton>
              </Space>
            </Flex>
          </Flex>
        </TaskForm>
      ) : error ? <Alert type="error" showIcon role="alert" title={error}/>
        : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有读到 Git 状态，重新打开快捷提交即可再试一次。"/>}
    </WandDialogSurface>
  );
}
