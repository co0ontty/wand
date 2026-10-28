export class NonHtmlPreviewResponse extends Error {
  constructor() { super("目标不是可预览的 HTML 文件"); this.name = "NonHtmlPreviewResponse"; }
}

/** Read-only readiness check before mounting an opaque-origin frame. An iframe's
 * load event also fires for 404/401 pages, so it is not evidence of success. */
export async function probeHtmlPreview(url: string, signal: AbortSignal): Promise<void> {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  let response = await fetch(url, { method: "HEAD", credentials: "same-origin", signal: boundedSignal });
  // Some development servers only implement GET. Cancel its body once headers
  // arrive: readiness must not download an unbounded document into memory.
  if (response.status === 405 || response.status === 501) {
    response = await fetch(url, { credentials: "same-origin", signal: boundedSignal });
    await response.body?.cancel();
  }
  if (!response.ok) throw new Error(response.status === 404 ? "文件或页面不存在，可能已移动" : response.status === 401 || response.status === 403 ? "没有访问权限或登录已失效" : response.status === 502 ? "本地服务未启动或端口不可用。请启动服务后重试；已有 HTML 文件可切换到本地文件预览。" : "服务返回 HTTP " + response.status);
  if (!response.headers.get("content-type")?.includes("text/html")) throw new NonHtmlPreviewResponse();
}
