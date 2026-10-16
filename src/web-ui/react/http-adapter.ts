/** React 层共享的 JSON 请求工具。 */
import { isRecord } from "./json-utils";
import { feedbackFeatureForPath, reportClientError, type ClientFeedbackFeature } from "../client-feedback";

export class HttpResponseError extends Error {
  constructor(message: string, public readonly status: number, feature?: ClientFeedbackFeature) {
    super(message);
    this.name = "HttpResponseError";
    if (status >= 500) reportClientError("http_5xx", this, feature);
  }
}

/** Idempotency IDs also work on LAN HTTP, where randomUUID requires HTTPS but
 * getRandomValues remains available. These IDs carry no authentication data. */
export function createRequestId(): string {
  const random = globalThis.crypto;
  if (typeof random?.randomUUID === "function") return random.randomUUID();
  if (typeof random?.getRandomValues !== "function") throw new Error("当前浏览器无法生成请求标识，请使用支持安全随机数的浏览器。");
  const bytes = random.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
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
      response.status, feedbackFeatureForPath(response.url),
    );
  }
  const message = isRecord(body) && typeof body.error === "string" ? body.error : "";
  if (!response.ok || message) {
    throw new HttpResponseError(message || `请求失败（${response.status}）`, response.status, feedbackFeatureForPath(response.url));
  }
  if (body === null || typeof body !== "object") {
    throw new HttpResponseError("服务端返回了无效的数据，请重试。", response.status, feedbackFeatureForPath(response.url));
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
