// 聊天内容宽度开关：铺满 / 居中两态的分段控件。
//
// 放在「第一屏就能看到」的位置——独立会话在顶栏右侧、任务里在标签栏右侧
// （两处同一个组件、同一份 localStorage 状态）。刻意不做进设置面板：这个偏好
// 是「现在读得累不累」的即时调节，藏进设置等于没有。
//
// 只有聊天视图真正在屏幕上时才出现（legacyVisibility.chat），PTY 终端没有可
// 收窄的正文列；窄屏下由 CSS 隐藏（CHAT_WIDTH_MIN_VIEWPORT）。

import * as React from "react";

import { useUiStoreSnapshot } from "./ui-store-react";
import { chatWidthStore, setChatWidthMode, type ChatWidthMode } from "./chat-width";
import { classNames } from "../ui/class-names";

interface ChatWidthOption {
  readonly mode: ChatWidthMode;
  readonly label: string;
  readonly title: string;
}

const CHAT_WIDTH_OPTIONS: readonly ChatWidthOption[] = [
  {
    mode: "full",
    label: "铺满",
    title: "铺满可用宽度：长表格 / 长代码行少横向滚动",
  },
  {
    mode: "column",
    label: "居中",
    title: "正文收成居中阅读列（最多 940px）：每行更短，长文更好读",
  },
];

export function ChatWidthToggle({ className }: { readonly className?: string }) {
  const mode = React.useSyncExternalStore(
    chatWidthStore.subscribe,
    chatWidthStore.getSnapshot,
    chatWidthStore.getServerSnapshot,
  );
  const snapshot = useUiStoreSnapshot();
  if (!snapshot.legacyVisibility.chat) return null;
  return (
    <div
      className={classNames("chat-width-toggle", className)}
      role="group"
      aria-label="聊天内容宽度"
    >
      {CHAT_WIDTH_OPTIONS.map((option) => {
        const active = option.mode === mode;
        return (
          <button
            key={option.mode}
            type="button"
            className="chat-width-toggle-option"
            data-active={active || undefined}
            aria-pressed={active}
            title={option.title}
            onClick={() => setChatWidthMode(option.mode)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
