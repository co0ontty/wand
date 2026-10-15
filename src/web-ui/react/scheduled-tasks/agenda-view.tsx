import * as React from "react";
import { Card, Grid, List, Skeleton } from "antd";
import type { ScheduledTaskRunFactView, ScheduledTaskSummary } from "../../../scheduled-task-types.js";
import { EmployeeAvatar } from "../agents/employee-avatar.js";
import { WandButton, WandIconButton } from "../ui/button";
import { WandIcon } from "../ui/icons";
import { WandDropdownMenu, WandDropdownMenuTrigger, WandDropdownMenuContent, WandDropdownMenuItem } from "../ui/dropdown-menu";
import { scheduleLabel, scheduledRunState, scheduledTaskState } from "../scheduled-tasks/model.js";
import { appointment, groupAgenda, isScheduled } from "../../../scheduled-task-agenda.js";
import { useScheduledPresentation } from "./presentation-context";

export function RunState({ run }: { run: ScheduledTaskRunFactView }): React.ReactElement {
  return <span className="scheduled-run-state" data-tone={run.executionStatus}><WandIcon size={13} name={run.executionStatus === "completed" ? "check" : run.executionStatus === "failed" ? "warning" : run.executionStatus === "unknown" ? "question" : "history"}/>{scheduledRunState(run)}</span>;
}

export function EmployeeFace({ task, size = "md" }: { task: ScheduledTaskSummary; size?: "sm" | "md" | "lg" | "xl" }) {
  const { employees } = useScheduledPresentation();
  const employee = employees.find(item => item.id === task.employeeId) ?? { id: task.employeeId, name: task.employeeName };
  return <span className="scheduled-employee-face" role="img" aria-label={`${task.employeeName}的头像`} data-employee-id={task.employeeId}>
    <EmployeeAvatar employee={employee} provider="" size={size}/>
  </span>;
}

function PlanState({ task }: { task: ScheduledTaskSummary }) {
  const tone = task.cancelledAt || !task.nextRunAt || !task.enabled ? "muted" : task.employeeUnavailableReason || task.workspaceUnavailableReason ? "danger" : "default";
  return <span className="scheduled-plan-state" data-tone={tone}><i/>{scheduledTaskState(task)}</span>;
}

export function NextTaskPanel({ task, scene, hasTasks, reduced, onEdit, onLocate }: {
  task?: ScheduledTaskSummary; scene: string; hasTasks: boolean; reduced: boolean; onEdit(task: ScheduledTaskSummary): void; onLocate(task: ScheduledTaskSummary): void;
}) {
  const { now, timeZone } = useScheduledPresentation();
  const when = task?.nextRunAt ? appointment(task.nextRunAt, now, timeZone) : null;
  const due = task?.nextRunAt && Date.parse(task.nextRunAt) <= now.getTime();
  return <section className="scheduled-next-section" aria-label="接下来执行的任务详情" data-next-task={task?.id}>
    <Card className="scheduled-next-task-panel" size="small" variant="borderless" styles={{ body: { padding: 16 }, root: { boxShadow: "none" } }}>
      <header className="scheduled-next-heading"><h2>接下来{task && when ? <span className="scheduled-next-schedule"><span>{due ? "等待触发" : `${when.day}${when.period}`}</span><time dateTime={task.nextRunAt!} title={`${when.exact} · ${timeZone}`}>{when.time}</time></span> : null}</h2>
        {task && <WandDropdownMenu><WandDropdownMenuTrigger render={<WandIconButton className="scheduled-next-more-trigger" aria-label="下一项任务的更多操作"><WandIcon name="more" size={17}/></WandIconButton>}/><WandDropdownMenuContent align="end" popupOwner="scheduled-next-task"><WandDropdownMenuItem icon="edit" onSelect={() => onEdit(task)}>编辑计划</WandDropdownMenuItem><WandDropdownMenuItem icon="history" onSelect={() => onLocate(task)}>在列表中查看</WandDropdownMenuItem></WandDropdownMenuContent></WandDropdownMenu>}
      </header>
      {task && when ? <div className="scheduled-next-work"><div className="scheduled-next-identity"><EmployeeFace task={task} size="lg"/></div><div className="scheduled-next-description"><h3>{task.title}</h3><p className="scheduled-next-prompt">{task.prompt}</p>
        <div className="scheduled-next-metadata"><span>{task.employeeName}</span><span><WandIcon name="folder" size={12}/>{task.workspaceName}</span><code>{task.workspaceCwd || "目录不可用"}</code><span>{task.schedule.kind === "once" ? `仅执行一次 · ${timeZone}` : scheduleLabel(task.schedule)}</span></div>
        {task.employeeUnavailableReason || task.workspaceUnavailableReason ? <p className="scheduled-next-run-note" data-tone="danger"><WandIcon name="warning" size={13}/>{task.employeeUnavailableReason || task.workspaceUnavailableReason}</p> : task.lastRun && ["running", "failed", "unknown"].includes(task.lastRun.executionStatus) ? <p className="scheduled-next-run-note"><span>上一轮</span><RunState run={task.lastRun}/>{task.lastRun.executionStatus === "running" && <span>到时未结束则跳过本次</span>}</p> : null}
      </div></div> : scene === "loading" ? <div className="scheduled-next-empty" role="status"><Skeleton active={!reduced} avatar={{ size: 56 }} title={{ width: "35%" }} paragraph={{ rows: 2, width: ["65%", "45%"] }}/></div>
        : <div className="scheduled-next-empty"><WandIcon name={scene === "error" ? "warning" : "history"} size={22}/><div><strong>{scene === "error" ? "暂时无法读取下一项任务" : "暂无接下来要执行的任务"}</strong><p>{scene === "error" ? "恢复连接后再显示计划详情。" : hasTasks ? "已暂停和已结束的任务仍保留在下方。" : "创建计划后，下一项会显示在这里。"}</p></div></div>}
    </Card>
  </section>;
}

export function TaskAgenda({ tasks, expanded, visited, onToggle, renderActions, renderDetails }: {
  tasks: ScheduledTaskSummary[]; expanded: string[]; visited: string[]; onToggle(id: string): void;
  renderActions(task: ScheduledTaskSummary): React.ReactNode; renderDetails(task: ScheduledTaskSummary): React.ReactNode;
}) {
  const { now, timeZone } = useScheduledPresentation();
  const screens = Grid.useBreakpoint();
  const groups = groupAgenda(tasks, now, timeZone);
  return <section className="task-agenda" aria-label="按执行时间排列的任务列表">{groups.map(group => <section className="scheduled-agenda-group" key={group.id} data-agenda-group={group.id} data-active={group.active} aria-label={`${group.title}的任务`}>
    <header className="scheduled-agenda-group-heading"><h3 title={group.dateLabel} aria-label={[group.title, group.dateLabel].filter(Boolean).join(" · ")}>{group.title}</h3></header>
    <List dataSource={group.tasks} renderItem={task => {
      const active = isScheduled(task), when = active && task.nextRunAt ? appointment(task.nextRunAt, now, timeZone) : null;
      const open = expanded.includes(task.id);
      return <List.Item key={task.id} className="scheduled-agenda-task scheduled-task-row" data-task-id={task.id} data-scheduled-task-id={task.id} data-planned-at={active ? task.nextRunAt : undefined} data-planned-active={active}>
        <article><div className="scheduled-task-summary"><div className="scheduled-task-time" aria-label={when ? `计划在${when.day}${when.period}${when.time}执行` : scheduledTaskState(task)}>
          {when ? <time dateTime={task.nextRunAt!} title={`${when.exact} · ${timeZone}`}>{when.time}</time> : <strong title="无后续安排">—</strong>}
        </div>
          <div className="scheduled-task-row-avatar"><EmployeeFace task={task} size={screens.sm ? "md" : "sm"}/></div>
          <div className="scheduled-task-info"><WandButton className="scheduled-task-title-button" kind="ghost" aria-expanded={open} aria-controls={`detail-${task.id}`} aria-label={`${open ? "收起" : "展开"}${task.title}`} onClick={() => onToggle(task.id)}><span title={task.title}>{task.title}</span><span className="scheduled-task-chevron" data-expanded={open}><WandIcon name="chevronDown" size={13}/></span></WandButton>
            <div className="scheduled-task-target" aria-label="执行员工与工作区"><span>{task.employeeName}</span><span title={task.workspaceCwd || "目录不可用"}>{task.workspaceName}</span>{(!active || task.employeeUnavailableReason || task.workspaceUnavailableReason) && <PlanState task={task}/>}<span className="task-latest" aria-label="最近执行" title={task.lastRun ? `上一轮：${scheduledRunState(task.lastRun)}` : "尚未执行"}>{task.lastRun ? <><span>上次</span><RunState run={task.lastRun}/></> : <span>尚未执行</span>}</span>{task.schedule.kind !== "once" && task.schedule.timeZone !== timeZone ? <span>{task.schedule.timeZone}</span> : null}</div>
          </div>
          {renderActions(task)}
        </div>
          <div id={`detail-${task.id}`} className="scheduled-inline-details" data-open={open} inert={!open} aria-hidden={!open}><div><div className="scheduled-row-detail-content">{visited.includes(task.id) || open ? renderDetails(task) : null}</div></div></div>
        </article>
      </List.Item>;
    }}/>
  </section>)}</section>;
}
