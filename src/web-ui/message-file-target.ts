import { localFilePreviewHref } from "./react/local-preview/controller.js";

export interface MessageFileContext { cwd?: string; sessionId?: string; }
export interface MessageFileTarget { path: string; rawUrl: string; downloadUrl: string; previewUrl: string | null; }

/** Only explicit file references are resolved, never prose or arbitrary web URLs.
 * Relative references belong to their source session, not the active page URL. */
export function messageFileTarget(input: string, context: MessageFileContext = {}): MessageFileTarget | null {
  let path = input.trim();
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return null;
      path = decodeURIComponent(url.pathname);
    } catch { return null; }
  } else if (/^\/api\/local-file\/[A-Za-z0-9_-]+\/$/.test(path)) {
    try {
      const encoded = path.split("/")[3]!.replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      path = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!path.startsWith("/")) return null;
    } catch { return null; }
  } else if (/^\/api\/session-file\/[^/?#]+\?/.test(path)) {
    try {
      const url = new URL(path, "http://wand.invalid");
      const relative = url.searchParams.get("path") || "";
      if (relative.startsWith("/")) return null;
      return messageFileTarget(relative, { sessionId: decodeURIComponent(url.pathname.split("/")[3]!) });
    } catch { return null; }
  } else if (path.startsWith("/api/file-raw?")) {
    try { path = new URL(path, "http://wand.invalid").searchParams.get("path") || ""; }
    catch { return null; }
  } else {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(path)) return null;
    try { path = decodeURIComponent(path); } catch { /* literal percent */ }
  }
  path = path.replace(/#L\d+(?:C\d+)?$/i, "").replace(/:\d+(?::\d+)?$/, "");
  if (!path || /[\u0000-\u001f]/.test(path) || /^\/(?:api|android|macos)(?:\/|$)/.test(path)) return null;
  const html = /\.html?$/i.test(path);
  if (!path.startsWith("/")) {
    // No trusted context: keep the label rather than guessing the server cwd.
    if (!context.sessionId && !context.cwd?.startsWith("/")) return null;
    if (context.sessionId) {
      const route = "/api/session-file/" + encodeURIComponent(context.sessionId) + "?path=" + encodeURIComponent(path);
      return { path, rawUrl: route, downloadUrl: route + "&mode=download", previewUrl: html ? route + "&mode=preview" : null };
    }
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") { if (!parts.length) return null; parts.pop(); }
      else parts.push(part);
    }
    path = context.cwd!.replace(/\/$/, "") + "/" + parts.join("/");
  }
  const rawUrl = "/api/file-raw?path=" + encodeURIComponent(path);
  return { path, rawUrl, downloadUrl: rawUrl + "&download=1", previewUrl: html ? localFilePreviewHref(path) : null };
}
