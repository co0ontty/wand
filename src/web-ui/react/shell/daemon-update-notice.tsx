import * as React from "react";
import { Alert } from "antd";
import { daemonMaintenanceMessage, type DaemonMaintenanceStatus } from "../../../daemon-maintenance-state.js";
import { requestJson } from "../http-adapter";

/** Persistent, quiet status. No toast, dismissal, countdown or manual restart action. */
export function DaemonUpdateNotice() {
  const [status, setStatus] = React.useState<DaemonMaintenanceStatus>({ pending: false, phase: "idle" });
  React.useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: AbortController | null = null;
    const refresh = async () => {
      if (disposed || active || document.hidden) return;
      if (timer) clearTimeout(timer);
      const controller = new AbortController();
      active = controller;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const next = await requestJson<DaemonMaintenanceStatus>("/api/daemon-maintenance", {
          signal: controller.signal, cache: "no-store",
        });
        if (!disposed && typeof next.pending === "boolean"
          && ["idle", "waiting", "updating", "retrying"].includes(next.phase)) setStatus(next);
      } catch { /* Preserve the last confirmed notice across transient disconnects. */ }
      finally {
        clearTimeout(timeout);
        active = null;
        if (!disposed) timer = setTimeout(() => void refresh(), 15_000);
      }
    };
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", visible);
    void refresh();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      active?.abort();
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  if (!status.pending) return null;
  return <Alert className="daemon-update-notice" type="info" showIcon
    title={daemonMaintenanceMessage(status)} role="status" aria-live="polite" />;
}
