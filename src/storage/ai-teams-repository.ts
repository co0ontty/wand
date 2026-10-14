import { DatabaseSync } from "node:sqlite";
import { freezeTeamEmployees, projectTeamDefinition, serializeExecutionTeam } from "../ai-team-employee-binding.js";
import type { AiTeam, AiTeamRun, AiTeamRunChatMarker, AiTeamRunStatus, AiTeamStep, AiTeamStepSessionMarker, AiTeamStepStatus } from "../ai-team-types.js";
import { AI_TEAM_TERMINAL_RUN_STATUSES, aiTeamChatTitle } from "../ai-team-types.js";
import { safeJsonParse } from "./mappers.js";
import type { WandStorage } from "../storage.js";
import { AiTeamRunState, mapAiTeamRow, normalizeAiTeamMembers, teamMemberName, mapAiTeamRunRow, parseAiTeamRunState, mapAiTeamStepRow } from "./internal.js";

/** AiTeam storage: one domain of the WandStorage facade. Shares the connection and the facade's transaction. */
export class AiTeamRepository {
  constructor(private readonly db: DatabaseSync, private readonly s: WandStorage) {}

  listAiTeams(): AiTeam[] {
    const rows = this.db.prepare("SELECT * FROM ai_teams ORDER BY created_at ASC").all() as unknown as Record<string, unknown>[];
    return rows.map((row) => projectTeamDefinition(mapAiTeamRow(row), this.s));
  }

  getAiTeam(id: string): AiTeam | null {
    const row = this.db.prepare("SELECT * FROM ai_teams WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? projectTeamDefinition(mapAiTeamRow(row), this.s) : null;
  }

  saveAiTeam(team: AiTeam): void {
    team = freezeTeamEmployees(team, this.s);
    this.db.prepare(
      `INSERT INTO ai_teams (
         id, name, description, instructions, members_json, require_plan_approval, max_steps,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, description = excluded.description,
         instructions = excluded.instructions,
         members_json = excluded.members_json,
         require_plan_approval = excluded.require_plan_approval,
         max_steps = excluded.max_steps, updated_at = excluded.updated_at`
    ).run(
      team.id, team.name, team.description, team.instructions, JSON.stringify(team.members),
      team.requirePlanApproval ? 1 : 0, team.maxSteps, team.createdAt, team.updatedAt,
    );
  }

  /** 只删团队定义；已有运行保存了团队快照，不受影响。 */
  deleteAiTeam(id: string): void {
    this.db.prepare("DELETE FROM ai_teams WHERE id = ?").run(id);
  }

  /** 保留期清理：删掉一次运行及其步骤。关联会话由调用方按运行所有权删除。 */
  deleteAiTeamRun(id: string): void {
    this.s.transaction(() => {
      this.db.prepare("DELETE FROM ai_team_steps WHERE run_id = ?").run(id);
      this.db.prepare("DELETE FROM ai_team_runs WHERE id = ?").run(id);
    });
  }

  saveAiTeamRun(run: AiTeamRun): void {
    this.db.prepare(
      `INSERT INTO ai_team_runs (
         id, team_id, task_id, team_json, objective, cwd, status, status_detail,
         steps_used, step_limit, format_retries, plan_approved, chat_session_id, pending_notes_json,
         created_at, updated_at, conversation_id, member_version, round_number
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         team_json = excluded.team_json,
         status = excluded.status, status_detail = excluded.status_detail,
         steps_used = excluded.steps_used, step_limit = excluded.step_limit,
         format_retries = excluded.format_retries, plan_approved = excluded.plan_approved,
         chat_session_id = excluded.chat_session_id, pending_notes_json = excluded.pending_notes_json,
         conversation_id = COALESCE(excluded.conversation_id, ai_team_runs.conversation_id),
         member_version = COALESCE(excluded.member_version, ai_team_runs.member_version),
         round_number = COALESCE(excluded.round_number, ai_team_runs.round_number),
         updated_at = excluded.updated_at`
    ).run(
      run.id, run.teamId, run.taskId, serializeExecutionTeam(run.team), run.objective, run.cwd,
      run.status, run.statusDetail, run.stepsUsed, run.stepLimit, run.formatRetries,
      run.planApproved ? 1 : 0, run.chatSessionId, JSON.stringify(run.pendingNotes), run.createdAt, run.updatedAt,
      run.conversationId ?? null, run.memberVersion ?? null, run.roundNumber ?? null,
    );
  }

  /** 群聊会话对应的最近一次运行（同一个群聊可以接着开新运行）。 */
  getLatestAiTeamRunByChat(sessionId: string): AiTeamRun | null {
    const row = this.db.prepare(
      "SELECT * FROM ai_team_runs WHERE chat_session_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapAiTeamRunRow(row) : null;
  }

  /**
   * 会话列表用的群聊标记索引：chat_session_id → 最近一次运行的入口信息。
   * 一次查询建整张表，供 /api/tasks 每请求一次构建；不逐会话查询。
   */
  listAiTeamRunChatMarkers(): Map<string, AiTeamRunChatMarker> {
    const rows = this.db.prepare(
      `SELECT r.id, r.team_id, r.team_json, r.chat_session_id, t.name AS current_team_name,
              task.title AS task_title
       FROM ai_team_runs r LEFT JOIN ai_teams t ON t.id = r.team_id
       LEFT JOIN command_sessions s ON s.id = r.chat_session_id
       LEFT JOIN wand_tasks task ON task.id = COALESCE((
         SELECT id FROM wand_tasks WHERE workspace_task_id = s.workspace_task_id
         ORDER BY updated_at DESC, rowid DESC LIMIT 1
       ), r.task_id)
       WHERE r.chat_session_id IS NOT NULL AND r.chat_session_id <> '' ORDER BY r.created_at DESC`,
    ).all() as unknown as Record<string, unknown>[];
    const markers = new Map<string, AiTeamRunChatMarker>();
    for (const row of rows) {
      const chatSessionId = typeof row.chat_session_id === "string" ? row.chat_session_id : "";
      if (!chatSessionId || markers.has(chatSessionId)) continue;
      const rawTeam = safeJsonParse<Record<string, unknown>>(typeof row.team_json === "string" ? row.team_json : null);
      markers.set(chatSessionId, {
        runId: String(row.id),
        teamId: String(row.team_id),
        teamName: typeof row.current_team_name === "string" ? row.current_team_name : String(rawTeam?.name ?? ""),
        chatTitle: aiTeamChatTitle(typeof row.task_title === "string" ? row.task_title : ""),
        memberCount: Array.isArray(rawTeam?.members) ? rawTeam.members.length : 0,
      });
    }
    return markers;
  }

  /**
   * 会话列表用的成员步骤标记：session_id → 这一步的身份。
   * 和 `listAiTeamRunChatMarkers()` 一样一次查询建整张表，供 /api/tasks 每请求一次构建。
   * 同一个会话被多个步骤复用时取 seq 最大的那一步（最近一次派发）。
   */
  listAiTeamStepSessionMarkers(): Map<string, AiTeamStepSessionMarker> {
    const rows = this.db.prepare(
      `SELECT s.id, s.run_id, s.kind, s.seq, s.member_id, s.title, s.status, s.session_id,
              r.status AS run_status, r.team_json, t.name AS current_team_name, t.members_json AS current_members_json
       FROM ai_team_steps s
       JOIN ai_team_runs r ON r.id = s.run_id
       LEFT JOIN ai_teams t ON t.id = r.team_id
       WHERE s.session_id IS NOT NULL AND s.session_id <> ''
       ORDER BY s.seq DESC`,
    ).all() as unknown as Record<string, unknown>[];
    const markers = new Map<string, AiTeamStepSessionMarker>();
    const currentTeams = new Map<string, unknown>();
    for (const row of rows) {
      const sessionId = typeof row.session_id === "string" ? row.session_id : "";
      if (!sessionId || markers.has(sessionId)) continue;
      const runTeam = safeJsonParse<Record<string, unknown>>(typeof row.team_json === "string" ? row.team_json : null);
      const runId = String(row.run_id);
      const memberId = String(row.member_id ?? "");
      if (!currentTeams.has(runId)) {
        // ai_teams.members_json 存的是裸成员数组；team_json 存的是整份团队对象。
        currentTeams.set(runId, safeJsonParse<unknown>(
          typeof row.current_members_json === "string" ? row.current_members_json : null,
        ));
      }
      const frozenMember = normalizeAiTeamMembers(runTeam?.members).find((member) => member.id === memberId);
      const currentMember = normalizeAiTeamMembers(currentTeams.get(runId)).find((member) => member.id === memberId);
      const employee = frozenMember?.employeeId ? this.s.getSiliconEmployee(frozenMember.employeeId) : null;
      const memberName = (frozenMember?.employeeId
        ? employee?.name ?? frozenMember.name
        : currentMember?.employeeId ? undefined : teamMemberName(currentTeams.get(runId), memberId))
        ?? teamMemberName(runTeam?.members, memberId)
        ?? memberId;
      const runStatus = String(row.run_status ?? "") as AiTeamRunStatus;
      markers.set(sessionId, {
        runId,
        stepId: String(row.id),
        kind: String(row.kind ?? "work") === "leader" ? "leader" : "work",
        title: String(row.title ?? ""),
        memberId,
        memberName,
        teamName: typeof row.current_team_name === "string" && row.current_team_name
          ? row.current_team_name
          : String(runTeam?.name ?? ""),
        stepStatus: String(row.status ?? "queued") as AiTeamStepStatus,
        runStatus,
        runFinished: AI_TEAM_TERMINAL_RUN_STATUSES.includes(runStatus),
      });
    }
    return markers;
  }

  getAiTeamRun(id: string): AiTeamRun | null {
    const row = this.db.prepare("SELECT * FROM ai_team_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapAiTeamRunRow(row) : null;
  }

  listAiTeamRuns(
    filter: { taskId?: string; teamId?: string; statuses?: readonly AiTeamRunStatus[]; limit?: number } = {},
  ): AiTeamRun[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.taskId) {
      where.push("task_id = ?");
      params.push(filter.taskId);
    }
    if (filter.teamId) {
      where.push("team_id = ?");
      params.push(filter.teamId);
    }
    if (filter.statuses) {
      if (filter.statuses.length === 0) return [];
      where.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      params.push(...filter.statuses);
    }
    const rows = this.db.prepare(
      `SELECT * FROM ai_team_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`
        + (filter.limit ? ` LIMIT ${Math.max(1, Math.floor(filter.limit))}` : "")
    ).all(...params) as unknown as Record<string, unknown>[];
    return rows.map(mapAiTeamRunRow);
  }

  saveAiTeamStep(step: AiTeamStep): void {
    this.db.prepare(
      `INSERT INTO ai_team_steps (
         id, run_id, seq, kind, member_id, title, instructions, session_id, status,
         report, report_path, depends_on_json, started_at, ended_at, dispatch_info_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id, status = excluded.status, report = excluded.report,
         instructions = excluded.instructions, report_path = excluded.report_path,
         depends_on_json = excluded.depends_on_json,
         dispatch_info_json = excluded.dispatch_info_json,
         started_at = excluded.started_at, ended_at = excluded.ended_at`
    ).run(
      step.id, step.runId, step.seq, step.kind, step.memberId, step.title, step.instructions,
      step.sessionId, step.status, step.report, step.reportPath, JSON.stringify(step.dependsOn),
      step.startedAt, step.endedAt, JSON.stringify(step.dispatchInfo ?? { usedCandidate: 0, skipped: [] }),
    );
  }

  listAiTeamSteps(runId: string): AiTeamStep[] {
    const rows = this.db.prepare("SELECT * FROM ai_team_steps WHERE run_id = ? ORDER BY seq ASC").all(runId) as unknown as Record<string, unknown>[];
    return rows.map(mapAiTeamStepRow);
  }

  getRunningAiTeamStepBySession(sessionId: string): AiTeamStep | null {
    const row = this.db.prepare(
      "SELECT * FROM ai_team_steps WHERE session_id = ? AND status = 'running' LIMIT 1"
    ).get(sessionId) as Record<string, unknown> | undefined;
    return row ? mapAiTeamStepRow(row) : null;
  }

  /** `ai_team_runs.run_state_json` 的读侧入口（§3.4）；脏值 / 旧行退化成空黑名单。 */
  getAiTeamRunState(runId: string): AiTeamRunState {
    const row = this.db.prepare("SELECT run_state_json FROM ai_team_runs WHERE id = ?").get(runId) as
      | { run_state_json?: unknown }
      | undefined;
    return parseAiTeamRunState(row?.run_state_json);
  }

  /** 只写 `run_state_json` 一列，不碰 `saveAiTeamRun` 负责的业务字段。 */
  setAiTeamRunState(runId: string, state: AiTeamRunState): void {
    this.db.prepare("UPDATE ai_team_runs SET run_state_json = ? WHERE id = ?")
      .run(JSON.stringify(state), runId);
  }
}
