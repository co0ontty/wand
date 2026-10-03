import type { TeamReportFile } from "./types.js";
import type { AgentActivityState } from "./mission-types.js";

/** Read-only, bounded presentation of one run; never a second task status owner. */
export interface AiTeamDeliveryFile {
  stepId: string;
  seq: number;
  title: string;
  memberId: string;
  memberName: string;
  file: TeamReportFile;
}

export interface AiTeamDeliveryHandoff {
  stepId: string;
  seq: number;
  title: string;
  memberId: string;
  memberName: string;
  status: "running" | "queued";
  state?: AgentActivityState;
  sessionId: string | null;
  /** Existing dependency names, not a guessed next assignment. */
  waitingFor: string[];
}

export interface AiTeamDeliveryAttention {
  kind: "approval" | "reply" | "failure" | "stopped";
  message: string;
}

export interface AiTeamDeliverySummary {
  runId: string;
  /** Source run timestamp, not the time of GET; clients retain existing freshness guards. */
  updatedAt: string;
  headline: string;
  /** Only a completed run's recorded leader statement, not AI re-summarized verification. */
  conclusion: string | null;
  files: AiTeamDeliveryFile[];
  totalFiles: number;
  handoffs: AiTeamDeliveryHandoff[];
  totalHandoffs: number;
  attention: AiTeamDeliveryAttention | null;
}
