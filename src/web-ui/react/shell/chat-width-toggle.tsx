import { WandDropdownMenuItem, WandDropdownMenuSeparator, WandIcon, WandStretchTabs } from "../ui";
// 聊天内容宽度开关：铺满 / 居中两态的分段控件。
//
// 独立会话从当前会话菜单切换，任务窗口沿用标签栏即时控件；两处共用设备偏好。
//
// 只有聊天视图真正在屏幕上时才出现（legacyVisibility.chat），PTY 终端没有可
// 收窄的正文列；窄屏下由 CSS 隐藏（CHAT_WIDTH_MIN_VIEWPORT）。

import * as React from "react";

import { useUiStoreSnapshot } from "./ui-store-react";
import { CHAT_WIDTH_MIN_VIEWPORT, chatWidthStore, setChatWidthMode, type ChatWidthMode } from "./chat-width";
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
  return <WandStretchTabs
    className={classNames("chat-width-toggle", className)}
    ariaLabel="聊天内容宽度"
    value={mode}
    tabs={CHAT_WIDTH_OPTIONS.map((option) => ({ value: option.mode,
      label: <span title={option.title}>{option.label}</span> }))}
    onValueChange={(value) => setChatWidthMode(value as ChatWidthMode)}
  />;
}

/** The session menu uses the same local preference as the task's inline control. */
export function ChatWidthMenuItems() {
  const snapshot = useUiStoreSnapshot();
  const mode = React.useSyncExternalStore(chatWidthStore.subscribe, chatWidthStore.getSnapshot, chatWidthStore.getServerSnapshot);
  const [available, setAvailable] = React.useState(false);
  React.useEffect(() => {
    const wide = window.matchMedia(`(min-width: ${CHAT_WIDTH_MIN_VIEWPORT}px)`);
    const update = () => setAvailable(wide.matches && !document.documentElement.classList.contains("is-wand-app"));
    update(); wide.addEventListener("change", update);
    return () => wide.removeEventListener("change", update);
  }, []);
  if (!available || !snapshot.legacyVisibility.chat) return null;
  return <>
    <WandDropdownMenuSeparator/>
    {CHAT_WIDTH_OPTIONS.map(option => <WandDropdownMenuItem key={option.mode}
      title={option.title} data-chat-width-mode={option.mode}
      hint={mode === option.mode ? <WandIcon name="check" size={14}/> : undefined}
      onSelect={() => setChatWidthMode(option.mode)}>
      聊天宽度：{option.label}
    </WandDropdownMenuItem>)}
  </>;
}
