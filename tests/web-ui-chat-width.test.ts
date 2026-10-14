// 聊天内容宽度开关：localStorage 持久化 + <html data-chat-width> 落属性 + 订阅。
// 这两个副作用（DOM 属性、localStorage）是开关真正生效的部分，这里用假 document /
// window 跑真实模块，而不是只做源码字符串断言。

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CHAT_WIDTH_ATTRIBUTE,
  CHAT_WIDTH_MIN_VIEWPORT,
  CHAT_WIDTH_STORAGE_KEY,
  chatWidthStore,
  normalizeChatWidthMode,
  setChatWidthMode,
  type ChatWidthMode,
} from "../src/web-ui/react/shell/chat-width.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface FakeEnv {
  attributes: Record<string, string>;
  stored: Map<string, string>;
  dispatchStorage(key: string | null): void;
  restore(): void;
}

/** 装一套最小 window/document，让模块加载时的读写走真实代码路径。 */
function installFakeDom(initialStorage: Record<string, string> = {}): FakeEnv {
  const attributes: Record<string, string> = {};
  const stored = new Map<string, string>(Object.entries(initialStorage));
  const globals = globalThis as Record<string, unknown>;
  const previousWindow = globals.window;
  const previousDocument = globals.document;
  const storageListeners: Array<(event: { key: string | null }) => void> = [];
  globals.window = {
    addEventListener: (name: string, listener: (event: { key: string | null }) => void) => {
      if (name === "storage") storageListeners.push(listener);
    },
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    },
  };
  globals.document = {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
    },
  };
  return {
    attributes,
    stored,
    dispatchStorage(key) { storageListeners.forEach(listener => listener({ key })); },
    restore() {
      globals.window = previousWindow;
      globals.document = previousDocument;
    },
  };
}

let isolatedImportCount = 0;
/** 用 query 串拿一份全新的模块实例，验证「加载即读持久化值」。 */
async function freshModule(): Promise<typeof import("../src/web-ui/react/shell/chat-width.js")> {
  isolatedImportCount += 1;
  return import(`../src/web-ui/react/shell/chat-width.js?fresh=${isolatedImportCount}`);
}

test("normalizeChatWidthMode only accepts the two known values", () => {
  assert.equal(normalizeChatWidthMode("column"), "column");
  assert.equal(normalizeChatWidthMode("full"), "full");
  for (const junk of [null, undefined, "", "COLUMN", "wide", 0, {}, ["column"]]) {
    assert.equal(normalizeChatWidthMode(junk), "full", `junk=${JSON.stringify(junk)}`);
  }
});

test("chat width defaults to full and stays inert without a DOM", () => {
  // 这条断言的顺序需要在没有 window/document 的环境下成立（SSR / 隐私模式 / 单测）。
  assert.equal(chatWidthStore.getServerSnapshot(), "full");
  assert.doesNotThrow(() => setChatWidthMode("column"));
  assert.equal(chatWidthStore.getSnapshot(), "column");
  setChatWidthMode("full");
  assert.equal(chatWidthStore.getSnapshot(), "full");
});

test("setChatWidthMode persists, writes the html attribute, and notifies once", () => {
  const env = installFakeDom({ [CHAT_WIDTH_STORAGE_KEY]: "column" });
  try {
    assert.equal(chatWidthStore.getSnapshot(), "full", "内存快照不受模块加载前写入的存储影响");
    let notified = 0;
    const unsubscribe = chatWidthStore.subscribe(() => {
      notified += 1;
    });
    setChatWidthMode("column");
    assert.equal(chatWidthStore.getSnapshot(), "column");
    assert.equal(env.stored.get(CHAT_WIDTH_STORAGE_KEY), "column");
    assert.equal(env.attributes[CHAT_WIDTH_ATTRIBUTE], "column");
    assert.equal(notified, 1);

    // 同值重复设置不通知（避免无谓的 React 重渲染）；存储可重新尝试。
    setChatWidthMode("column");
    assert.equal(notified, 1);

    // 脏值按默认铺满处理，且属性被改回来。
    setChatWidthMode("nonsense" as ChatWidthMode);
    assert.equal(chatWidthStore.getSnapshot(), "full");
    assert.equal(env.attributes[CHAT_WIDTH_ATTRIBUTE], "full");
    assert.equal(notified, 2);

    unsubscribe();
    setChatWidthMode("column");
    assert.equal(notified, 2, "退订后不再回调");
    setChatWidthMode("full");
  } finally {
    env.restore();
  }
});

test("a fresh module instance adopts the persisted mode before first render", async () => {
  const env = installFakeDom({ [CHAT_WIDTH_STORAGE_KEY]: "column" });
  try {
    const fresh = await freshModule();
    assert.equal(fresh.chatWidthStore.getSnapshot(), "column");
    assert.equal(env.attributes[CHAT_WIDTH_ATTRIBUTE], "column", "加载即落属性，无跳变");
  } finally {
    env.restore();
  }
});

test("storage failures fall back to full instead of throwing", async () => {
  const globals = globalThis as Record<string, unknown>;
  const previousWindow = globals.window;
  globals.window = {
    addEventListener: () => {},
    get localStorage(): never {
      throw new Error("denied");
    },
  };
  try {
    const fresh = await freshModule();
    assert.equal(fresh.chatWidthStore.getSnapshot(), "full");
    assert.equal(fresh.setChatWidthMode("column"), false, "reports denied persistence while applying in memory");
    assert.equal(fresh.chatWidthStore.getSnapshot(), "column");
  } finally {
    globals.window = previousWindow;
  }
});

test("only Display settings expose the shared width preference", () => {
  const topbar = readFileSync(path.join(root, "src/web-ui/react/shell/shell-topbar.tsx"), "utf8");
  const tabbar = readFileSync(
    path.join(root, "src/web-ui/react/workspaces/workspace-tab-bar.tsx"),
    "utf8",
  );
  assert.doesNotMatch(topbar, /ChatWidthMenuItems|chat-width-toggle/);
  assert.doesNotMatch(tabbar, /ChatWidthToggle|workspace-tab-chat-width/);
  const controls = readFileSync(path.join(root, "src/web-ui/react/shell/chat-width-toggle.tsx"), "utf8");
  const tabs = readFileSync(path.join(root, "src/web-ui/react/settings/tabs.tsx"), "utf8");
  assert.match(tabs, /<ChatWidthSettings\s*\/>/);
  assert.match(tabs, /if \(props\.snapshot\.access === "admin"\) return <AdminDisplaySettingsTab/, "server card defaults remain administrator-only");
  assert.match(tabs, /function DisplayAppearance\(\)/, "read-only clients reuse the same local preference controls");
  assert.match(controls, /<Radio\.Group name="wand-chat-width"/);
  assert.match(controls, /chatWidthStore\.subscribe/);
  assert.match(controls, /setChatWidthMode\(event\.target\.value\)/);
});

test("IM and workspace messages, composers and detached controls share one responsive column", () => {
  const css = readFileSync(path.join(root, "src/web-ui/content/styles.css"), "utf8");
  assert.ok(css.includes(`@media (min-width: ${CHAT_WIDTH_MIN_VIEWPORT}px) { html[data-chat-width="column"] { --chat-content-max-width: var(--chat-column-width); } }`));
  assert.match(css, /--chat-content-max-width: none;/, "full is the default and narrow screens fill their host");
  assert.match(css, /:is\(\.chat-messages, \.chat-running-bar, \.input-panel, \.conversation-message-scroll > \*, \.conversation-composer, \.conversation-task-context, \.conversation-session-activity\) \{[^}]*max-width:var\(--chat-content-max-width\)/);
  assert.doesNotMatch(css, /\.conversation-composer[^}]*max-width:var\(--chat-column-width\)/, "IM no longer unconditionally caps at 940px");
  assert.doesNotMatch(css, /\.chat-width-toggle/, "moved controls leave no unused stylesheet");
});

test("a storage event updates both the shared snapshot and html without notifying on unrelated keys", async () => {
  const env = installFakeDom();
  try {
    const fresh = await freshModule();
    let notified = 0;
    fresh.chatWidthStore.subscribe(() => notified++);
    env.stored.set(CHAT_WIDTH_STORAGE_KEY, "column");
    env.dispatchStorage("unrelated");
    assert.equal(notified, 0);
    env.dispatchStorage(CHAT_WIDTH_STORAGE_KEY);
    assert.equal(fresh.chatWidthStore.getSnapshot(), "column");
    assert.equal(env.attributes[CHAT_WIDTH_ATTRIBUTE], "column");
    assert.equal(notified, 1);
    env.stored.clear(); env.dispatchStorage(null);
    assert.equal(fresh.chatWidthStore.getSnapshot(), "full");
    assert.equal(env.attributes[CHAT_WIDTH_ATTRIBUTE], "full");
    assert.equal(notified, 2);
  } finally { env.restore(); }
});
