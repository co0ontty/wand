import { localFilePreviewHref, localHttpPreviewHref } from "./react/local-preview/controller.js";
import { sameOriginServerLink } from "./server-link-url.js";

export interface MessageFileContext { cwd?: string; sessionId?: string; serverOrigin?: string; }
export interface MessageFileTarget { path: string; rawUrl: string; downloadUrl: string; previewUrl: string | null; }

/** A source basename plus a numeric location is not a custom URL scheme. */
export function isRelativeFileLocation(value: string): boolean {
  return /^[^:/?#]+\.[^:/?#]+:\d+(?::\d+)?(?:[?#]|$)/.test(value);
}

/** Only explicit file references are resolved, never prose or arbitrary web URLs.
 * Relative references belong to their source session, not the active page URL. */
export function messageFileTarget(input: string, context: MessageFileContext = {}): MessageFileTarget | null {
  let path = input.trim();
  if (!path || /[\u0000-\u001f]/.test(path)) return null;
  path = sameOriginServerLink(path, context.serverOrigin) ?? path;
  if (localHttpPreviewHref(path, context.serverOrigin)) return null;
  let search = "";
  let hash = "";
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return null;
      path = decodeURIComponent(url.pathname);
      search = url.search;
      hash = url.hash;
    } catch { return null; }
  } else if (path.startsWith("/api/local-file/")) {
    try {
      const url = new URL(path, "http://wand.invalid");
      const match = /^\/api\/local-file\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname);
      if (!match) return null;
      const encoded = match[1]!.replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      path = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!path.startsWith("/") && !path.startsWith("~/")) return null;
      url.searchParams.delete("__wand_file_action");
      // A preview root can be a file or a directory. Let the server resolve
      // nested resources instead of guessing which kind the encoded root is.
      if (match[2] && match[2] !== "/") {
        const resource = decodeURIComponent(match[2]);
        const rawUrl = url.pathname + url.search;
        const download = new URL(rawUrl, "http://wand.invalid");
        download.searchParams.set("__wand_file_action", "download");
        return { path: resource, rawUrl, downloadUrl: download.pathname + download.search,
          previewUrl: /\.html?(?::\d+(?::\d+)?)?$/i.test(resource) || resource.endsWith("/") ? rawUrl + url.hash : null };
      }
      if (!/\.html?(?::\d+(?::\d+)?)?$/i.test(path) && !path.endsWith("/")) {
        // The encoded root is not a file-type declaration: a dotted directory
        // and an ordinary PDF both use this shape. Metadata resolves the real
        // served file (including a directory's index) before the viewer chooses.
        const rawUrl = url.pathname + url.search + url.hash;
        url.searchParams.set("__wand_file_action", "download");
        return { path, rawUrl, downloadUrl: url.pathname + url.search, previewUrl: null };
      }
      search = url.search;
      hash = url.hash;
    } catch { return null; }
  } else if (/^\/api\/session-file\/[^/?#]+\?/.test(path)) {
    try {
      const url = new URL(path, "http://wand.invalid");
      if (!/^\/api\/session-file\/[^/]+$/.test(url.pathname) || url.searchParams.getAll("path").length !== 1) return null;
      path = url.searchParams.get("path") || "";
      if (path.startsWith("/") || (/^[a-z][a-z\d+.-]*:/i.test(path) && !isRelativeFileLocation(path))) return null;
      context = { sessionId: decodeURIComponent(url.pathname.split("/")[3]!) };
      search = url.searchParams.get("search") || "";
      hash = url.hash;
    } catch { return null; }
  } else if (/^\/api\/file-(?:raw|preview)\?/.test(path)) {
    try {
      const url = new URL(path, "http://wand.invalid");
      if (url.searchParams.getAll("path").length !== 1) return null;
      path = url.searchParams.get("path") || "";
      search = url.searchParams.get("search") || "";
      hash = url.hash;
    }
    catch { return null; }
  } else {
    if (/^(?:\/\/|#)/.test(path) || (/^[a-z][a-z\d+.-]*:/i.test(path) && !isRelativeFileLocation(path))) return null;
    // Split the URI before decoding: an encoded # or ? belongs to the filename.
    const fragment = path.indexOf("#");
    if (fragment >= 0) { hash = path.slice(fragment); path = path.slice(0, fragment); }
    const query = path.indexOf("?");
    if (query >= 0) { search = path.slice(query); path = path.slice(0, query); }
    try { path = decodeURIComponent(path); } catch { /* literal percent */ }
  }
  if (search && (!search.startsWith("?") || /[\u0000-\u001f]/.test(search))) return null;
  if (/^#L\d+(?:C\d+)?$/i.test(hash)) hash = "";
  if (!path || /[\u0000-\u001f]/.test(path) || /^\/(?:api|android|macos)(?:\/|$)/.test(path)) return null;
  // Keep colon suffixes verbatim. Read routes try the exact filename before a
  // source-location fallback, since report.html:12 can also be a real filename.
  const directory = path.endsWith("/");
  const html = /\.html?(?::\d+(?::\d+)?)?$/i.test(path) || directory;
  if (!path.startsWith("/") && !path.startsWith("~/")) {
    // No trusted context: keep the label rather than guessing the server cwd.
    if (!context.sessionId && !context.cwd?.startsWith("/")) return null;
    if (context.sessionId) {
      const route = "/api/session-file/" + encodeURIComponent(context.sessionId) + "?path=" + encodeURIComponent(path);
      return { path, rawUrl: route, downloadUrl: route + "&mode=download",
        previewUrl: html ? route + "&mode=preview" + (search ? "&search=" + encodeURIComponent(search) : "") + hash : null };
    }
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") { if (!parts.length) return null; parts.pop(); }
      else parts.push(part);
    }
    path = context.cwd!.replace(/\/$/, "") + "/" + parts.join("/");
  }
  if (directory) {
    if (!path.endsWith("/")) path += "/";
    const rawUrl = localFilePreviewHref(path)!;
    return { path, rawUrl, downloadUrl: rawUrl + "?__wand_file_action=download", previewUrl: rawUrl + search + hash };
  }
  const rawUrl = "/api/file-raw?path=" + encodeURIComponent(path);
  return { path, rawUrl, downloadUrl: rawUrl + "&download=1",
    previewUrl: html ? localFilePreviewHref(path)! + search + hash : null };
}

/** Metadata and large-file fallbacks use the same source-bound route. */
export function messageFileMetadataUrl(input: string): string {
  if (/^\/api\/(?:session-file|local-file)\//.test(input)) {
    const url = new URL(input, "http://wand.invalid");
    url.searchParams.set(input.startsWith("/api/local-file/") ? "__wand_file_action" : "mode", "metadata");
    return url.pathname + url.search;
  }
  const path = input.startsWith("/api/file-raw?") ? new URL(input, "http://wand.invalid").searchParams.get("path") ?? input : input;
  return "/api/file-preview?path=" + encodeURIComponent(path);
}

/** Metadata paths are decoded filesystem names, not URLs. A forwarded HTML
 * resource keeps its original root and navigation after metadata resolution. */
export function resolvedMessageFileTarget(path: string, source?: string): MessageFileTarget | null {
  const target = messageFileTarget("/api/file-raw?path=" + encodeURIComponent(path));
  return target?.previewUrl && source?.startsWith("/api/local-file/")
    ? { ...target, previewUrl: source } : target;
}
