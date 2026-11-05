import * as React from "react";
import { WandButton } from "../ui";
import { SessionMoveButton } from "../workspaces/session-move-button";
import { issueAgentLabel } from "./task-board-agent";
import { taskSessionActivity } from "./task-delivery-state";
import type { WandTaskListed } from "./task-board-repository";

/** 侧栏里的执行会话：一行一个，点名称精确打开原会话；会话结束不等于交付完成，交付以「交付记录」为准。 */
export function TaskSessionSummary({ task, onOpenSession, onNewParallel }: {
  task: WandTaskListed; onOpenSession?: (id: string) => void; onNewParallel(): void;
}): React.ReactElement {
  const sessions = [...task.sessions].reverse();
  return <section className="task-detail-side-section" aria-label="执行会话">
    <div className="task-detail-side-heading">
      <span>执行会话{sessions.length ? <small>{sessions.length}</small> : null}</span>
      {task.status !== "archived" && <WandButton kind="ghost" size="small" onClick={onNewParallel}>新建</WandButton>}
    </div>
    {sessions.length === 0 ? <p className="task-detail-side-empty">暂无会话</p> : <ul className="task-detail-session-list">
      {sessions.map(session => {
        const activity = taskSessionActivity(session);
        const name = session.title || session.id;
        return <li key={session.id}>
          <button type="button" className="task-detail-session-row" disabled={!onOpenSession} onClick={() => onOpenSession?.(session.id)}
            aria-label={`打开会话：${name}（${activity}）`} title={[name, session.purpose, session.cwd].filter(Boolean).join("\n")}>
            <span className="task-detail-session-name">{name}</span>
            <span className="task-detail-session-meta">
              <span className="task-next-step-session-state" data-activity={activity}>{activity}</span>
              <span>{session.employeeName || issueAgentLabel(session.provider, session.engine)}</span>
            </span>
          </button>
          <SessionMoveButton className="task-detail-session-move" sessionId={session.id} taskId={task.workspaceTaskId ?? undefined}/>
        </li>;
      })}
    </ul>}
  </section>;
}
