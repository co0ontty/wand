import { requestJson } from "../http-adapter";
import type { PiExecutionResponse } from "../../../pi-execution-types.js";

/** Read the executor's snapshot; rendering never guesses or mutates run state. */
export function loadPiExecution(sessionId: string, toolId: string, signal: AbortSignal): Promise<PiExecutionResponse> {
  return requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/pi-execution/${encodeURIComponent(toolId)}`,
    { credentials: "same-origin", cache: "no-store", signal });
}
