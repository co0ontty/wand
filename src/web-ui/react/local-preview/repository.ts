/** Read-only readiness check before mounting an opaque-origin frame. An iframe's
 * load event also fires for 404/401 pages, so it is not evidence of success. */
export async function probeHtmlPreview(url: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { method: "HEAD", credentials: "same-origin",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (!response.ok) throw new Error(response.status === 404 ? "文件不存在或已移动" : response.status === 401 || response.status === 403 ? "没有访问权限或登录已失效" : "服务返回 HTTP " + response.status);
  if (!response.headers.get("content-type")?.includes("text/html")) throw new Error("目标不是可预览的 HTML 文件");
}
