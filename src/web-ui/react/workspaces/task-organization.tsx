import * as React from "react";
import { Typography, type MenuProps } from "antd";
import { TASK_ORGANIZE_OPTIONS, type TaskOrganizeMode, type TaskOrganizeTarget } from "../../../task-organize-contract";
import type { ConversationOrganizationPreview, ConversationOrganizationJob } from "../../../conversation-organize-contract";
import { httpWorkspacesRepository } from "./repository";
import { workspacesStore } from "./controller";
import { openSessionWithOwningTask } from "./session-open";
import { taskBoardController } from "../issues/task-board-controller";
import { describeConversationOrganizationOutcome } from "./sidebar-manage";
import { describeError } from "../errors";
import { WandButton, WandDropdownMenu, WandDropdownMenuTrigger, WandDropdownMenuContent, WandDropdownMenuItem, WandIcon } from "../ui";
import { MOTION_DWELL_SENT_MS, MOTION_DWELL_FAILED_MS } from "../ui/motion-tokens";

type OrganizationTarget = TaskOrganizeTarget | { kind: "selection"; taskIds: readonly string[]; sessionIds: readonly string[] };

function openLog(id: string): void {
  taskBoardController.close();
  void openSessionWithOwningTask(id, sessionId => { workspacesStore.getRuntime()?.selectSession(sessionId); });
}
function previewText(preview: ConversationOrganizationPreview): string {
  return `将整理 ${preview.sessionCount} 个工作会话，正文 ${preview.contentCharacters} 字符，预计 ${preview.estimatedModelRequests} 个系统模型请求；使用初二当前配置，失败可能按已配候选降级。跳过 ${preview.manualSessionCount} 个人工任务中的会话，另排除 ${preview.skippedSessionCount} 个归档/私聊/系统记录或无正文会话。${preview.unchanged ? "内容与归属未变，可保持现状或明确重新分析。" : "确认后可自动创建/复用任务并移动会话，不执行会话中的工作。"}`;
}

export function useTaskOrganization(target: OrganizationTarget, onChanged?: () => Promise<void>) {
  const [phase, setPhase] = React.useState<"idle" | "loading" | "prepared" | "done" | "error" | "result">("idle");
  const [feedback, setFeedback] = React.useState("");
  const [preview, setPreview] = React.useState<ConversationOrganizationPreview | null>(null);
  const [job, setJob] = React.useState<ConversationOrganizationJob | null>(null);
  const pending = React.useRef(false), revision = React.useRef(0);
  const submittedToken = React.useRef<string | null>(null);
  const mounted = React.useRef(true), polling = React.useRef(new AbortController());
  React.useEffect(() => { mounted.current = true; const controller = new AbortController(); polling.current = controller;
    return () => { mounted.current = false; controller.abort(); }; }, []);
  const targetKey = JSON.stringify(target);
  React.useEffect(() => {
    revision.current++;
    setPreview(null);
    const unresolved = Boolean(submittedToken.current) || job?.status === "running";
    setFeedback(pending.current || unresolved ? "前一次范围仍在后台整理或等待回执；请查询原作业，切换目录不会重发。" : "");
    setPhase(pending.current ? "loading" : unresolved ? "error" : "idle");
    return () => { revision.current++; };
  }, [targetKey]);
  React.useEffect(() => {
    if (phase !== "done" && phase !== "error") return;
    const timer = setTimeout(() => setPhase("result"), phase === "error" ? MOTION_DWELL_FAILED_MS : MOTION_DWELL_SENT_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  const run = async (mode: TaskOrganizeMode): Promise<void> => {
    if (pending.current || submittedToken.current || job?.status === "running") return;
    pending.current = true;
    const started = revision.current;
    setPhase("loading"); setFeedback("正在读取当前范围的会话正文并估算处理量…"); setPreview(null); setJob(null);
    try {
      const next = await httpWorkspacesRepository.prepareConversationOrganization(target.kind === "selection" ? { taskIds: target.taskIds, sessionIds: target.sessionIds, mode } : { target, mode });
      if (started !== revision.current) return;
      if (next.activeJobId) {
        setFeedback("本范围已有作业，正在查询原作业；不会重复发起模型请求。完成后可重新预览新增内容。");
        const active = await httpWorkspacesRepository.conversationOrganizationJob(next.activeJobId);
        await watch(active, started);return;
      }
      if (!next.sessionCount) {
        setFeedback(`没有符合范围且有正文的工作会话；跳过 ${next.manualSessionCount} 个人工任务会话、${next.skippedSessionCount} 个归档/自动化/私聊/系统记录或无正文会话。`);
        setPhase("done");return;
      }
      setPreview(next); setFeedback(previewText(next)); setPhase("prepared");
    } catch (cause) {
      if (started === revision.current) { setFeedback(describeError(cause, "无法预览会话自动归类范围。")); setPhase("error"); }
    } finally {
      pending.current = false;
      if (mounted.current && started !== revision.current) {
        setPhase(submittedToken.current ? "error" : "idle");
      }
    }
  };
  const watch = async (initial: ConversationOrganizationJob, started: number): Promise<void> => {
    const finished = await httpWorkspacesRepository.watchConversationOrganization(initial, progress => {
      if (started !== revision.current) return;
      setJob(progress);
      setFeedback(`${progress.stage}；新建 ${progress.result.createdTasks.length} 个任务，归入 ${progress.result.movedSessions.length} 个会话。`);
    }, polling.current.signal);
    submittedToken.current = null;
    if (!mounted.current) return;
    await onChanged?.();
    if (started !== revision.current) return;
    setJob(finished);
    const outcome = describeConversationOrganizationOutcome(finished.result);
    setFeedback([outcome.label, outcome.reason].filter(Boolean).join("；"));
    setPhase(finished.status === "failed" || finished.status === "interrupted" ? "error" : "done");
  };
  const confirm = async (): Promise<void> => {
    if (!preview || pending.current || submittedToken.current || job?.status === "running") return;
    submittedToken.current = preview.token;
    pending.current = true; const started = revision.current; setPhase("loading");
    try {
      const accepted = await httpWorkspacesRepository.startConversationOrganization(preview.token, preview.unchanged);
      if (started === revision.current) { setJob(accepted); setPreview(null); }
      await watch(accepted, started);
    } catch (cause) {
      if (mounted.current && started === revision.current) { setFeedback(describeError(cause, "后台归类回执未确认；可查询原作业，不要重复新建请求。")); setPhase("error"); }
    } finally {
      pending.current = false;
      if (mounted.current && started !== revision.current) {
        if (submittedToken.current) { setPhase("error"); setFeedback("前一次范围回执未确认，请查询原确认请求；不会重复提交。"); }
        else { setJob(null); setPhase("idle"); setFeedback("前一次范围已结束，可以重新选择当前范围。"); }
      }
    }
  };
  const rewatch = async (): Promise<void> => {
    if ((!job && !submittedToken.current) || pending.current) return;
    pending.current = true; const started = revision.current; setPhase("loading");
    try {
      const original = job ? await httpWorkspacesRepository.conversationOrganizationJob(job.id)
        : await httpWorkspacesRepository.conversationOrganizationJobByToken(submittedToken.current!);
      await watch(original, started);
    }
    catch (cause) { if (mounted.current) { setFeedback(describeError(cause, "暂时无法查询原作业。")); setPhase("error"); } }
    finally { pending.current = false; }
  };
  const cancel = async (): Promise<void> => {
    if (!job || job.status !== "running") return;
    try { await httpWorkspacesRepository.cancelConversationOrganization(job.id); }
    catch { setFeedback("取消请求的回执未知，仍在查询原作业；不会自动重发或删除已归类结果。"); }
  };
  const busy = phase === "loading";
  const unresolved = Boolean(submittedToken.current) || job?.status === "running";
  const scopeDisabled = busy || unresolved;
  const label = busy ? "正在整理会话" : phase === "prepared" ? "确认会话范围" : phase === "done" ? "已完成" : phase === "error" ? "归类未完成" : phase === "result" ? "会话归类结果" : "会话自动归类";
  const items: MenuProps["items"] = TASK_ORGANIZE_OPTIONS.map(option => ({ key: `organize-${option.value}`, label: option.label, title: option.hint, disabled: scopeDisabled }));
  if (preview && !unresolved) items.push({ key: "organize-confirm", label: preview.unchanged ? "重新分析（优先复用已有任务）" : `确认整理 ${preview.sessionCount} 个会话`, disabled: busy });
  if (job?.status === "running") items.push({ key: "organize-cancel", label: "取消后续归类（保留已完成部分）" });
  if (unresolved && !busy) items.push({ key: "organize-watch", label: job ? "继续查询本次作业" : "查询原确认请求" });
  if (job?.logSessionId) items.push({ key: "organize-log", label: "查看初二的本次归类日志" });
  if (feedback) items.push({ key: "organize-result", disabled: true, label: <TaskOrganizationFeedback text={feedback}/> });
  const handleMenuKey = (key: string): boolean => {
    if (key === "organize-auto" || key === "organize-all") void run(key === "organize-all" ? "all" : "auto");
    else if (key === "organize-confirm") void confirm();
    else if (key === "organize-cancel") void cancel();
    else if (key === "organize-watch") void rewatch();
    else if (key === "organize-log" && job?.logSessionId) openLog(job.logSessionId);
    else return false;
    return true;
  };
  return { run, confirm, cancel, handleMenuKey, busy, scopeDisabled, unresolved, label, feedback, status: feedback, preview, job, items };
}
function TaskOrganizationFeedback({ text }: { text: string }) {
  return <Typography.Text role="status" style={{ display: "block", whiteSpace: "normal", maxWidth: "min(340px, calc(100vw - 48px))" }}>{text}</Typography.Text>;
}
export function TaskOrganizeButton({ target, onChanged }: { target: OrganizationTarget; onChanged?: () => Promise<void> }) {
  const action = useTaskOrganization(target, onChanged);
  return <WandDropdownMenu closeOnSelect={false}>
    <WandDropdownMenuTrigger render={<WandButton aria-label="会话自动归类" aria-busy={action.busy} title={action.feedback || "按实际会话正文归组，自动创建或复用合适任务；默认不挪人工任务中的会话"} style={{ width: 144 }}>
      <WandIcon name="folder" size={16}/><span aria-live="polite">{action.label}</span>
    </WandButton>}/>
    <WandDropdownMenuContent align="end">
      {TASK_ORGANIZE_OPTIONS.map(option => <WandDropdownMenuItem key={option.value} title={option.hint} disabled={action.scopeDisabled} onSelect={() => void action.run(option.value)}>{option.label}</WandDropdownMenuItem>)}
      {action.preview && !action.unresolved && <WandDropdownMenuItem disabled={action.busy} onSelect={() => void action.confirm()}>{action.preview.unchanged ? "重新分析（优先复用已有任务）" : `确认整理 ${action.preview.sessionCount} 个会话`}</WandDropdownMenuItem>}
      {action.job?.status === "running" && <WandDropdownMenuItem onSelect={() => void action.cancel()}>取消后续归类（保留已完成部分）</WandDropdownMenuItem>}
      {action.unresolved && !action.busy && <WandDropdownMenuItem onSelect={() => action.handleMenuKey("organize-watch")}>{action.job ? "继续查询本次作业" : "查询原确认请求"}</WandDropdownMenuItem>}
      {action.job?.logSessionId && <WandDropdownMenuItem onSelect={() => action.handleMenuKey("organize-log")}>查看初二的本次归类日志</WandDropdownMenuItem>}
      {action.status && <WandDropdownMenuItem disabled><TaskOrganizationFeedback text={action.status}/></WandDropdownMenuItem>}
    </WandDropdownMenuContent>
  </WandDropdownMenu>;
}
