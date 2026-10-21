import { notification } from "antd";
import * as React from "react";
import { usePortalContainer } from "./portal-context";
import { WandUiBoundary } from "../theme";
import { dismissToast, getToastEntries, subscribeToasts } from "./toast-queue";

/**
 * antd notification 的真实实现单独成块：只有队列里真的有 toast 时才下载，
 * 首屏 runtime 不再背着 notification/rc-notification。
 */
export function ToastRegion(): React.ReactElement {
  const portal = usePortalContainer();
  const config = React.useMemo(() => ({ getContainer: () => portal ?? document.body,
    placement: "topRight" as const, stack: { threshold: 3 } }), [portal]);
  const [api, holder] = notification.useNotification(config);
  const generation = React.useRef(0);
  React.useEffect(() => {
    const lease = ++generation.current;
    const shown = new Set<string>();
    const sync = (): void => {
      for (const id of shown) if (!getToastEntries().some(toast => toast.id === id)) { api.destroy(id); shown.delete(id); }
      for (const toast of getToastEntries()) {
        if (shown.has(toast.id)) continue;
        const remaining = toast.expiresAt === null ? 0 : toast.expiresAt - Date.now();
        if (toast.expiresAt !== null && remaining <= 0) { dismissToast(toast.id); continue; }
        shown.add(toast.id);
        api.open({ key: toast.id, title: toast.message, description: toast.options.description,
          type: toast.options.tone ?? "info", duration: remaining / 1000,
          onClose: () => {
            if (generation.current !== lease) return;
            shown.delete(toast.id);
            dismissToast(toast.id);
          } });
      }
    };
    const unsubscribe = subscribeToasts(sync);
    sync();
    return () => { generation.current++; unsubscribe(); api.destroy(); };
  }, [api]);
  return holder;
}

export function WandToastRegion(): React.ReactElement {
  return <WandUiBoundary><ToastRegion/></WandUiBoundary>;
}
