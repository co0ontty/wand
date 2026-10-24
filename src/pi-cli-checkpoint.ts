import type { StructuredRunnerTurnState } from "./structured-runner.js";

/** Internal SQLite materialization, never a client DTO or a replay instruction. */
export interface PiCliCheckpoint {
  version: 1;
  incarnationId: string;
  requestId: string;
  source: { file: string; dev: number; ino: number };
  /** Native-file byte position immediately after a fully parsed record. */
  offset: number;
  state: StructuredRunnerTurnState;
  primaryError: string | null;
}

export function validPiCliCheckpoint(value: unknown): value is PiCliCheckpoint {
  if (!value || typeof value !== "object") return false;
  const v = value as PiCliCheckpoint;
  return v.version === 1 && typeof v.incarnationId === "string" && typeof v.requestId === "string"
    && Number.isSafeInteger(v.offset) && v.offset >= 0
    && typeof v.source?.file === "string" && Number.isSafeInteger(v.source.dev) && Number.isSafeInteger(v.source.ino)
    && Array.isArray(v.state?.blocks) && typeof v.state.result === "string"
    && (v.primaryError === null || typeof v.primaryError === "string");
}
