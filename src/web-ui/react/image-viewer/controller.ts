export interface ImageViewerSnapshot {
  open: boolean;
  src: string;
  label: string;
  zoomed: boolean;
}

type Listener = () => void;

let snapshot: ImageViewerSnapshot = {
  open: false,
  src: "",
  label: "",
  zoomed: false,
};
const listeners = new Set<Listener>();

function publish(patch: Partial<ImageViewerSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

// src 来自工具输出（provider 的 image content block），只允许浏览器能直接取图的
// 形态，`javascript:` 之类的协议一律不进 <img>。
function isRenderableImageSrc(src: string): boolean {
  return src.startsWith("data:image/")
    || src.startsWith("blob:")
    || src.startsWith("/")
    || /^https?:\/\//i.test(src);
}

export const imageViewerController = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): ImageViewerSnapshot {
    return snapshot;
  },

  isOpen(): boolean {
    return snapshot.open;
  },

  close(): void {
    publish({ open: false, src: "", label: "", zoomed: false });
  },

  closeIfOpen(): boolean {
    if (!snapshot.open) return false;
    this.close();
    return true;
  },

  open(src: string, label = ""): boolean {
    const normalizedSrc = src.trim();
    if (!isRenderableImageSrc(normalizedSrc)) return false;
    publish({
      open: true,
      src: normalizedSrc,
      label: label.trim() || "图片",
      zoomed: false,
    });
    return true;
  },

  toggleZoom(): void {
    if (!snapshot.open) return;
    publish({ zoomed: !snapshot.zoomed });
  },
};
