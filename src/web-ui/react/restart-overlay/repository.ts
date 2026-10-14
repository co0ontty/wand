import type {
  RestartOverlayConfig,
  RestartOverlayRepository,
  RestartOverlayRepositoryOptions,
} from "./types";
import { isRecord, stringValue } from "../json-utils";

type FetchLike = typeof fetch;
export function normalizeRestartOverlayConfig(value: unknown): RestartOverlayConfig {
  const config = isRecord(value) ? value : {};
  return {
    serverInstanceId: stringValue(config.serverInstanceId),
    packageVersion: stringValue(config.packageVersion),
    currentVersion: stringValue(config.currentVersion),
  };
}

export class RestartOverlayRepositoryError extends Error {
  constructor(message: string, public readonly status = 0) {
    super(message);
    this.name = "RestartOverlayRepositoryError";
  }
}

export class HttpRestartOverlayRepository implements RestartOverlayRepository {
  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}

  async loadConfig(
    options: RestartOverlayRepositoryOptions = {},
  ): Promise<RestartOverlayConfig> {
    const response = await this.fetchImpl("/api/config", {
      credentials: "same-origin",
      signal: options.signal,
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new RestartOverlayRepositoryError(
        `服务状态响应无效（HTTP ${response.status}）。`,
        response.status,
      );
    }
    const record = isRecord(value) ? value : {};
    if (!response.ok || typeof record.error === "string") {
      throw new RestartOverlayRepositoryError(
        stringValue(record.error) || `服务尚未就绪（HTTP ${response.status}）。`,
        response.status,
      );
    }
    const config = normalizeRestartOverlayConfig(record);
    if (options.expectedVersion) {
      // Older servers have no status endpoint; their readiness probe still works.
      const statusResponse = await this.fetchImpl("/api/update-status", {
        credentials: "same-origin", signal: options.signal, cache: "no-store",
      });
      if (statusResponse.ok) {
        const statusValue: unknown = await statusResponse.json();
        if (isRecord(statusValue) && statusValue.version === options.expectedVersion
          && isRecord(statusValue.status) && statusValue.status.phase === "failed") {
          config.updateFailure = stringValue(statusValue.status.message) || "更新失败，请刷新后重试。";
        }
      }
    }
    return config;
  }
}

export const httpRestartOverlayRepository = new HttpRestartOverlayRepository();
