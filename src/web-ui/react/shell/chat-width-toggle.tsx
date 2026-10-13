import * as React from "react";
import { Radio } from "antd";
import { SettingsSection, SettingsStatus } from "../settings/fields";
import { chatWidthStore, setChatWidthMode } from "./chat-width";

/** One device-local preference for IM and workspace chat, exposed only in Display settings. */
export function ChatWidthSettings() {
  const mode = React.useSyncExternalStore(chatWidthStore.subscribe, chatWidthStore.getSnapshot, chatWidthStore.getServerSnapshot);
  const [storageDenied, setStorageDenied] = React.useState(false);
  return <SettingsSection title="会话内容宽度" description="对话与工作区会话共用。立即生效并自动保存在当前浏览器，不影响其他设备或终端。">
    <Radio.Group name="wand-chat-width" aria-label="会话内容宽度" value={mode}
      onChange={event => setStorageDenied(!setChatWidthMode(event.target.value))}>
      <Radio value="full">铺满</Radio>
      <Radio value="column">居中</Radio>
    </Radio.Group>
    <p className="wand-settings-library-hint">居中时正文与输入区最多 940px；窄屏自动铺满可用空间。</p>
    {storageDenied ? <SettingsStatus tone="warning">宽度已应用。浏览器未允许保存，刷新后可能恢复原设置。</SettingsStatus> : null}
  </SettingsSection>;
}
