import * as React from "react";
import type { WandTaskListed } from "./task-board-repository";
import { WandButton } from "../ui/button";
import { WandIcon } from "../ui/icons";

/** 概览里的任务行：点击直接进入任务详情页，不在原地展开。 */
export function TaskSummaryRow({ task, caption, onOpen }: { task: WandTaskListed; caption?: string; onOpen(id: string): void }): React.ReactElement {
  return <div className="task-summary-row"><WandButton kind="ghost" className="task-panel-summary-row"
    aria-label={`打开 ${task.identifier}: ${task.title}`} onClick={() => onOpen(task.id)}>
    <span><strong>{task.title}</strong><small>{caption || `${task.identifier} · ${task.assignedExecutor?.name || "未指派"}`}</small></span>
    <WandIcon name="chevron" size={12}/>
  </WandButton></div>;
}
