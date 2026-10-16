import * as React from "react";
import { Alert, Spin } from "antd";
import type { ScheduledTaskRunFactView, ScheduledTaskRunView, ScheduledTaskSummary } from "../../../scheduled-task-types.js";
import { WandButton } from "../ui/button";
import { WandIcon } from "../ui/icons";
import { ExecutionHistory } from "./execution-history";
import { useScheduledPresentation } from "./presentation-context";
import { scheduledTasksRepository } from "./repository";

/** A selected historical occurrence is fetched by exact task+run identity.
 * While loading, never substitute the current plan prompt for the old snapshot. */
export function ScheduledTaskDetails({ task, active, focusRun, onEdit, onOpenSession }: {
  task: ScheduledTaskSummary; active: boolean; focusRun?: ScheduledTaskRunFactView;
  onEdit(): void; onOpenSession(id: string): void;
}) {
  const { timeZone } = useScheduledPresentation();
  const [snapshot, setSnapshot] = React.useState<{ run: ScheduledTaskRunView; signature: string } | null>(null);
  const [error, setError] = React.useState("");
  const [retry, setRetry] = React.useState(0);
  const signature = focusRun ? JSON.stringify([focusRun.id, focusRun.executionStatus, focusRun.executionFinishedAt, focusRun.error, focusRun.sessionId]) : "";
  React.useEffect(() => {
    if (!active || !focusRun) return;
    const controller = new AbortController(); const runId = focusRun.id;
    setError("");
    void scheduledTasksRepository.run(task.id, runId, controller.signal).then(run => {
      if (!controller.signal.aborted) setSnapshot({ run, signature });
    }, failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "本次执行快照读取失败。"); });
    return () => controller.abort();
  }, [active, task.id, focusRun?.id, signature, retry]);
  const current = snapshot && focusRun && snapshot.run.id === focusRun.id && snapshot.run.taskId === task.id ? snapshot : null;
  const record = focusRun ? current?.signature === signature ? current.run : { ...(current?.run ?? focusRun), ...focusRun } : undefined;
  const prompt = focusRun ? current?.run.prompt : task.prompt;
  const cwd = focusRun ? record?.cwd : task.workspaceCwd;
  return <section className="scheduled-task-details" aria-label={`${task.title}的详情`}>
    <div className="scheduled-detail-prompt"><h2>{task.title}</h2>
      {prompt !== undefined ? <p>{prompt}</p> : error ? null : <p role="status"><Spin size="small"/>正在读取本次执行快照…</p>}
      {error && <Alert type="warning" showIcon title={`记录内容读取失败，已知执行状态仍保留：${error}`} action={<WandButton size="small" onClick={() => setRetry(value => value + 1)}>重新读取</WandButton>}/>}
      <dl><dt>{focusRun ? "显示时区" : "计划时区"}</dt><dd>{focusRun ? timeZone : task.schedule.kind === "once" ? "单次绝对时间" : task.schedule.timeZone}</dd><dt>执行目录</dt><dd><code>{cwd || (focusRun ? "本次记录未保留目录" : "目录不可用")}</code></dd></dl>
      {!focusRun && (task.employeeUnavailableReason || task.workspaceUnavailableReason) && <Alert type="error" showIcon title={task.employeeUnavailableReason || task.workspaceUnavailableReason}/>}
      {!task.cancelledAt && <WandButton size="small" kind="ghost" onClick={onEdit}><WandIcon name="edit"/>编辑任务</WandButton>}
    </div>
    <ExecutionHistory key={`${task.id}:${focusRun?.id ?? "latest"}`} task={task} active={active} focusRun={record}
      onSession={run => { if (run.sessionId) onOpenSession(run.sessionId); }}/>
  </section>;
}
