import type { SpeechBackend } from "./speech-types.js";

export type LocalModelKind = "laya" | "speech";
export type ModelSetupPhase = "downloading" | "verifying" | "runtime" | "initializing" | "completed" | "failed" | "cancelled";
export interface ModelSetupOperation {
  id: number;
  action: "download" | "initialize";
  phase: ModelSetupPhase;
  message: string;
  received: number;
  total: number | null;
  error?: string;
}
export interface LocalModelStatus {
  kind: LocalModelKind;
  label: string;
  supported: boolean;
  reason: string | null;
  enabled: boolean;
  model: string;
  modelSize: number;
  downloaded: boolean;
  runtimeAvailable: boolean;
  initialized: boolean;
  busy: boolean;
  operation: ModelSetupOperation | null;
  hardware?: import("./decision-hardware.js").DecisionHardwareAssessment;
  decisionEmployeeId?: string;
}
export interface LocalModelsStatus { laya: LocalModelStatus; speech: LocalModelStatus; }
export interface ModelSetupInput {
  model?: string;
  backend?: "auto" | SpeechBackend;
}
