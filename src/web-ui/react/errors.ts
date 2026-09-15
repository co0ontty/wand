/** React 层共享的异常文案工具。 */

/** 浏览器 fetch 失败时的通用文案，对用户没有信息量。 */
const NETWORK_FAILURE = "Failed to fetch";

/** 取异常文案；无 message 或仅是无信息量的网络错误时回落到 fallback。 */
export function describeError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message || error.message === NETWORK_FAILURE) return fallback;
  return error.message;
}

/** 取异常文案；无 message 时回落到 fallback。 */
export function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** 请求被 AbortController 取消（组件卸载 / 切换会话）。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** 控制器统一的失败快照：只带 message，供 overlay / 预览等场景使用。 */
export function failureOf(error: unknown, fallback: string): { message: string } {
  return { message: failureMessage(error, fallback) };
}
