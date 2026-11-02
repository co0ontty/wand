import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Alert, Button, Card, Flex, Spin, Tag, Typography } from "../react/design-library";
import { WandUiProvider } from "../react/theme";
import { WandIcon } from "../react/ui/icons";
import { getErrorMessage } from "../../error-utils.js";
import { reportClientError } from "../client-feedback.js";
import { HttpResponseError, parseJsonResponse } from "../react/http-adapter.js";

const roots = new Map<HTMLElement, Root>();

function paint(host: HTMLElement, view: React.ReactNode): void {
  for (const [node, root] of roots) {
    if (!node.isConnected) {
      root.unmount();
      roots.delete(node);
    }
  }
  let root = roots.get(host);
  if (!root) {
    root = createRoot(host);
    roots.set(host, root);
  }
  flushSync(() => root.render(<WandUiProvider>{view}</WandUiProvider>));
}

export function clearNoticeView(host: HTMLElement): void {
  const root = roots.get(host);
  if (root) {
    root.unmount();
    roots.delete(host);
  }
}

export function paintOfflineNotice(host: HTMLElement): void {
  paint(host, <Alert type="warning" showIcon title="当前处于离线状态，部分功能可能不可用。" />);
}

export function paintBootNotice(host: HTMLElement, error?: string, message?: string): void {
  paint(
    host,
    <Flex className="boot-loading" align="center" justify="center" style={{ height: "100%", padding: 24 }}>
      <Card className="boot-loading-card">
        {error ? (
          <Alert
            showIcon
            type="error"
            title={error}
            description={message}
            action={<Button onClick={() => location.reload()}>重试</Button>}
          />
        ) : (
          <Flex vertical align="center" gap="middle">
            <Spin />
            <Typography.Text>正在连接 Wand…</Typography.Text>
          </Flex>
        )}
      </Card>
    </Flex>
  );
}

export interface NotificationNoticeOptions {
  title: string;
  body?: string;
  type?: string;
  actionLabel?: string;
  onAction?: () => void;
  onClose?: () => void;
  duration?: number;
  onLayoutChange?: () => void;
}

function NotificationNoticeCard({
  title,
  body,
  type = "info",
  actionLabel,
  onAction,
  onClose,
  onLayoutChange,
}: NotificationNoticeOptions) {
  const [leaving, setLeaving] = React.useState<boolean>(false);

  React.useEffect(() => {
    onLayoutChange?.();
  }, [title, body, actionLabel, onLayoutChange]);

  const handleClose = () => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(() => {
      onClose?.();
    }, 150);
  };

  const handleAction = () => {
    onAction?.();
    handleClose();
  };

  const iconName: any =
    type === "success"
      ? "check"
      : type === "warning"
      ? "warning"
      : type === "error"
      ? "circleX"
      : "bell";

  return (
    <div
      className={`wand-notice-card wand-notification-card ${leaving ? "is-leaving" : ""}`}
      role="status"
    >
      <div className="wand-notice-header">
        <div className={`wand-notice-icon-wrapper ${type}`}>
          <WandIcon name={iconName} size={15} />
        </div>
        <div className="wand-notice-title-group">
          <div className="wand-notice-title">{title}</div>
          {body && <div className="wand-notice-subtitle">{body}</div>}
        </div>
        <Button
          type="text"
          size="small"
          className="wand-notice-close-btn notification-bubble-close"
          title="关闭"
          aria-label="关闭这条通知"
          icon={<WandIcon name="close" size={13} />}
          onClick={handleClose}
        />
      </div>

      {actionLabel && (
        <div className="wand-notice-footer">
          <div />
          <Button
            type="primary"
            size="small"
            className="wand-notice-action-btn"
            onClick={handleAction}
          >
            {actionLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

export interface UpdateNoticeOptions {
  current: string;
  latest: string;
  onClose?: () => void;
  onRestart?: (detached?: boolean, previousInstanceId?: string | null, version?: string | null) => void;
  onLayoutChange?: () => void;
}

function UpdateNoticeCard({ current, latest, onClose, onRestart, onLayoutChange }: UpdateNoticeOptions) {
  const [phase, setPhase] = React.useState<"idle" | "updating" | "restarting" | "failed">("idle");
  const [errorMessage, setErrorMessage] = React.useState<string>("");
  const [leaving, setLeaving] = React.useState<boolean>(false);

  React.useEffect(() => {
    onLayoutChange?.();
  }, [phase, errorMessage, onLayoutChange]);

  const handleClose = () => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(() => {
      onClose?.();
    }, 150);
  };

  const handleUpdate = async () => {
    if (phase === "updating" || phase === "restarting") return;
    setPhase("updating");
    setErrorMessage("");

    try {
      const res = await fetch("/api/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
      });
      const data = await parseJsonResponse<any>(res);

      if (data.detachedUpdate) {
        setPhase("restarting");
        onRestart?.(true, data.previousInstanceId || null, data.version || null);
        return;
      }

      if (data.restartRequired === false) {
        setPhase("idle");
        handleClose();
        return;
      }

      setPhase("restarting");
      try {
        const restartRes = await fetch("/api/restart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
        });
        await parseJsonResponse<any>(restartRes);
        onRestart?.(false);
      } catch (restartErr: unknown) {
        if (restartErr instanceof HttpResponseError && restartErr.status > 0) {
          setPhase("failed");
          setErrorMessage(getErrorMessage(restartErr, "重启失败，请重试。"));
          return;
        }
        onRestart?.(false);
      }
    } catch (err: unknown) {
      reportClientError("update_failed", err);
      setPhase("failed");
      setErrorMessage(
        err instanceof HttpResponseError
          ? getErrorMessage(err, "更新失败，请重试。")
          : "请检查网络连接后重试"
      );
    }
  };

  const currentVer = (current || "-").replace(/^v/, "");
  const latestVer = (latest || "-").replace(/^v/, "");

  let subtitle = "全新版本已准备就绪，点击下方按钮一键更新";
  if (phase === "updating") subtitle = "正在下载并安装新版本，请稍候…";
  else if (phase === "restarting") subtitle = "更新已完成，正在重启服务…";
  else if (phase === "failed") subtitle = errorMessage || "更新未完成，请重试";

  return (
    <div
      className={`wand-notice-card wand-update-card ${leaving ? "is-leaving" : ""}`}
      role="alert"
    >
      <div className="wand-notice-header">
        <div className="wand-notice-icon-wrapper update-icon">
          <WandIcon name="sparkle" size={16} />
        </div>
        <div className="wand-notice-title-group">
          <div className="wand-notice-title">发现新版本</div>
          <div
            className={`wand-notice-subtitle ${phase === "failed" ? "is-error" : ""}`}
            id="update-card-subtitle"
          >
            {subtitle}
          </div>
        </div>
        <Button
          type="text"
          size="small"
          className="wand-notice-close-btn update-card-close"
          title="稍后提醒"
          aria-label="稍后提醒"
          icon={<WandIcon name="close" size={13} />}
          onClick={handleClose}
        />
      </div>

      <div className="wand-notice-body">
        <div className="wand-update-version-row">
          <span className="wand-version-tag current">v{currentVer}</span>
          <span className="wand-version-arrow">→</span>
          <span className="wand-version-tag latest">v{latestVer}</span>
          <span className="wand-version-badge">NEW</span>
        </div>
        {phase === "updating" && (
          <div className="wand-notice-progress-bar active" id="update-card-progress">
            <div className="wand-notice-progress-indicator" />
          </div>
        )}
      </div>

      <div className="wand-notice-footer">
        <Button
          type="text"
          size="small"
          className="wand-notice-cancel-btn"
          disabled={phase === "updating" || phase === "restarting"}
          onClick={handleClose}
        >
          稍后提醒
        </Button>
        <Button
          type="primary"
          size="small"
          className="wand-notice-action-btn"
          id="update-bubble-action"
          loading={phase === "updating" || phase === "restarting"}
          disabled={phase === "restarting"}
          onClick={handleUpdate}
        >
          <span className="update-card-action-label">
            {phase === "updating"
              ? "更新中…"
              : phase === "restarting"
              ? "正在重启…"
              : phase === "failed"
              ? "重试"
              : "立即更新"}
          </span>
        </Button>
      </div>
    </div>
  );
}

export function paintNotificationNotice(host: HTMLElement, options: NotificationNoticeOptions): void {
  paint(host, <NotificationNoticeCard {...options} />);
}

export function paintUpdateNotice(
  host: HTMLElement,
  optionsOrCurrent: UpdateNoticeOptions | string,
  latest?: string
): void {
  const options: UpdateNoticeOptions =
    typeof optionsOrCurrent === "string"
      ? { current: optionsOrCurrent, latest: latest || "" }
      : optionsOrCurrent;
  paint(host, <UpdateNoticeCard {...options} />);
}

