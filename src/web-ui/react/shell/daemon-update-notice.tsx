import * as React from "react";
import { Flex, Popover, Typography } from "antd";
import { daemonMaintenanceMessage, type DaemonMaintenanceStatus } from "../../../daemon-maintenance-state.js";
import { jsonBody, requestJson } from "../http-adapter";
import { WandButton, WandIcon } from "../ui";
import { wandOverlay } from "../overlay-controller";
import { usePopupDismiss } from "../ui/popup-lifecycle";

/** Header status; detail on demand, manual interruption only after confirmation. */
export function DaemonUpdateNotice({ compact = false, visible = true }: { compact?: boolean; visible?: boolean }) {
  const [status, setStatus] = React.useState<DaemonMaintenanceStatus>({ pending: false, phase: "idle" });
  const [open, setOpen] = React.useState(false);
  const [working, setWorking] = React.useState(false);
  const [error, setError] = React.useState("");
  const generation = React.useRef(0);
  const mounted = React.useRef(true);
  const submitting = React.useRef(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  usePopupDismiss(open, () => { setOpen(false); trigger.current?.focus(); });
  React.useEffect(() => { if (!visible) setOpen(false); }, [visible]);
  React.useEffect(() => {
    let disposed = false;
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: AbortController | null = null;
    const refresh = async () => {
      if (disposed || active || document.hidden) return;
      if (timer) clearTimeout(timer);
      const controller = new AbortController();
      active = controller;
      const revision = generation.current;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const next = await requestJson<DaemonMaintenanceStatus>("/api/daemon-maintenance", {
          signal: controller.signal, cache: "no-store",
        });
        if (!disposed && revision === generation.current && !submitting.current && typeof next.pending === "boolean"
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
      mounted.current = false;
      if (timer) clearTimeout(timer);
      active?.abort();
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  const forceUpdate = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setOpen(false);
    try {
      const answer = await wandOverlay.dialog({
        title: "强制更新底层组件？",
        description: "将中断当前所有正在执行的终端和模型任务，并更新底层组件。会话历史与排队消息会保留，排队消息可能在更新后继续执行。",
        actions: [
          { label: "取消", value: false, autoFocus: true },
          { label: "中断并更新", value: true, kind: "danger" },
        ],
      });
      if (answer.dismissed !== false || !answer.action || !mounted.current) return;
      generation.current++;
      setWorking(true); setError("");
      const next = await requestJson<DaemonMaintenanceStatus>("/api/daemon-maintenance/force-update", {
        ...jsonBody({ confirmInterrupt: true }), signal: AbortSignal.timeout(60_000),
      });
      if (mounted.current) setStatus(next);
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error ? cause.message : "更新未完成，请稍后重试。"); setOpen(true); }
    } finally {
      submitting.current = false;
      if (mounted.current) setWorking(false);
    }
  };
  if (!status.pending) return null;
  const updating = working || status.phase === "updating";
  const label = updating ? "组件更新中" : status.phase === "retrying" ? "组件更新待重试" : "组件待更新";
  const action = <WandButton kind="ghost" size="small" loading={working} disabled={updating || status.canForceUpdate === false}
    data-daemon-update-action
    title={status.canForceUpdate === false ? "需要管理员权限" : undefined}
    onClick={() => void forceUpdate()}>强制更新</WandButton>;
  return <Flex className="daemon-update-notice" align="center" gap={4}>
    <Popover open={open} onOpenChange={setOpen} trigger="click" placement="bottomLeft"
      content={<Flex vertical gap="small" style={{ maxWidth: "min(280px, calc(100vw - 48px))" }}>
        <Typography.Text>{working ? "底层组件正在更新。无需操作。" : daemonMaintenanceMessage(status)}</Typography.Text>
        {error && <Typography.Text type="danger" role="alert">{error}</Typography.Text>}
        {compact && action}
      </Flex>}>
      <WandButton ref={trigger} kind="ghost" size="small" data-daemon-update-status aria-label={label} aria-expanded={open} title={label}>
        <WandIcon name="info" size={12}/><span hidden={compact} role="status" aria-live="polite">{label}</span>
      </WandButton>
    </Popover>
    {!compact && action}
  </Flex>;
}
