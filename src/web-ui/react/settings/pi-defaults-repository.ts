import { jsonBody, requestJson } from "../http-adapter";
import type { PiSessionSettings, PiSessionSettingsPatch } from "../../../pi-session-settings.js";
import type { PiDefaultsSnapshot } from "./pi-defaults-panel";

const ENDPOINT = "/api/pi-settings/defaults";

/** 用户级 Pi 默认设置：与会话面板同一套 requestJson 边界，不在这里解释业务。 */
export const piDefaultsRepository = {
  load(signal?: AbortSignal): Promise<PiDefaultsSnapshot> {
    return requestJson(ENDPOINT, { credentials: "same-origin", cache: "no-store", signal });
  },
  save(patch: PiSessionSettingsPatch, signal?: AbortSignal): Promise<{ settings: PiSessionSettings }> {
    return requestJson(ENDPOINT, { ...jsonBody(patch, "PATCH"), credentials: "same-origin", signal });
  },
};
