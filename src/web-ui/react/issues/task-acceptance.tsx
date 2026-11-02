import * as React from "react";
import { Alert, Flex, Typography } from "antd";
import { TaskTextArea } from "./task-form";
import { WandButton } from "../ui";
import type { WandTaskListed, TaskWorkflowAction } from "./task-board-repository";
import { taskAiVerified, taskHumanAccepted, taskWorkflowStage, type TaskAcceptance } from "../../../task-types";

const drafts = new Map<string, { evidence: string; blocker: string }>();
const workflowRequests = new Map<string, string>();
export function TaskAcceptanceEditor({ task, children, busy, onSave, onWorkflow }: {
  task: WandTaskListed; children: WandTaskListed[]; busy: boolean;
  onSave(value: TaskAcceptance): Promise<boolean>;
  onWorkflow(action: TaskWorkflowAction, value: { evidence: string; blocker: string; requestId: string; expectedUpdatedAt: string }): Promise<boolean>;
}): React.ReactElement {
  const initial = () => drafts.get(task.id) ?? { evidence: task.acceptance?.evidence ?? task.verification?.evidence ?? "", blocker: task.acceptance?.blocker ?? task.verification?.blocker ?? "" };
  const [draft, setDraft] = React.useState(initial);
  const [feedback, setFeedback] = React.useState("");
  const [saving, setSaving] = React.useState<"save" | TaskWorkflowAction | null>(null);
  const [receipt, setReceipt] = React.useState<{ action: "save" | TaskWorkflowAction; accepted: boolean } | null>(null);
  React.useEffect(() => { if (!drafts.has(task.id)) setDraft(initial()); }, [task.id, task.updatedAt]);
  const edit = (value: Partial<typeof draft>): void => {
    const next = { ...draft, ...value }; drafts.set(task.id, next);
    if (drafts.size > 100) drafts.delete(drafts.keys().next().value!);
    setDraft(next); setFeedback(""); setReceipt(null);
  };
  const save = async (): Promise<void> => {
    const submitted = draft; setSaving("save"); setReceipt(null);
    try {
      if (await onSave({ ...submitted, acceptedAt: null })) {
        if (drafts.get(task.id) === submitted) drafts.delete(task.id);
        setReceipt({ action: "save", accepted: true });
        setFeedback("交付与缺口已保存；修改交付后需重新验收");
      } else { setReceipt({ action: "save", accepted: false }); setFeedback("未保存，输入已保留；请核对任务后重试"); }
    } catch { setReceipt({ action: "save", accepted: false }); setFeedback("保存未确认，输入已保留，请先刷新核对"); }
    finally { setSaving(null); }
  };
  const act = async (action: TaskWorkflowAction): Promise<void> => {
    const submitted = draft, expectedUpdatedAt = task.updatedAt;
    const key = JSON.stringify([task.id, expectedUpdatedAt, action, submitted]);
    const requestId = workflowRequests.get(key) ?? crypto.randomUUID();
    workflowRequests.set(key, requestId);
    if (workflowRequests.size > 100) workflowRequests.delete(workflowRequests.keys().next().value!);
    setSaving(action); setReceipt(null);
    try {
      if (await onWorkflow(action, { ...submitted, requestId, expectedUpdatedAt })) {
        workflowRequests.delete(key);
        setReceipt({ action, accepted: true });
        if (drafts.get(task.id) === submitted) drafts.delete(task.id);
        setFeedback(action === "accept" ? "已确认并归档" : action === "pass" ? "AI 验收已通过，等待人工确认" : action === "submit" ? "已提交 AI 验收；模型派发仍需显式授权，不会自动增加执行或费用" : "已退回执行，缺口与历史已保留");
      } else { setReceipt({ action, accepted: false }); setFeedback("操作未确认，输入与请求标识已保留；请先刷新核对，不要重复派发"); }
    } catch (cause) { setReceipt({ action, accepted: false }); setFeedback(cause instanceof Error ? cause.message : "操作未确认，输入与请求标识已保留；请先刷新核对"); }
    finally { setSaving(null); }
  };
  const buttonTitle = (action: "save" | TaskWorkflowAction, fallback: string): string => {
    if (saving === action) return "提交中…";
    if (receipt?.action !== action) return fallback;
    if (!receipt.accepted) return "未确认，请核对";
    return ({ progress: "进展已记录", save: "交付已保存", submit: "已提交 AI 验收", pass: "已进入待归档", fail: "已退回执行", accept: "已确认并归档", return: "已退回执行" })[action];
  };
  const status = taskWorkflowStage(task.status), gaps = children.filter(child => !taskAiVerified(child));
  const proof = Boolean(draft.evidence.trim()), blocked = Boolean(draft.blocker.trim());
  const actions: { action: TaskWorkflowAction; label: string; enabled: boolean }[] = [
    { action: "submit", label: "提交 AI 验收", enabled: status === "doing" && proof && !blocked },
    { action: "pass", label: "记录 AI 验收通过", enabled: status === "review" && proof && !blocked && children.every(child => ["review", "ready", "archived"].includes(child.status) && !child.acceptance?.blocker?.trim()) },
    { action: "fail", label: "验收失败并退回", enabled: status === "review" && blocked },
    { action: "accept", label: "确认并归档", enabled: status === "ready" && taskAiVerified(task) && proof && !blocked && !gaps.length },
    { action: "return", label: "退回执行", enabled: status === "ready" && blocked },
  ];
  return <Flex vertical gap="small" aria-label="交付与验收">
    <Typography.Text type="secondary">执行结束不代表交付；AI 验收通过后，仍需你明确确认并归档。这里只记录真实结论，不会启动模型。</Typography.Text>
    <TaskTextArea aria-label="交付证据与产物" placeholder="实际产物路径、版本、验证命令与结果，未验证项不能写成通过" value={draft.evidence} onChange={event => edit({ evidence: event.target.value })} autoSize={{ minRows: 3 }} maxLength={16000} disabled={busy || Boolean(saving) || status === "archived"}/>
    <TaskTextArea aria-label="验收阻塞" placeholder="无阻塞时留空；不通过、无法验证或人工退回时写明原因" value={draft.blocker} onChange={event => edit({ blocker: event.target.value })} autoSize={{ minRows: 2 }} maxLength={4000} disabled={busy || Boolean(saving) || status === "archived"}/>
    {status !== "archived" && !actions.some(entry => entry.enabled) && <Typography.Text type="secondary" className="task-acceptance-hint">{
      status === "doing" ? (blocked ? "有未解除的阻塞，清空阻塞并填写证据后才能提交 AI 验收。" : "填写交付证据后即可提交 AI 验收。")
      : status === "review" ? (blocked ? "" : "AI 验收通过需要证据且没有阻塞；未通过时在阻塞里写明原因。")
      : status === "ready" ? "确认归档需要当前交付的 AI 通过记录与证据；不认可时写明原因退回。" : "此阶段还没有可执行的验收动作。"}</Typography.Text>}
    <Flex gap="small" wrap>
      <WandButton disabled={busy || Boolean(saving) || status === "archived"} loading={saving === "save"} onClick={() => void save()}>{buttonTitle("save", "保存交付与缺口")}</WandButton>
      {/* 只列当前阶段能做的动作；不可用的不再以禁用按钮堆在这里。 */}
      {actions.filter(entry => entry.enabled || saving === entry.action || receipt?.action === entry.action).map(entry => <WandButton key={entry.action} kind={entry.action === "accept" || entry.action === "submit" || entry.action === "pass" ? "primary" : "secondary"} disabled={busy || Boolean(saving) || !entry.enabled} loading={saving === entry.action} onClick={() => void act(entry.action)}>{buttonTitle(entry.action, entry.label)}</WandButton>)}
    </Flex>
    {task.legacyReview && <Alert type="warning" showIcon title="历史验收记录待核对" description="旧状态没有可信 AI 通过记录；原证据与历史保留，请针对当前交付重新核验。"/>}
    {gaps.length > 0 && <Alert type="warning" showIcon title={`${gaps.length} 个子任务尚未通过当前交付验收`} description={gaps.map(child => child.identifier).join("、")}/>}
    {status === "archived" && <Alert type={taskHumanAccepted(task) ? "success" : "info"} title={taskHumanAccepted(task) ? "人工已确认 · 已归档" : "历史归档 · 不代表本轮验收通过"}/>}
    <Typography.Text type="secondary" role="status">{feedback || "工作流按真实回执流转；版本冲突与未知结果不会自动重试。"}</Typography.Text>
  </Flex>;
}
