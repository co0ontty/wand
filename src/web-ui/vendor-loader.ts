/** Optional browser libraries keep their versioned URLs in the server-rendered shell. */
const pending = new Map<string, Promise<void>>();

function loadVendor(name: "xterm" | "qrcode", ready: () => boolean): Promise<void> {
  if (ready()) return Promise.resolve();
  const existing = pending.get(name);
  if (existing) return existing;
  const src = document.querySelector<HTMLMetaElement>(`meta[name="wand-${name}-script"]`)?.content;
  if (!src) return Promise.reject(new Error("组件地址不可用，请刷新页面后重试。"));
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src; script.async = true;
    let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true; clearTimeout(timer); script.onload = null; script.onerror = null;
      if (error) { script.remove(); reject(error); } else resolve();
    };
    const timer = setTimeout(() => finish(new Error("组件加载超时，请重试。")), 20_000);
    script.onload = () => finish(ready() ? undefined : new Error("组件加载未完成，请重试。"));
    script.onerror = () => finish(new Error("组件加载失败，请重试。"));
    document.head.appendChild(script);
  }).finally(() => { if (pending.get(name) === promise) pending.delete(name); });
  pending.set(name, promise);
  return promise;
}

export async function ensureQrCodeLibrary(): Promise<any> {
  const globals = globalThis as { QRCodeLib?: { toCanvas?: unknown } };
  await loadVendor("qrcode", () => typeof globals.QRCodeLib?.toCanvas === "function");
  return globals.QRCodeLib;
}

export async function ensureTerminalLibrary(): Promise<void> {
  await loadVendor("xterm", () => {
    const library = (globalThis as { XTermLib?: { Terminal?: unknown; FitAddon?: unknown } }).XTermLib;
    return typeof library?.Terminal === "function" && typeof library.FitAddon === "function";
  });
}
