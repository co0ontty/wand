import type { WorkspaceSessionSummary, WorkspaceSessionTeamStep } from "./types";

export interface TaskTeamSessionSplit {
  /** 还在跑的运行：折起来也能一眼看到有几个在动。 */
  live: WorkspaceSessionSummary[];
  /** 运行已进终态：历史，默认折起来并允许清空。 */
  history: WorkspaceSessionSummary[];
}

export function splitTeamSessions(sessions: readonly WorkspaceSessionSummary[]): TaskTeamSessionSplit {
  const live: WorkspaceSessionSummary[] = [];
  const history: WorkspaceSessionSummary[] = [];
  for (const session of sessions) {
    if (!session.teamStep) continue;
    (session.teamStep.runFinished ? history : live).push(session);
  }
  return { live, history };
}

/** 任务里不属于团队派发的会话（人工会话 + 群聊入口）。 */
export function nonTeamSessions(sessions: readonly WorkspaceSessionSummary[]): WorkspaceSessionSummary[] {
  return sessions.filter((session) => !session.teamStep);
}

const TEAM_LABEL_MAX_CHARS = 26;

/** 侧栏短标题：这一步的任务标题就是标题，不拼团队名、不等 CLI 生成会话名。 */
export function teamStepLabel(step: WorkspaceSessionTeamStep): string {
  const title = (step.title || "").replace(/\s+/g, " ").trim();
  if (!title) return step.kind === "leader" ? "负责人回合" : (step.memberName || "团队会话");
  if (Array.from(title).length <= TEAM_LABEL_MAX_CHARS) return title;
  return `${Array.from(title).slice(0, TEAM_LABEL_MAX_CHARS - 1).join("")}…`;
}

/** 群聊条目的短标题：行尾已有「群聊」徽标，名字里不再重复团队和任务。 */
export function teamChatLabel(session: WorkspaceSessionSummary): string {
  const teamName = (session.teamChat?.teamName || "").trim();
  return teamName || (session.title || "").trim();
}
