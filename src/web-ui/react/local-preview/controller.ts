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

/** Convert an HTTP loopback URL to its Wand proxy URL, or return null. */
export function localHttpPreviewHref(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) return null;
    const port = url.port || "80";
    return `/api/local-preview/127.0.0.1/${port}${url.pathname === "/" ? "/" : url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function normalizeLocalUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("请输入本地端口或地址。");
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
  if (!value.startsWith("/")) return null;
  return `/api/local-file/${base64UrlPath(value)}/`;
}

function normalizeLocalFile(input: string): string {
  const trimmed = input.trim();
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
      error: error instanceof Error ? error.message : "无法打开本地预览。",
    });
    return false;
  }
}

export const localPreviewController = {
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
      publish({ error: error instanceof Error ? error.message : "无法打开本地预览。" });
    }
  },
};

export const localPreviewStore = localPreviewController;
