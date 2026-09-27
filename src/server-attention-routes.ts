import type { Express } from "express";
import { collectAttentionItems, type AttentionSessionInput, type AttentionTeamRunInput } from "./attention.js";
import type { AiTeamRunner } from "./ai-team-runner.js";
import type { SessionSnapshot } from "./types.js";

export function registerAttentionRoutes(
  app: Express,
  deps: {
    sessions: { listSlim(): SessionSnapshot[] };
    runner: AiTeamRunner;
  },
): void {
  app.get("/api/attention", (_req, res) => {
    const runs = deps.runner.listRuns({ limit: 80 });
    const teamRuns: AttentionTeamRunInput[] = runs.map((run) => ({
      id: run.id,
      status: run.status,
      statusDetail: run.statusDetail,
      taskTitle: run.taskTitle,
      teamName: run.team.name,
      chatSessionId: run.chatSessionId,
      updatedAt: run.updatedAt,
    }));
    const sessions: AttentionSessionInput[] = deps.sessions.listSlim().map((session) => ({
      id: session.id,
      title: session.title?.trim() || session.description?.trim() || "",
      archived: session.archived,
      status: session.status,
      lastError: session.structuredState?.lastError ?? null,
      worktreeMergeStatus: session.worktreeMergeStatus ?? null,
      automationId: session.automationId ?? null,
      updatedAt: session.endedAt || session.startedAt,
    }));
    res.json({ items: collectAttentionItems({ runs: teamRuns, sessions }) });
  });
}
