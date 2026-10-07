import { jsonBody, requestJson } from "../http-adapter";
import type { PiSessionSettings, PiSessionSettingsPatch, PiSettingsResponse } from "../../../pi-session-settings.js";

function endpoint(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/pi-settings`;
}

export const piSettingsRepository = {
  load(sessionId: string, signal: AbortSignal): Promise<PiSettingsResponse> {
    return requestJson(endpoint(sessionId), { credentials: "same-origin", cache: "no-store", signal });
  },
  save(sessionId: string, patch: PiSessionSettingsPatch, signal: AbortSignal): Promise<{ settings: PiSessionSettings }> {
    return requestJson(endpoint(sessionId), { ...jsonBody(patch, "PATCH"), credentials: "same-origin", signal });
  },
};
