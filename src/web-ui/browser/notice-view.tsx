import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Alert, Button, Card, Flex, Spin, Tag, Typography, theme } from "antd";
import { WandUiProvider } from "../react/theme";
import { WandIcon, type WandIconName } from "../react/ui/icons";

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
  paint(host, <Flex className="boot-loading" align="center" justify="center" style={{ height: "100%", padding: 24 }}>
    <Card className="boot-loading-card">{error ? <Alert showIcon type="error" title={error}
      description={message} action={<Button onClick={() => location.reload()}>重试</Button>} />
      : <Flex vertical align="center" gap="middle"><Spin /><Typography.Text>正在连接 Wand…</Typography.Text></Flex>}
    </Card>
  </Flex>);
}

export interface NotificationNoticeOptions {
  title: string;
  body?: string;
  type?: string;
  actionLabel?: string;
  onAction?: () => void;
  onClose: () => void;
}

export interface UpdateNoticeOptions {
  current: string;
  latest: string;
  phase: "idle" | "updating" | "restarting" | "complete" | "failed";
  message?: string;
  retryRestart?: boolean;
  onClose: () => void;
  onUpdate: () => void;
}

function NoticeCard({ title, body, icon, tone = "info", onClose, children }: {
  title: string;
  body?: string;
  icon: WandIconName;
  tone?: string;
  onClose: () => void;
  children?: React.ReactNode;
}): React.ReactElement {
  const { token } = theme.useToken();
  const color = tone === "warning" ? token.colorWarning : tone === "success" ? token.colorSuccess
    : tone === "error" ? token.colorError : token.colorPrimary;
  return <Card size="small" variant="borderless" className="wand-notice-card"
    style={{ boxShadow: token.boxShadowSecondary }} role="region" aria-label={title}
    onKeyDown={event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }}>
    <div className="wand-notice-header">
      <span className="wand-notice-icon" style={{ color }}><WandIcon name={icon} size={20} /></span>
      <Flex vertical gap={4} className="wand-notice-copy" role="status">
        <Typography.Text strong>{title}</Typography.Text>
        {body && <Typography.Text type="secondary" className="wand-notice-description">{body}</Typography.Text>}
      </Flex>
      <Button type="text" className="wand-notice-close" title="关闭通知" aria-label={`关闭通知：${title}`}
        icon={<WandIcon name="close" size={16} />} onClick={onClose} />
    </div>
    {children}
  </Card>;
}

function NotificationNoticeCard(options: NotificationNoticeOptions): React.ReactElement {
  const { title, body, type, actionLabel, onAction, onClose } = options;
  const icon = type === "success" ? "check" : type === "warning" ? "warning" : type === "error" ? "circleX" : "bell";
  return <NoticeCard title={title} body={body} icon={icon} tone={type} onClose={onClose}>
    {actionLabel && onAction && <Flex justify="flex-end" className="wand-notice-actions">
      <Button type="primary" onClick={onAction}>{actionLabel}</Button>
    </Flex>}
  </NoticeCard>;
}

function UpdateNoticeCard({ current, latest, phase, message, retryRestart, onClose, onUpdate }: UpdateNoticeOptions): React.ReactElement {
  const busy = phase === "updating" || phase === "restarting";
  const label = phase === "updating" ? "更新中…" : phase === "restarting" ? "正在重启…"
    : phase === "complete" ? "已完成" : phase === "failed" ? retryRestart ? "重试重启" : "重试更新" : "立即更新";
  return <NoticeCard title="发现新版本" body="更新 Wand 服务，完成后会自动重连。" icon="download" onClose={onClose}>
    <Flex align="center" gap={8} wrap className="wand-notice-versions" aria-label="版本变化">
      <Typography.Text type="secondary" code>v{current.replace(/^v/, "")}</Typography.Text>
      <Typography.Text type="secondary" aria-hidden="true">→</Typography.Text>
      <Tag color="processing">v{latest.replace(/^v/, "")}</Tag>
    </Flex>
    <Flex justify="flex-end" gap={8} className="wand-notice-actions">
      <Button type="text" onClick={onClose}>{busy ? "收起" : "稍后再说"}</Button>
      <Button type="primary" className="wand-notice-update-action" id="update-bubble-action"
        loading={busy} disabled={phase === "complete"} onClick={onUpdate} aria-label={label}>
        <span className="wand-notice-action-labels" aria-hidden="true">
          {["立即更新", "更新中…", "正在重启…", "已完成", "重试更新", "重试重启"].map(text =>
            <span key={text} aria-hidden="true" data-active={text === label}>{text}</span>)}
        </span>
      </Button>
    </Flex>
    <div role="status" aria-live="polite" className="wand-notice-feedback">
      {message && <Typography.Text type={phase === "failed" ? "danger" : "secondary"}>{message}</Typography.Text>}
    </div>
  </NoticeCard>;
}

export function paintNotificationNotice(host: HTMLElement, options: NotificationNoticeOptions): void {
  paint(host, <NotificationNoticeCard {...options} />);
}

export function paintUpdateNotice(host: HTMLElement, options: UpdateNoticeOptions): void {
  paint(host, <UpdateNoticeCard {...options} />);
}
