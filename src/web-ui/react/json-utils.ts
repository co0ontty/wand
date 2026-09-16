export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

export function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function readJson(response: Response): Promise<JsonRecord> {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : { error: "服务端返回了无效的数据，请重试。" };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return { error: response.ok ? "服务端返回了无效的数据，请重试。" : `请求失败（${response.status}）` };
  }
}
