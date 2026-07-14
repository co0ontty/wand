import type { ConversationTurn, SessionSnapshot } from "./types.js";

export const SESSION_TRANSPORT_OUTPUT_LIMIT = 200_000;

export type SessionBaseDTO = Omit<SessionSnapshot, "output" | "messages">;

export interface SessionListItemDTO extends SessionBaseDTO {
  /** Kept for compatibility with clients that initialize terminal state from the list. */
  output: "";
}

export interface SessionDetailDTO extends SessionBaseDTO {
  output: string;
  outputOffset: number;
  outputTotal: number;
  outputTruncated: boolean;
  messages?: ConversationTurn[];
  messageOffset?: number;
  messageTotal?: number;
  leadingBlockOffset?: number;
  leadingBlockTotal?: number;
}

/** Explicit allow-list separating the server's session object from its wire DTO. */
function sessionBase(snapshot: SessionSnapshot): SessionBaseDTO {
  return {
    id: snapshot.id,
    sessionSource: snapshot.sessionSource,
    automationId: snapshot.automationId,
    sessionKind: snapshot.sessionKind,
    provider: snapshot.provider,
    runner: snapshot.runner,
    command: snapshot.command,
    cwd: snapshot.cwd,
    mode: snapshot.mode,
    worktreeEnabled: snapshot.worktreeEnabled,
    worktree: snapshot.worktree,
    worktreeMergeStatus: snapshot.worktreeMergeStatus,
    worktreeMergeInfo: snapshot.worktreeMergeInfo,
    autonomyPolicy: snapshot.autonomyPolicy,
    approvalPolicy: snapshot.approvalPolicy,
    allowedScopes: snapshot.allowedScopes,
    status: snapshot.status,
    exitCode: snapshot.exitCode,
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    archived: snapshot.archived,
    archivedAt: snapshot.archivedAt,
    permissionBlocked: snapshot.permissionBlocked,
    pendingEscalation: snapshot.pendingEscalation,
    lastEscalationResult: snapshot.lastEscalationResult,
    claudeSessionId: snapshot.claudeSessionId,
    queuedMessages: snapshot.queuedMessages,
    structuredState: snapshot.structuredState,
    resumedFromSessionId: snapshot.resumedFromSessionId,
    autoRecovered: snapshot.autoRecovered,
    autoApprovePermissions: snapshot.autoApprovePermissions,
    approvalStats: snapshot.approvalStats,
    summary: snapshot.summary,
    title: snapshot.title,
    description: snapshot.description,
    currentTaskTitle: snapshot.currentTaskTitle,
    selectedModel: snapshot.selectedModel,
    thinkingEffort: snapshot.thinkingEffort,
    ptyCols: snapshot.ptyCols,
    ptyRows: snapshot.ptyRows,
  };
}

export function toSessionListItemDTO(snapshot: SessionSnapshot): SessionListItemDTO {
  return { ...sessionBase(snapshot), output: "" };
}

export interface SessionDetailDTOOptions {
  output?: string;
  messages?: ConversationTurn[];
  messageOffset?: number;
  messageTotal?: number;
  leadingBlockOffset?: number;
  leadingBlockTotal?: number;
  outputLimit?: number;
}

export function toSessionDetailDTO(
  snapshot: SessionSnapshot,
  options: SessionDetailDTOOptions = {},
): SessionDetailDTO {
  const rawOutput = options.output ?? snapshot.output;
  const outputLimit = Math.max(1, options.outputLimit ?? SESSION_TRANSPORT_OUTPUT_LIMIT);
  const outputOffset = Math.max(0, rawOutput.length - outputLimit);
  return {
    ...sessionBase(snapshot),
    output: outputOffset > 0 ? rawOutput.slice(outputOffset) : rawOutput,
    outputOffset,
    outputTotal: rawOutput.length,
    outputTruncated: outputOffset > 0,
    ...(options.messages !== undefined ? { messages: options.messages } : {}),
    ...(options.messageOffset !== undefined ? { messageOffset: options.messageOffset } : {}),
    ...(options.messageTotal !== undefined ? { messageTotal: options.messageTotal } : {}),
    ...(options.leadingBlockOffset !== undefined ? { leadingBlockOffset: options.leadingBlockOffset } : {}),
    ...(options.leadingBlockTotal !== undefined ? { leadingBlockTotal: options.leadingBlockTotal } : {}),
  };
}

/** Bound snapshot-like event payloads before they enter per-client WS queues. */
export function boundSessionEventData(data: unknown, outputLimit = SESSION_TRANSPORT_OUTPUT_LIMIT): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const record = data as Record<string, unknown>;
  if (typeof record.output !== "string" || record.output.length <= outputLimit) return data;
  const outputOffset = record.output.length - outputLimit;
  return {
    ...record,
    output: record.output.slice(outputOffset),
    outputOffset,
    outputTotal: record.output.length,
    outputTruncated: true,
  };
}
