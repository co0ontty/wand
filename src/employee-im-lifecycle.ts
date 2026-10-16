import type { AiTeamRun, AiTeamStep } from "./ai-team-types.js";
import type { EmployeeImEvent } from "./employee-im-types.js";
import { enrichStructuredMessages } from "./structured-client-protocol.js";
import type { ProcessEvent, SessionSnapshot } from "./types.js";

interface Notifier { notify(employeeId: string, event: EmployeeImEvent, context: { sessionId?: string; title?: string }): void }
interface State {
  semanticPrimed: boolean; stopNotified: boolean; employeeId: string; active: boolean; permission: string; questions: Set<string>; queue: number;
  candidate: number; completion: number; outcome: string; turn: string; steps: Map<string, string>;
}
interface RunState { status: AiTeamRun["status"]; steps: Map<string, string> }
interface Options { im: Notifier; getSession(id: string): SessionSnapshot | null; getRunSteps?(runId: string): AiTeamStep[] }

/** Read-only projection of execution facts. Never parses assistant prose or synthesizes success from idle. */
export class EmployeeImLifecycle {
  private readonly sessions = new Map<string, State>();
  private readonly runs = new Map<string, RunState>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  constructor(private readonly options: Options) {}

  /** Existing/recovered state is a baseline, not a new notification subscription replay. */
  seed(sessions: SessionSnapshot[], runs: AiTeamRun[] = []): void {
    for (const session of sessions) if (session.employeeId) this.sessions.set(session.id, { ...this.read(session), semanticPrimed: false });
    for (const run of runs) this.runs.set(run.id, this.readRun(run));
  }

  ingest(event: ProcessEvent): void {
    if (this.disposed || event.sessionId === "__system__" || event.type === "resync" || event.type === "notification" || event.type === "usage") return;
    // Text chunks are high-frequency; coalesce their semantic projection. Terminal/status facts are immediate.
    if (event.type === "output") {
      const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
      if (Array.isArray(data.queuedMessages) && data.queuedMessages.length !== (this.sessions.get(event.sessionId)?.queue ?? 0)) this.project(event.sessionId);
      if (!this.pending.has(event.sessionId) && this.pending.size < 1000) {
        const timer = setTimeout(() => { this.pending.delete(event.sessionId); this.project(event.sessionId); }, 100);
        timer.unref?.(); this.pending.set(event.sessionId, timer);
      }
      return;
    }
    const timer = this.pending.get(event.sessionId);
    if (timer) { clearTimeout(timer); this.pending.delete(event.sessionId); }
    const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
    this.project(event.sessionId, typeof data.completionRevision === "number" ? data.completionRevision : undefined, data.turnOutcome === "stopped");
  }

  private project(id: string, revision?: number, explicitlyStopped = false): void {
    if (this.disposed) return;
    const snapshot = this.options.getSession(id);
    if (!snapshot?.employeeId) return;
    const next = this.read(snapshot);
    const previous = this.sessions.get(id);
    next.completion = Math.max(next.completion, revision ?? 0, previous?.completion ?? 0);
    next.stopNotified = next.active ? false : previous?.stopNotified ?? false;
    this.remember(this.sessions, id, next);
    if (!previous && snapshot.autoRecovered) return;
    // A changed employee binding is a fresh baseline; never attribute another employee's old result.
    if (previous && previous.employeeId !== snapshot.employeeId) return;
    const send = (event: EmployeeImEvent) => this.send(snapshot.employeeId!, event, { sessionId: id, title: snapshot.title || snapshot.currentTaskTitle || "员工任务" });
    if (next.active && (!previous?.active || (next.turn !== previous.turn && previous.turn !== "-1:"))) send("task_started");
    if (next.permission && next.permission !== previous?.permission) send("waiting_permission");
    if (previous?.semanticPrimed !== false && [...next.questions].some(key => !previous?.questions.has(key))) send("waiting_input");
    if (next.queue > (previous?.queue ?? 0)) send("message_queued");
    if (previous && next.candidate !== previous.candidate) send("candidate_switched");
    if (previous && next.completion > previous.completion) send("task_completed");
    if (next.outcome && next.outcome !== previous?.outcome) {
      send(snapshot.status === "stopped" ? "task_stopped" : "task_failed");
      if (snapshot.status === "stopped") next.stopNotified = true;
    }
    if (explicitlyStopped && !next.stopNotified) { send("task_stopped"); next.stopNotified = true; }
    if (previous?.semanticPrimed !== false && [...next.steps].some(([key, status]) => status === "completed"
      && (next.turn !== previous?.turn || previous?.steps.get(key) !== "completed"))) send("step_completed");
  }

  /** Called at the runner's durable run/step change boundary, including async decisions after session end. */
  ingestRun(run: AiTeamRun): void {
    if (this.disposed) return;
    const next = this.readRun(run);
    const previous = this.runs.get(run.id);
    this.remember(this.runs, run.id, next);
    const leader = run.team.members.find(member => member.isLeader)?.employeeId;
    const context = { sessionId: run.chatSessionId ?? undefined, title: run.team.name };
    if (leader && previous?.status !== run.status) {
      const event: EmployeeImEvent = ({ running: "team_started", done: "team_completed", failed: "team_failed", stopped: "team_stopped",
        waiting_user: "waiting_input", awaiting_approval: "waiting_permission" } as const)[run.status];
      this.send(leader, event, context);
    }
    for (const step of this.options.getRunSteps?.(run.id) ?? []) {
      if (step.status !== "done" || previous?.steps.get(step.id) === "done") continue;
      const employeeId = run.team.members.find(member => member.id === step.memberId)?.employeeId;
      if (employeeId) this.send(employeeId, "step_completed", { sessionId: step.sessionId ?? undefined, title: step.title });
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear(); this.sessions.clear(); this.runs.clear();
  }

  private readRun(run: AiTeamRun): RunState {
    return { status: run.status, steps: new Map((this.options.getRunSteps?.(run.id) ?? []).map(step => [step.id, step.status])) };
  }

  private read(session: SessionSnapshot): State {
    const active = session.status === "running" && (session.sessionKind === "structured" ? session.structuredState?.inFlight === true : session.ptyBusy === true);
    // Only the current user turn participates; bound work on very large histories.
    const messages = session.messages ?? [];
    let start = messages.length - 1;
    while (start >= 0 && !(messages[start].role === "user" && messages[start].content.some(block => block.type === "text"))) start -= 1;
    const segment = messages.slice(Math.max(start, messages.length - 200, 0));
    const results = new Map(segment.flatMap(turn => turn.content.flatMap(block => block.type === "tool_result" ? [[block.tool_use_id, !block.is_error] as const] : [])));
    // Do not notify an intended TaskUpdate/TodoWrite before its successful result.
    // Codex's native plan updates are translated by its protocol adapter into result-less TodoWrite snapshots.
    const acknowledged = segment.map(turn => ({ ...turn, content: turn.content.filter(block => block.type !== "tool_use"
      || block.name === "AskUserQuestion" || results.get(block.id) === true
      || (session.provider === "codex" && block.name === "TodoWrite" && !results.has(block.id))) }));
    const current = enrichStructuredMessages(acknowledged);
    const answered = new Set(results.keys());
    const questions = new Set<string>();
    const steps = new Map<string, string>();
    for (const turn of current) for (const block of turn.content) {
      if (block.type !== "tool_use") continue;
      if (active && block.semantic?.kind === "question_request" && !answered.has(block.id)) questions.add(block.id);
      if (block.semantic?.kind === "task_list") for (const item of block.semantic.items) steps.set(item.id, item.status);
    }
    return {
      semanticPrimed: true, stopNotified: false, employeeId: session.employeeId!, active,
      permission: session.pendingEscalation?.requestId ?? (session.permissionBlocked ? "blocked" : ""), questions,
      queue: session.queuedMessages?.length ?? 0, candidate: session.employeeCandidateIndex ?? 0,
      completion: session.completionRevision ?? 0,
      outcome: session.status === "failed" || session.status === "stopped" ? `${session.status}:${session.endedAt ?? ""}`
        : session.providerCliActive === false && typeof session.providerCliExitCode === "number" && session.providerCliExitCode !== 0 ? `cli-failed:${session.providerCliExitCode}` : "",
      turn: `${start}:${messages[start]?.createdAt ?? ""}`, steps,
    };
  }

  private remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key); map.set(key, value);
    if (map.size > 10_000) map.delete(map.keys().next().value!);
  }

  private send(employeeId: string, event: EmployeeImEvent, context: { sessionId?: string; title?: string }): void {
    try { this.options.im.notify(employeeId, event, { sessionId: context.sessionId, title: context.title?.slice(0, 200) }); }
    catch { /* IM is never an execution outcome */ }
  }
}
