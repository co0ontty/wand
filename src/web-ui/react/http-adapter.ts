/** React 层共享的 JSON 请求工具。 */

/** 解析统一 JSON 回包；非 2xx 或带 error 字段时抛出用户可读的异常。 */
export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok || body.error) throw new Error(body.error || `请求失败（${response.status}）`);
  return body as T;
}

/** fetch + parseJsonResponse。 */
export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  return parseJsonResponse<T>(await fetch(url, init));
}

/** JSON 请求体 + content-type 的 RequestInit。 */
export function jsonBody(body: unknown, method = "POST"): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
