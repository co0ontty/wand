import * as React from "react";

/**
 * 服务端锚点驱动的展示时钟：只在 running 期间每秒推进一次「读数」，
 * 时刻本身来自服务端快照（turnStartedAt / lastActivityAt），本 hook 不产生运行事实。
 * 非 running、组件卸载即停表；页面切回可见时立刻重算一次，避免后台节流留下过期读数。
 */
export function useServerAnchoredClock(running: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const resync = (): void => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    document.addEventListener("visibilitychange", resync);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resync);
    };
  }, [running]);
  return now;
}
