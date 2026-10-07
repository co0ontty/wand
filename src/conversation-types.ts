import type { AiTeam, AiTeamRun, AiTeamRunDetail } from "./ai-team-types.js";
import type { WandTask } from "./task-types.js";
import type { ConversationSessionPreview, ConversationTurn } from "./types.js";

/** This Wand service has one authenticated owner; connection principals are capabilities, not new users. */
export const CONVERSATION_OWNER = "local-owner";
export const CONVERSATION_RELAY_PREFIX = "conversation:";
export const CONVERSATION_MIN_MEMBERS = 1;
export type ConversationTarget = { taskId: string; runId: string } | null;

/** Instance configuration is independent of both presets and frozen run.team. */
export interface ConversationInstance {
  id: string;
  owner: string;
  kind: "dm" | "group";
  peerEmployeeId: string | null;
  name: string;
  nameSource: "auto" | "custom";
  sourceTemplateId: string | null;
  team: AiTeam | null;
  memberVersion: number;
  joinedVersions: Record<string, number>;
  /** Group relay or preserved legacy DM channel, never the most recent direct-message execution. */
  sessionId: string | null;
  /** Group talk/legacy DM channel; new DM executions belong to each reply's sessionLink. */
  communicationSessionId: string | null;
  historySessionIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationTaskSummary {
  task: WandTask;
  linkedAt: string;
  runs: AiTeamRun[];
  startup?: { state: "pending" | "started" | "failed"; error?: string };
}

export interface ConversationSummary extends ConversationInstance {
  pinnedAt?: string | null;
  dissolvedAt?: string | null;
  dissolvedBy?: string | null;
  deleting?: boolean;
  title: string;
  unavailableReason: string | null;
  memberUnavailableReasons: Record<string, string>;
  tasks: ConversationTaskSummary[];
  preview: string;
  messageAt: string;
}

export interface ConversationDetail extends ConversationSummary {
  messages: ConversationTurn[];
  runDetails: AiTeamRunDetail[];
}

export interface ConversationReceipt {
  requestId: string;
  state: "pending" | "accepted" | "rejected";
  conversationId: string;
  taskId?: string;
  runId?: string;
  sessionId?: string;
  messageId?: string;
  /** Session or task/group acceptance is durable before execution startup. Not a delivery rejection. */
  startup?: "pending" | "started" | "failed";
  error?: string;
}

export interface ConversationSessionUpdate {
  conversationId: string;
  sessionId: string;
  preview: ConversationSessionPreview;
}

export interface ConversationRequest {
  id: string;
  fingerprint: string;
  receipt: ConversationReceipt;
  updatedAt: string;
}

export function employeeConversationId(employeeId: string): string {
  return `dm_${employeeId}`;
}
