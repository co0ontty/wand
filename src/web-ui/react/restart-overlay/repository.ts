import type {
  RestartOverlayConfig,
  RestartOverlayRepository,
  RestartOverlayRepositoryOptions,
} from "./types";

type FetchLike = typeof fetch;
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function normalizeRestartOverlayConfig(value: unknown): RestartOverlayConfig {
  const config = isRecord(value) ? value : {};
  return {
    serverInstanceId: text(config.serverInstanceId),
    packageVersion: text(config.packageVersion),
    currentVersion: text(config.currentVersion),
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
        text(record.error) || `服务尚未就绪（HTTP ${response.status}）。`,
        response.status,
      );
    }
    return normalizeRestartOverlayConfig(record);
  }
}

export const httpRestartOverlayRepository = new HttpRestartOverlayRepository();
