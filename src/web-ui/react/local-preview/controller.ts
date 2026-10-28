import { sameOriginServerLink } from "../../server-link-url.js";

export type LocalPreviewMode = "url" | "file";

export interface LocalPreviewSnapshot {
  open: boolean;
  mode: LocalPreviewMode;
  value: string;
  previewUrl: string | null;
  sourceLabel: string;
  error: string | null;
}

type Listener = () => void;

let snapshot: LocalPreviewSnapshot = {
  open: false,
  mode: "url",
  value: "",
  previewUrl: null,
  sourceLabel: "",
  error: null,
};
const listeners = new Set<Listener>();

function publish(patch: Partial<LocalPreviewSnapshot> = {}): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname.toLowerCase());
}

/** Accept a loopback HTTP address or an already-forwarded Wand preview URL. */
export function localHttpPreviewHref(input: string, origin?: string): string | null {
  try {
    let value = sameOriginServerLink(input.trim(), origin) ?? input.trim();
    if (/[\u0000-\u001f]/.test(value)) return null;
    if (value.startsWith("/api/local-preview/")) {
      const url = new URL(value, "http://wand.invalid");
      const match = /^\/api\/local-preview\/([^/]+)\/(\d{1,5})(\/.*)?$/.exec(url.pathname);
      if (!match || !isLoopbackHostname(match[1]!) || Number(match[2]) < 1 || Number(match[2]) > 65535) return null;
      const host = match[1]!.includes(":") ? "::1" : "127.0.0.1";
      return `/api/local-preview/${host}/${Number(match[2])}${match[3] || "/"}${url.search}${url.hash}`;
    }
    if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i.test(value)) value = "http://" + value;
    const url = new URL(value);
    if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname) || url.username || url.password) return null;
    const port = url.port || "80";
    if (Number(port) < 1) return null;
    const host = url.hostname.includes(":") ? "::1" : "127.0.0.1";
    return `/api/local-preview/${host}/${port}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function normalizeLocalUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("请输入本地端口或地址。");
  if (sameOriginServerLink(trimmed)?.startsWith("/api/local-preview/") || trimmed.startsWith("/api/local-preview/")) {
    const previewUrl = localHttpPreviewHref(trimmed);
    if (!previewUrl) throw new Error("只允许预览本机（localhost）HTTP 服务。");
    return previewUrl;
  }
  if (/^\d{1,5}$/.test(trimmed)) {
    const port = Number(trimmed);
    if (port < 1 || port > 65535) throw new Error("端口号必须是 1–65535。");
    return `/api/local-preview/127.0.0.1/${port}/`;
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const previewUrl = localHttpPreviewHref(withScheme);
  if (!previewUrl) throw new Error("只允许预览本机（localhost）HTTP 服务。");
  return previewUrl;
}

function base64UrlPath(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Convert a server-side HTML file or directory to its local-file preview URL. */
export function localFilePreviewHref(input: string): string | null {
  const value = input.trim();
  if (!value.startsWith("/") && !value.startsWith("~/")) return null;
  return `/api/local-file/${base64UrlPath(value)}/`;
}

function normalizeLocalFile(input: string): string {
  let trimmed = sameOriginServerLink(input.trim()) ?? input.trim();
  if (isArtifactPreviewUrl(trimmed)) return trimmed;
  if (/^file:/i.test(trimmed)) {
    const url = new URL(trimmed);
    if (url.hostname && url.hostname !== "localhost") throw new Error("只允许打开服务端本地文件。");
    return (localFilePreviewHref(decodeURIComponent(url.pathname)) ?? "") + url.search + url.hash;
  }
  if (!trimmed) throw new Error("请输入文件或目录路径。");
  return localFilePreviewHref(trimmed) ?? (() => { throw new Error("请输入服务端文件路径。"); })();
}

function openFile(value: string): boolean {
  try {
    publish({
      open: true,
      mode: "file",
      value,
      previewUrl: normalizeLocalFile(value),
      sourceLabel: value.trim(),
      error: null,
    });
    return true;
  } catch (error) {
    publish({
      open: true,
      mode: "file",
      value,
      previewUrl: null,
      error: error instanceof Error ? error.message : "无法打开本地文件预览。",
    });
    return false;
  }
}

function openUrl(value: string): boolean {
  try {
    publish({
      open: true,
      mode: "url",
      value,
      previewUrl: normalizeLocalUrl(value),
      sourceLabel: value.trim(),
      error: null,
    });
    return true;
  } catch (error) {
    publish({
      open: true,
      mode: "url",
      value,
      previewUrl: null,
      error: error instanceof Error ? error.message : "无法打开本地预览。",
    });
    return false;
  }
}

export function isArtifactPreviewUrl(value: string): boolean {
  value = sameOriginServerLink(value) ?? value;
  if (!value.startsWith("/api/") || /[\u0000-\u001f]/.test(value)) return false;
  try {
    const url = new URL(value, "http://wand.invalid");
    if (/^\/api\/local-file\/[A-Za-z0-9_-]+(?:\/.*)?$/.test(url.pathname)) return true;
    const path = url.searchParams.get("path");
    return /^\/api\/session-file\/[^/]+$/.test(url.pathname) && !!path && !path.startsWith("/") &&
      url.searchParams.getAll("path").length === 1 && url.searchParams.get("mode") === "preview";
  } catch { return false; }
}

export const localPreviewController = {
  openPreview(previewUrl: string, label = "HTML 预览"): boolean {
    if (!isArtifactPreviewUrl(previewUrl)) return false;
    publish({ open: true, mode: "file", value: previewUrl, previewUrl, sourceLabel: label, error: null });
    return true;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): LocalPreviewSnapshot {
    return snapshot;
  },

  isOpen(): boolean {
    return snapshot.open;
  },

  closeIfOpen(): boolean {
    if (!snapshot.open) return false;
    this.close();
    return true;
  },

  show(value = ""): void {
    publish({ open: true, value, error: null });
  },

  close(): void {
    publish({ open: false, error: null });
  },

  setMode(mode: LocalPreviewMode): void {
    if (mode === snapshot.mode) return;
    publish({ mode, error: null });
  },

  setValue(value: string): void {
    publish({ value, error: null });
  },

  openUrl,
  openFile,

  submit(): void {
    try {
      const previewUrl = snapshot.mode === "url"
        ? normalizeLocalUrl(snapshot.value)
        : normalizeLocalFile(snapshot.value);
      publish({
        previewUrl,
        sourceLabel: snapshot.value.trim(),
        error: null,
      });
    } catch (error) {
      publish({ previewUrl: null, error: error instanceof Error ? error.message : "无法打开本地预览。" });
    }
  },
};
