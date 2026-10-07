import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Alert, Button, Card, Flex, Spin, Tag, Typography } from "../react/design-library";
import { WandUiProvider } from "../react/theme";
import { WandIcon } from "../react/ui";
const roots = new Map<HTMLElement, Root>();
function paint(host: HTMLElement, view: React.ReactNode): void {
  for (const [node, root] of roots) if (!node.isConnected) { root.unmount(); roots.delete(node); }
  let root = roots.get(host);
  if (!root) { root = createRoot(host); roots.set(host, root); }
  flushSync(() => root.render(<WandUiProvider>{view}</WandUiProvider>));
}
export function clearNoticeView(host: HTMLElement): void {
  const root = roots.get(host);
  if (root) { root.unmount(); roots.delete(host); }
}
export function paintOfflineNotice(host: HTMLElement): void {
  paint(host, <Alert type="warning" showIcon title="当前处于离线状态，部分功能可能不可用。"/>);
}
export function paintBootNotice(host: HTMLElement, error?: string, message?: string): void {
  paint(host, <Flex className="boot-loading" align="center" justify="center" style={{ height: "100%", padding: 24 }}>
    <Card className="boot-loading-card">{error ? <Alert showIcon type="error" title={error}
      description={message} action={<Button onClick={() => location.reload()}>重试</Button>}/>
      : <Flex vertical align="center" gap="middle"><Spin/><Typography.Text>正在连接 Wand…</Typography.Text></Flex>}
    </Card>
  </Flex>);
}
export function paintNotificationNotice(host: HTMLElement, options: { title: string; body?: string; type?: string; actionLabel?: string }): void {
  paint(host, <Card size="small" title={options.title} extra={<Button size="small" type="text" className="notification-bubble-close" title="关闭" aria-label="关闭这条通知" icon={<WandIcon name="close" size={13}/>}/> }>
    <Flex vertical gap="small">
      {options.body && <Alert showIcon type={options.type === "warning" ? "warning" : options.type === "success" ? "success" : "info"} title={options.body}/>}
      {options.actionLabel && <div className="notification-bubble-actions"><Button type="primary">{options.actionLabel}</Button></div>}
    </Flex>
  </Card>);
}
export function paintUpdateNotice(host: HTMLElement, current: string, latest: string): void {
  paint(host, <Card size="small" title="发现新版本" extra={<Button size="small" type="text" className="update-card-close" title="稍后提醒" aria-label="关闭" icon={<WandIcon name="close" size={13}/>}/> }>
    <Flex vertical gap="middle">
      <Typography.Text id="update-card-subtitle" type="secondary">点击下方按钮一键更新</Typography.Text>
      <Flex align="center" gap="small"><Tag>v{current.replace(/^v/, "")}</Tag>→<Tag color="success">v{latest.replace(/^v/, "")}</Tag></Flex>
      <div className="update-card-progress" id="update-card-progress" aria-hidden="true"><Spin/></div>
      <Typography.Text id="update-card-status" className="hidden" role="status"/>
      <Button type="primary" id="update-bubble-action"><span className="update-card-action-label">立即更新</span></Button>
    </Flex>
  </Card>);
}
