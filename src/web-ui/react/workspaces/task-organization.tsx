import * as React from "react";
import type { MenuProps } from "antd";
import { TASK_ORGANIZE_OPTIONS, type TaskOrganizeMode, type TaskOrganizeTarget } from "../../../task-organize-contract";
import { httpWorkspacesRepository } from "./repository";
import { describeOrganizeOutcome } from "./sidebar-manage";
import { describeError } from "../errors";
import { WandButton, WandDropdownMenu, WandDropdownMenuTrigger, WandDropdownMenuContent, WandDropdownMenuItem, WandIcon } from "../ui";
import { MOTION_DWELL_SENT_MS, MOTION_DWELL_FAILED_MS } from "../ui/motion-tokens";

export function useTaskOrganization(target: TaskOrganizeTarget, onChanged?: () => Promise<void>) {
  const [phase, setPhase] = React.useState<"idle" | "loading" | "done" | "error" | "result">("idle");
  const [feedback, setFeedback] = React.useState("");
  const pending = React.useRef(false);
  const revision = React.useRef(0);
  const targetKey = JSON.stringify(target);
  React.useEffect(() => {
    revision.current++;
    setPhase("idle"); setFeedback("");
    return () => { revision.current++; };
  }, [targetKey]);
  React.useEffect(() => {
    if (phase !== "done" && phase !== "error") return;
    const timer = setTimeout(() => setPhase("result"), phase === "error" ? MOTION_DWELL_FAILED_MS : MOTION_DWELL_SENT_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  const run = async (mode: TaskOrganizeMode): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    const started = revision.current;
    setPhase("loading"); setFeedback("");
    try {
      const result = await httpWorkspacesRepository.organizeTarget(target, mode);
      await onChanged?.();
      if (started !== revision.current) return;
      const outcome = describeOrganizeOutcome(result);
      setFeedback([outcome.label, outcome.reason].filter(Boolean).join("；"));
      setPhase("done");
    } catch (cause) {
      if (started !== revision.current) return;
      setFeedback(describeError(cause, "任务归类失败，请重试。")); setPhase("error");
    } finally { pending.current = false; }
  };
  const busy = phase === "loading";
  const label = phase === "loading" ? "正在归类" : phase === "done" ? "已完成" : phase === "error" ? "归类失败" : phase === "result" ? "查看结果" : "任务归类";
  const items: MenuProps["items"] = TASK_ORGANIZE_OPTIONS.map(option => ({
    key: `organize-${option.value}`, label: option.label, title: option.hint, disabled: busy,
  }));
  if (feedback) items.push({ key: "organize-result", disabled: true, label: <span role="status">{feedback}</span> });
  return { run, busy, label, feedback, items };
}

/** Native dropdown, same fixed trigger throughout loading/completion/result. */
export function TaskOrganizeButton({ target, onChanged }: { target: TaskOrganizeTarget; onChanged?: () => Promise<void> }) {
  const action = useTaskOrganization(target, onChanged);
  return <WandDropdownMenu>
    <WandDropdownMenuTrigger render={<WandButton disabled={action.busy} aria-label="任务归类" aria-busy={action.busy} title={action.feedback || "按会话标题内容归类；默认仅系统自动标题任务"} style={{ width: 116 }}>
      <WandIcon name="folder" size={16}/><span aria-live="polite">{action.label}</span>
    </WandButton>}/>
    <WandDropdownMenuContent align="end">
      {TASK_ORGANIZE_OPTIONS.map(option => <WandDropdownMenuItem key={option.value} title={option.hint} disabled={action.busy} onSelect={() => void action.run(option.value)}>{option.label}</WandDropdownMenuItem>)}
      {action.feedback && <WandDropdownMenuItem disabled><span role="status">{action.feedback}</span></WandDropdownMenuItem>}
    </WandDropdownMenuContent>
  </WandDropdownMenu>;
}
