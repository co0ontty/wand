import * as React from "react";
import { getToastEntries, subscribeToasts } from "./toast-queue";
import { WandUiBoundary } from "../theme";

export {
  showWandToast,
  type WandToastHandle,
  type WandToastOptions,
  type WandToastTone,
} from "./toast-queue";

/**
 * Toast 宿主：队列与 antd 实现分离，队列里真的有反馈时才下载 notification。
 * 首屏 runtime 因此不再包含 antd/rc-notification。
 */
export function WandToastRegion() {
  const [Region, setRegion] = React.useState<React.ComponentType | null>(null);
  React.useEffect(() => {
    if (Region) return;
    let alive = true;
    let pending = false;
    const load = (): void => {
      if (pending) return;
      pending = true;
      void import("./toast-region").then(module => {
        pending = false;
        if (alive) setRegion(() => module.WandToastRegion);
      }, () => { pending = false; });
    };
    // 只有队列非空才需要真正的 notification 实现；队列里已有反馈时同样要加载
    // （普通浏览器模块可以在 React 区域挂载前先排队）。
    const unsubscribe = subscribeToasts(() => { load(); });
    if (getToastEntries().length > 0) load();
    return () => { alive = false; unsubscribe(); };
  }, [Region]);
  return <WandUiBoundary>{Region ? <Region/> : null}</WandUiBoundary>;
}
