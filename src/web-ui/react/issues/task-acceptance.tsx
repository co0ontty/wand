import * as React from "react";
import { Alert, Flex, Typography } from "antd";
import { TaskTextArea } from "./task-form";
import { WandButton } from "../ui";
import type { WandTaskListed } from "./task-board-repository";
import type { TaskAcceptance } from "../../../task-types";

// In-memory drafts survive leaving the detail view; never persist delivery claims implicitly.
const drafts = new Map<string, { evidence: string; blocker: string }>();

export function TaskAcceptanceEditor({ task, children, busy, onSave }: {
  task: WandTaskListed; children: WandTaskListed[]; busy: boolean; onSave(value: TaskAcceptance): Promise<boolean>;
}): React.ReactElement {
  const [draft, setDraft] = React.useState(() => drafts.get(task.id) ?? { evidence: task.acceptance?.evidence ?? "", blocker: task.acceptance?.blocker ?? "" });
  const [feedback, setFeedback] = React.useState("");
  const [saving, setSaving] = React.useState<"save" | "accept" | null>(null);
  React.useEffect(() => {
    if (!drafts.has(task.id)) setDraft({ evidence: task.acceptance?.evidence ?? "", blocker: task.acceptance?.blocker ?? "" });
  }, [task.id, task.acceptance?.evidence, task.acceptance?.blocker]);
  const edit = (value: Partial<typeof draft>): void => {
    const next = { ...draft, ...value };
    drafts.set(task.id, next);
    if (drafts.size > 100) drafts.delete(drafts.keys().next().value!);
    setDraft(next); setFeedback("");
  };
  const save = async (accepted: boolean): Promise<void> => {
    const submitted = draft;
    setSaving(accepted ? "accept" : "save");
    try {
      if (await onSave({ ...submitted, acceptedAt: accepted ? new Date().toISOString() : null })) {
        if (drafts.get(task.id) === submitted) drafts.delete(task.id);
        setFeedback(accepted ? "验收已确认" : "交付与缺口已保存");
      } else setFeedback("未保存，请核对后重试");
    } catch { setFeedback("未保存，输入已保留"); }
    finally { setSaving(null); }
  };
  const gaps = children.filter(child => !child.acceptance?.acceptedAt);
  const accepted = Boolean(task.acceptance?.acceptedAt);
  return <Flex vertical gap="small" aria-label="交付与验收">
    <Typography.Title level={5}>交付与验收</Typography.Title>
    <Typography.Text type="secondary">会话结束、失败或归档均不代表验收通过。负责人统一汇总各会话证据；交付目标与验收标准见任务描述。</Typography.Text>
    <TaskTextArea aria-label="交付证据与产物" placeholder="按会话记录已采纳的结果、产物路径和验证证据；未采纳结果注明原因" value={draft.evidence} onChange={event => edit({ evidence: event.target.value })} autoSize={{ minRows: 3 }} maxLength={16000} disabled={busy || Boolean(saving)}/>
    <TaskTextArea aria-label="验收阻塞" placeholder="等待信息／授权／部署／验收：写明具体原因与下一步；无阻塞时留空" value={draft.blocker} onChange={event => edit({ blocker: event.target.value })} autoSize={{ minRows: 2 }} maxLength={4000} disabled={busy || Boolean(saving)}/>
    {gaps.length > 0 && <Alert type="warning" showIcon title={`${gaps.length} 个子任务尚未验收通过`} description={gaps.map(child => child.identifier).join("、")}/>}
    {children.length > 0 && !gaps.length && !accepted && <Alert type="info" title="子任务均已验收，主目标仍待整体验收"/>}
    {accepted && <Alert type="success" title="验收通过 · 已完成" description="归档与正式发布仍是独立操作；修改交付可保存并重新验收。"/>}
    <Flex gap="small" wrap>
      <WandButton style={{ minWidth: 160 }} disabled={busy || Boolean(saving)} loading={saving === "save"} onClick={() => void save(false)}>{saving === "save" ? "保存中" : accepted ? "保存并重新验收" : feedback || "保存交付与缺口"}</WandButton>
      <WandButton style={{ minWidth: 160 }} kind="primary" loading={saving === "accept"} disabled={busy || Boolean(saving) || !draft.evidence.trim() || Boolean(draft.blocker.trim()) || gaps.length > 0 || accepted} onClick={() => void save(true)}>确认验收通过</WandButton>
    </Flex>
  </Flex>;
}
