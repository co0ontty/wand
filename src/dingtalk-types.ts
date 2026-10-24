import type { WandTaskAgent } from "./task-types.js";

export type DingTalkBindingState = "creating" | "configuring" | "joining" | "verifying" | "ready" | "paused" | "restricted" | "failed" | "unknown";
export interface DingTalkAccount { id: string; corpId: string; userId: string; name: string; corpName: string }
export interface DingTalkGroup {
  id: string; accountId: string; corpId: string; externalId: string; name: string; conversationId: string;
  syncState: "connecting" | "live" | "at_only" | "disconnected" | "paused";
  syncError?: string; historyComplete: boolean; updatedAt: string;
}
export interface DingTalkRobot {
  id: string; corpId: string; employeeId: string; accountId: string; name: string;
  state: DingTalkBindingState; taskId?: string; appId?: string; robotCode?: string; clientId?: string;
  versionId?: string; error?: string; updatedAt: string;
}
export interface DingTalkBinding {
  id: string; groupId: string; employeeId: string; robotId: string; state: DingTalkBindingState;
  allowedUsers: string[]; ownerUserId?: string; generation?: string; fixedAgent?: WandTaskAgent; error?: string; removedAt?: string; verifiedAt?: string; updatedAt: string;
}
export interface DingTalkExternalConversation {
  provider: "dingtalk"; groupId: string; corpId: string; externalId: string;
  syncState: DingTalkGroup["syncState"]; syncError?: string; historyComplete: boolean;
  bindings: Array<Pick<DingTalkBinding, "id" | "employeeId" | "state" | "fixedAgent" | "error">>;
}
export interface DingTalkSelection { accountId: string; groupIds: string[]; employeeIds: string[] }
export interface DingTalkPlan extends DingTalkSelection {
  id: string; expiresAt: string; groups: Array<{ id: string; name: string }>;
  employees: Array<{ id: string; name: string; robotName: string; appName: string; candidateIndex?: number; agent?: WandTaskAgent }>;
  pairs: Array<{ groupId: string; employeeId: string; existing: boolean }>;
  newRobots: number; warning: string;
}
export interface DingTalkJob {
  id: string; planId: string; state: "running" | "done" | "partial" | "unknown";
  bindingIds: string[]; bindingGenerations?: Record<string, string | undefined>; updatedAt: string;
}
export interface DingTalkDiscoveryGroup { id: string; name: string; memberCount?: number }
export interface DingTalkMessage {
  id: string; groupId: string; senderId: string; senderName: string; text: string; createdAt: string;
  senderIsBot: boolean; mentionedRobotCodes: string[]; recalled?: boolean;
}
export interface DingTalkRun {
  id: string; groupId: string; bindingId: string; bindingGeneration?: string; incomingId: string; sessionId?: string;
  state: "accepted" | "running" | "completed" | "failed" | "unknown" | "delivered";
  text?: string; error?: string; delivery?: "pending" | "sending" | "sent" | "unknown" | "none"; updatedAt: string;
}
export interface DingTalkStatus {
  installed: boolean; version?: string; accounts: DingTalkAccount[];
  groups: DingTalkGroup[]; bindings: DingTalkBinding[]; robots: DingTalkRobot[]; jobs: DingTalkJob[];
  /** Operational diagnostics, not the transport-level error envelope. Missing DWS is a normal state. */
  diagnostic?: string;
}
export type DingTalkRecordKind = "group" | "binding" | "robot" | "plan" | "job" | "run" | "request" | "event";
