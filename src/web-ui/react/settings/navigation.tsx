import * as React from "react";
import { Empty, Menu } from "antd";
import { WandIcon, WandSearchField } from "../ui";
import type { SettingsTab } from "./types";

export const SETTINGS_SECTIONS: Record<SettingsTab, { label: string; description: string; keywords?: string }> = {
  profile: { label: "我的资料", description: "消息署名与头像" },
  notifications: { label: "通知", description: "提示音、系统通知与触感", keywords: "声音 铃声 音量" },
  display: { label: "显示", description: "结果卡片的默认展开方式", keywords: "界面 折叠" },
  ai: { label: "AI 与模型", description: "默认工具、模型与候选分组", keywords: "Claude Codex Pi OpenRouter" },
  "local-models": { label: "本地模型", description: "离线决策与模型资源", keywords: "LAYA 下载 初始化" },
  speech: { label: "语音输入", description: "识别模型与运行设备", keywords: "麦克风 语言 sherpa" },
  general: { label: "基本配置", description: "服务连接、执行偏好与保留策略", keywords: "Host 端口 HTTPS Shell 环境 目录 归档 删除" },
  connectors: { label: "连接器", description: "GitHub 账号与仓库连接", keywords: "token Enterprise" },
  security: { label: "安全", description: "登录密码与 SSL 证书" },
  presets: { label: "命令预设", description: "创建会话时可用的快捷命令" },
  about: { label: "关于", description: "版本、更新与客户端连接", keywords: "下载 连接码 二维码 APK iOS macOS" },
};

const GROUPS: ReadonlyArray<{ label: string; tabs: SettingsTab[] }> = [
  { label: "个人偏好", tabs: ["profile", "notifications", "display"] },
  { label: "AI 能力", tabs: ["ai", "local-models", "speech"] },
  { label: "服务管理", tabs: ["general", "connectors", "security", "presets", "about"] },
];

export function SettingsDirectory({ available, selected, query, onQuery, onSelect }: {
  available: SettingsTab[];
  selected: SettingsTab;
  query: string;
  onQuery(value: string): void;
  onSelect(value: SettingsTab): void;
}) {
  const search = query.trim().toLocaleLowerCase();
  const items = GROUPS.flatMap((group) => {
    const tabs = group.tabs.filter((tab) => available.includes(tab) && (!search
      || `${group.label} ${SETTINGS_SECTIONS[tab].label} ${SETTINGS_SECTIONS[tab].description} ${SETTINGS_SECTIONS[tab].keywords ?? ""}`.toLocaleLowerCase().includes(search)));
    return tabs.length ? [{ type: "group" as const, key: group.label, label: group.label,
      children: tabs.map((tab) => ({ key: tab, label: <span className="wand-settings-library-nav-item">
        <span className="wand-settings-library-nav-copy"><span>{SETTINGS_SECTIONS[tab].label}</span>
          <span className="wand-settings-library-nav-description">{SETTINGS_SECTIONS[tab].description}</span></span>
        <WandIcon name="chevron" size={16}/>
      </span> })) }] : [];
  });
  return <>
    <div className="wand-settings-library-search"><WandSearchField label="查找设置分组" value={query}
      onValueChange={onQuery} placeholder="查找设置分组"/></div>
    {items.length ? <Menu mode="inline" inlineIndent={16} selectedKeys={[selected]} items={items}
      aria-label="设置分组" onClick={({ key }) => onSelect(key as SettingsTab)}/>
      : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的设置分组"/>}
  </>;
}
