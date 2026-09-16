/** React 层共享的 JSON 请求工具。 */
import { isRecord } from "./json-utils";

export class HttpResponseError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "HttpResponseError";
  }
}

/** 解析统一 JSON 回包；非 2xx 或带 error 字段时抛出用户可读的异常。 */
export async function parseJsonResponse<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // Cancellation must retain its identity so controllers can ignore stale requests.
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new HttpResponseError(
      response.ok ? "服务端返回了无效的数据，请重试。" : `请求失败（${response.status}）`,
      response.status,
    );
  }
  const message = isRecord(body) && typeof body.error === "string" ? body.error : "";
  if (!response.ok || message) {
    throw new HttpResponseError(message || `请求失败（${response.status}）`, response.status);
  }
  if (body === null || typeof body !== "object") {
    throw new HttpResponseError("服务端返回了无效的数据，请重试。", response.status);
  }
  return body as T;
}

/** fetch + parseJsonResponse。 */
export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new HttpResponseError("无法连接服务。请检查网络或确认 Wand 服务正在运行，然后重试。", 0);
  }
  return parseJsonResponse<T>(response);
}

/** JSON 请求体 + content-type 的 RequestInit。 */
export function jsonBody(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
