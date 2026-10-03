import path from "node:path";
import type { AiTeam, AiTeamRun, AiTeamStep } from "./ai-team-types.js";
import type { AiTeamDeliveryFile, AiTeamDeliveryHandoff, AiTeamDeliverySummary } from "./ai-team-delivery-types.js";
import type { AgentActivityState } from "./mission-types.js";
import type { ConversationTurn, TeamReportFile } from "./types.js";

export const AI_TEAM_DELIVERY_FILES_LIMIT = 20;
export const AI_TEAM_DELIVERY_HANDOFFS_LIMIT = 6;

function bounded(value: unknown, limit: number): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length <= limit) return trimmed;
  let end = limit - 1;
  if (end > 0 && /[\uD800-\uDBFF]/.test(trimmed[end - 1])) end--;
  return `${trimmed.slice(0, end)}…`;
}

/** Uses only completion-frozen metadata; no file IO, private chats or knowledge reads. */
function recordedFile(file: TeamReportFile, cwd: string): TeamReportFile | null {
  if (typeof file.path !== "string" || !file.path || file.path.length > 4096 || file.path.includes("\0")
    || !path.isAbsolute(file.path) || !cwd || !Number.isSafeInteger(file.size) || file.size < 0) return null;
  const relative = path.relative(path.resolve(cwd), path.resolve(file.path));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return {
    stepId: file.stepId,
    path: file.path,
    name: bounded(file.name || path.basename(file.path), 255),
    size: file.size,
    ...(file.preview ? { preview: {
      title: bounded(file.preview.title, 100),
      excerpt: bounded(bounded(file.preview.excerpt, 241).split(/\r?\n/).slice(0, 3).join("\n"), 240),
    } } : {}),
  };
}

export function buildAiTeamDeliverySummary(input: {
  run: AiTeamRun;
  steps: readonly AiTeamStep[];
  displayTeam: AiTeam;
  relayTurns: readonly ConversationTurn[];
  memberStates: Readonly<Record<string, AgentActivityState>>;
}): AiTeamDeliverySummary {
  const { run, steps, displayTeam, relayTurns, memberStates } = input;
  const members = new Map(displayTeam.members.map((member) => [member.id, member]));
  const currentSteps = steps.filter((step) => step.runId === run.id);
  const byId = new Map(currentSteps.map((step) => [step.id, step]));
  const names = (step: AiTeamStep): string => bounded(members.get(step.memberId)?.name || step.memberId, 100);
  const files = new Map<string, AiTeamDeliveryFile>();
  for (const turn of relayTurns) {
    if (turn.role !== "assistant" || !turn.reportFile) continue;
    const step = byId.get(turn.reportFile.stepId);
    if (!step || step.kind !== "work" || step.status !== "done"
      || (turn.author && turn.author.id !== step.memberId)) continue;
    const file = recordedFile(turn.reportFile, run.cwd);
    if (!file) continue;
    const previous = files.get(step.id);
    // Never let a later truncated/legacy duplicate replace an existing complete preview.
    if (previous && (previous.file.preview || !file.preview || previous.file.path !== file.path)) continue;
    files.set(step.id, {
      stepId: step.id, seq: step.seq, title: bounded(step.title, 160),
      memberId: step.memberId, memberName: names(step), file,
    });
  }
  const delivered = [...files.values()].sort((a, b) => b.seq - a.seq);
  const pending: AiTeamDeliveryHandoff[] = currentSteps
    .filter((step) => step.status === "running" || step.status === "queued")
    .sort((a, b) => Number(a.status === "queued") - Number(b.status === "queued") || a.seq - b.seq)
    .map((step) => ({
      stepId: step.id, seq: step.seq, title: bounded(step.title, 160),
      memberId: step.memberId, memberName: names(step),
      status: step.status as "running" | "queued", sessionId: step.sessionId,
      ...(step.sessionId && memberStates[step.sessionId] ? { state: memberStates[step.sessionId] } : {}),
      waitingFor: step.dependsOn.flatMap((id) => {
        const dependency = byId.get(id);
        if (!dependency) return [bounded(`未完成步骤 ${id}`, 180)];
        return dependency.status !== "done"
          ? [bounded(`${names(dependency)} · ${dependency.title}`, 180)] : [];
      }).slice(0, AI_TEAM_DELIVERY_HANDOFFS_LIMIT),
    }));
  const headlines: Record<AiTeamRun["status"], string> = {
    running: "团队正在处理", awaiting_approval: "计划待你批准", waiting_user: "负责人等你回复",
    done: "本轮交付已完成", failed: "本轮执行失败", stopped: "本轮已停止",
  };
  const attentionKind = run.status === "awaiting_approval" ? "approval"
    : run.status === "waiting_user" ? "reply"
      : run.status === "failed" ? "failure" : run.status === "stopped" ? "stopped" : null;
  return {
    runId: run.id, updatedAt: run.updatedAt, headline: headlines[run.status],
    conclusion: run.status === "done" ? bounded(run.statusDetail, 600) || null : null,
    files: delivered.slice(0, AI_TEAM_DELIVERY_FILES_LIMIT), totalFiles: delivered.length,
    handoffs: pending.slice(0, AI_TEAM_DELIVERY_HANDOFFS_LIMIT), totalHandoffs: pending.length,
    attention: attentionKind ? { kind: attentionKind, message: bounded(run.statusDetail, 600) } : null,
  };
}
