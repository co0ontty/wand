import { notification } from "antd";
import * as React from "react";
import { usePortalContainer } from "./portal-context";
import { WandUiBoundary } from "../theme";

export type WandToastTone = "info" | "success" | "warning" | "error";
export interface WandToastOptions { description?: string; tone?: WandToastTone; duration?: number; }
export interface WandToastHandle { readonly id: string; dismiss(): void; }
type ToastEntry = { id: string; message: string; options: WandToastOptions; expiresAt: number | null };
const queue = new Map<string, ToastEntry>();
const listeners = new Set<() => void>();
let serial = 0;
const notify = (): void => { for (const listener of listeners) listener(); };
/** Plain browser modules may queue feedback before the React region mounts. */
export function showWandToast(message: string, options: WandToastOptions = {}): WandToastHandle {
  for (const [key, toast] of queue) if (toast.expiresAt !== null && toast.expiresAt <= Date.now()) queue.delete(key);
  while (queue.size >= 20) queue.delete(queue.keys().next().value!);
  const id = `wand-toast-${++serial}`;
  const duration = options.duration ?? 3200;
  queue.set(id, { id, message, options, expiresAt: duration > 0 ? Date.now() + duration : null });
  notify();
  return { id, dismiss() { queue.delete(id); notify(); } };
}
export function WandToastRegion() {
  return <WandUiBoundary><ToastRegion/></WandUiBoundary>;
}
function ToastRegion() {
  const portal = usePortalContainer();
  const config = React.useMemo(() => ({ getContainer: () => portal ?? document.body,
    placement: "topRight" as const, stack: { threshold: 3 } }), [portal]);
  const [api, holder] = notification.useNotification(config);
  const generation = React.useRef(0);
  React.useEffect(() => {
    const lease = ++generation.current;
    const shown = new Set<string>();
    const sync = (): void => {
      for (const id of shown) if (!queue.has(id)) { api.destroy(id); shown.delete(id); }
      for (const [id, toast] of queue) {
        if (shown.has(id)) continue;
        const remaining = toast.expiresAt === null ? 0 : toast.expiresAt - Date.now();
        if (toast.expiresAt !== null && remaining <= 0) { queue.delete(id); continue; }
        shown.add(id);
        api.open({ key: id, title: toast.message, description: toast.options.description,
          type: toast.options.tone ?? "info", duration: remaining / 1000,
          onClose: () => {
            if (generation.current !== lease) return;
            shown.delete(id); queue.delete(id);
          } });
      }
    };
    listeners.add(sync); sync();
    return () => { generation.current++; listeners.delete(sync); api.destroy(); };
  }, [api]);
  return holder;
}
