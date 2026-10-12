export interface ImageViewerItem {
  src: string;
  label?: string;
}

export interface ImageViewerSnapshot {
  open: boolean;
  src: string;
  label: string;
  items: ReadonlyArray<ImageViewerItem>;
  current: number;
}

type Listener = () => void;

let snapshot: ImageViewerSnapshot = {
  open: false,
  src: "",
  label: "",
  items: [],
  current: 0,
};
const listeners = new Set<Listener>();
let returnFocus: (() => void) | undefined;

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
  afterClosed(): void {
    if (snapshot.open) return;
    const restore = returnFocus;
    returnFocus = undefined;
    restore?.();
  },

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
    publish({ open: false, src: "", label: "", items: [], current: 0 });
  },

  closeIfOpen(): boolean {
    if (!snapshot.open) return false;
    this.close();
    return true;
  },

  open(src: string, label = ""): boolean {
    return this.openGroup([{ src, label }]);
  },

  openGroup(items: ReadonlyArray<ImageViewerItem>, current = 0, onClosed?: () => void): boolean {
    const selected = items[current];
    if (!Number.isInteger(current) || !selected || !isRenderableImageSrc(selected.src.trim())) return false;
    const normalized = items.map(item => ({ src: item.src.trim(), label: item.label?.trim() || "图片" }))
      .filter(item => isRenderableImageSrc(item.src));
    // Index by position so repeated URLs remain separate gallery entries.
    const selectedIndex = items.slice(0, current).filter(item => isRenderableImageSrc(item.src.trim())).length;
    returnFocus = onClosed;
    publish({
      open: true,
      items: normalized,
      current: selectedIndex,
      src: normalized[selectedIndex].src,
      label: normalized[selectedIndex].label,
    });
    return true;
  },

  select(current: number): void {
    const item = snapshot.items[current];
    if (!snapshot.open || !Number.isInteger(current) || !item) return;
    publish({ current, src: item.src, label: item.label || "图片" });
  },
};
