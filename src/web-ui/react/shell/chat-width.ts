// 「聊天内容宽度」偏好（外部 store）。
//
// 默认 full = 铺满（历史行为，也是窄屏唯一合理值）；切成 column 时把
// <html data-chat-width="column"> 打开，styles.css 才把正文收成
// --chat-column-width 的居中阅读列。属性由本模块在加载时立刻写入，
// 回访用户不会先看到一帧铺满再跳成窄列。
//
// 存 localStorage 而不是服务端 pref：这是设备本地布局（手机和 5K 显示器想要的值
// 本来就不一样），和 wand-terminal-scale / wand-file-panel-open 同理。
// 刻意独立于 ui-store 的快照契约（同 workspace-context.ts 的取舍）：不进
// UiSnapshotData，就不牵动一批测试 fixture 与 legacy 快照推导。

export type ChatWidthMode = "full" | "column";

export const CHAT_WIDTH_STORAGE_KEY = "wand-chat-width";
/** styles.css 用同名属性选择器，窄屏下该属性不产生任何效果。 */
export const CHAT_WIDTH_ATTRIBUTE = "data-chat-width";
/** 与 styles.css 里媒体查询断点同值：比这更窄时 940px 列已经接近满宽，开关无意义。 */
export const CHAT_WIDTH_MIN_VIEWPORT = 1280;

export function normalizeChatWidthMode(value: unknown): ChatWidthMode {
  return value === "column" ? "column" : "full";
}

function readStoredChatWidthMode(): ChatWidthMode {
  try {
    return normalizeChatWidthMode(window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY));
  } catch (e) {
    // 无 localStorage（SSR / 隐私模式 / 测试环境）时按默认铺满跑。
    return "full";
  }
}

export function applyChatWidthMode(mode: ChatWidthMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute(CHAT_WIDTH_ATTRIBUTE, mode);
}

let chatWidthMode: ChatWidthMode = readStoredChatWidthMode();
const listeners = new Set<() => void>();

// 模块加载即落属性：main.ts 在任何界面渲染前引这个模块。
applyChatWidthMode(chatWidthMode);

export const chatWidthStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot(): ChatWidthMode {
    return chatWidthMode;
  },
  /** 服务端渲染 / 首次客户端渲染都没有设备偏好，统一按默认值出快照。 */
  getServerSnapshot(): ChatWidthMode {
    return "full";
  },
};

export function setChatWidthMode(next: ChatWidthMode): void {
  const value = normalizeChatWidthMode(next);
  if (value === chatWidthMode) return;
  chatWidthMode = value;
  try {
    window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, value);
  } catch (e) {}
  applyChatWidthMode(value);
  for (const listener of listeners) listener();
}
