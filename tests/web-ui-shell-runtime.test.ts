import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isReactUiEnabled,
  REACT_UI_STORAGE_KEY,
} from "../src/web-ui/react/feature-flags.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeWindow(options: {
  href?: string;
  reactUi?: boolean;
  storedReactUi?: string | null;
} = {}): Window {
  return {
    location: { href: options.href ?? "https://wand.test/" },
    __wandFeatureFlags: options.reactUi === undefined ? undefined : { reactUi: options.reactUi },
    localStorage: {
      getItem(key: string) {
        assert.equal(key, REACT_UI_STORAGE_KEY);
        return options.storedReactUi ?? null;
      },
    },
  } as unknown as Window;
}

test("React UI rollback switch resolves query, window flag, then storage", () => {
  assert.equal(isReactUiEnabled(fakeWindow()), true);
  assert.equal(isReactUiEnabled(fakeWindow({ href: "https://wand.test/?reactUi=0" })), false);
  assert.equal(isReactUiEnabled(fakeWindow({ href: "https://wand.test/?reactUi=1", reactUi: false })), true);
  assert.equal(isReactUiEnabled(fakeWindow({ reactUi: false, storedReactUi: "true" })), false);
  assert.equal(isReactUiEnabled(fakeWindow({ storedReactUi: "false" })), false);
  assert.equal(isReactUiEnabled(fakeWindow({ storedReactUi: "on" })), true);
});

test("the authenticated shell has no legacy rollback flag", () => {
  const flags = readFileSync(path.join(root, "src/web-ui/react/feature-flags.ts"), "utf8");
  assert.doesNotMatch(flags, /reactShell/);

  const runtime = readFileSync(path.join(root, "src/web-ui/browser/shell-runtime.ts"), "utf8");
  assert.doesNotMatch(runtime, /"disabled"/);

  const render = readFileSync(path.join(root, "src/web-ui/browser/render.ts"), "utf8");
  assert.doesNotMatch(render, /using legacy shell/);
  assert.match(render, /renderBootFailure\(\)/);
});

test("browser shell runtime mounts synchronously once and later publishes only", () => {
  const source = readFileSync(path.join(root, "src/web-ui/browser/shell-runtime.ts"), "utf8");
  assert.match(source, /flushSync\(\(\) => root\.render/);
  assert.match(source, /new LegacyHost<HTMLElement>/);
  assert.match(source, /app\.replaceChildren\(\)/);
  assert.match(source, /runtime\?\.store\.publish\(\{ sync: true, reason: "legacy:render" \}\)/);
  assert.match(source, /if \(runtime\) \{/);
  assert.match(source, /host\.mount\(node\)/);
  assert.doesNotMatch(source, /querySelector\("#app"\)|getElementById\("app"\)/);
});

test("authenticated render bypasses terminal teardown and listener rebinding after mount", () => {
  const source = readFileSync(path.join(root, "src/web-ui/browser/render.ts"), "utf8");
  assert.match(source, /!reactShellWasMounted && !!document\.getElementById\("output"\)/);
  assert.match(source, /if \(rebuiltLegacyHosts\) \{\s*resetChatRenderCache\(\);\s*attachEventListeners\(\);/s);
  assert.match(source, /renderBrowserReactShell\(app, renderAppShell\)/);
});

test("React-owned controls are not rebound or imperatively rewritten", () => {
  const events = readFileSync(path.join(root, "src/web-ui/browser/events.ts"), "utf8");
  const sidebar = readFileSync(path.join(root, "src/web-ui/browser/sidebar.ts"), "utf8");
  const files = readFileSync(path.join(root, "src/web-ui/browser/file-browser.ts"), "utf8");
  const folderPicker = readFileSync(path.join(root, "src/web-ui/browser/folder-picker-adapter.ts"), "utf8");
  const websocket = readFileSync(path.join(root, "src/web-ui/browser/websocket.ts"), "utf8");
  const shellRuntime = readFileSync(path.join(root, "src/web-ui/browser/shell-runtime.ts"), "utf8");

  assert.doesNotMatch(events, /reactShellActive/);
  // 三处 if (!reactShellActive) { … } 死块（welcome/侧栏/顶栏 chrome、文件面板、
  // 文件浏览器）与它们的目标节点一并删除：登录页 0 命中这些 id，React 挂载后
  // 守卫恒早退。同类的外点监听（sidebar-overflow-menu / topbar-more-menu）也删。
  for (const dead of [
    "welcome-input",
    "welcome-send-btn",
    "sidebar-overflow-menu",
    "topbar-more-menu",
    "sidebar-pin-btn",
    "topbar-new-session-button",
    "file-panel-toggle-btn",
    "file-search-input",
  ]) {
    assert.ok(!events.includes(dead), `${dead} should stay deleted`);
  }
  // 组合器仍由 legacy 渲染（.input-panel 槽），它的监听器必须在无守卫路径上保留。
  assert.match(events, /getElementById\("send-input-button"\)/);
  assert.match(events, /getElementById\("stop-button"\)/);
  assert.match(events, /getElementById\("input-box"\)/);
  assert.match(events, /getElementById\("terminal-scale-down-top"\)/);
  // 会话列表整簇由 React 渲染：legacy 的 HTML 渲染器、在 React-owned
  // <details> 上抢 `open` 属性的 document 监听器，以及只被它们读的
  // localStorage 展开键都一起删除，不再保留半死分支。
  for (const dead of [
    "renderSessionsListContent",
    "renderSessionItem",
    "renderManageCheckbox",
    "renderClaudeHistoryItem",
    "automation-session-group",
    "non-wand-session-group",
    "wand-automation-sessions-expanded",
    "wand-non-wand-sessions-expanded",
    'addEventListener("toggle"',
    'addEventListener("click"',
  ]) {
    assert.ok(!sidebar.includes(dead), `${dead} should stay deleted`);
  }
  assert.doesNotMatch(sidebar, /innerHTML/);
  // 管理模式的 legacy 状态仍由 React 经 session.manage.toggle 命令驱动。
  assert.match(sidebar, /export function toggleManageMode/);
  assert.match(sidebar, /state\.sessionsManageMode = typeof force/);
  // legacy 文件面板适配层不再回写 React 拥有的 cwd 元素；旧文件树 host 适配器
  //（file-explorer-adapter.ts）整文件已删，它的唯一调用点在死分支里。
  assert.doesNotMatch(files, /isBrowserReactShellMounted|mountFileExplorerHost|cwdEl/);
  assert.ok(!existsSync(path.join(root, "src/web-ui/browser/file-explorer-adapter.ts")));
  // 目录/抽屉/文件面板状态全归 React 渲染，legacy 适配层只留通知，不再有
  // `isBrowserReactShellMounted()` 守卫 + DOM 写入这类半死分支。
  assert.match(folderPicker, /function syncWorkingDirectoryUi\(_path: string\): void \{\s*notifyLegacyUiChange\("working-dir"\);\s*\}/);
  assert.ok(!folderPicker.includes("setTriggerExpanded"));
  for (const dead of ['getElementById("blank-chat-cwd")',
                      'closest<HTMLElement>("#blank-chat-cwd")',
                      'addEventListener("click"', "handleKeyDown", "findTrigger"]) {
    assert.ok(!folderPicker.includes(dead), `${dead} should stay deleted`);
  }
  assert.match(shellRuntime, /BrowserCrossSessionQueueSlot/);
  const input = readFileSync(path.join(root, "src/web-ui/browser/input.ts"), "utf8");
  assert.match(input, /getElementById\("cross-session-queue-host"\)/);
  assert.doesNotMatch(input, /parent\s*=\s*isInputPanelVisible\s*\?\s*inputPanel\s*:\s*blankChat/);
  // 顶栏 #current-task 由 React 渲染：legacy 只广播 task:update，不再写那个节点；
  // 组合器里的权限行仍是 legacy 渲染（.input-panel 槽），必须保留。
  assert.match(websocket, /notifyLegacyUiChange\("task:update"\)/);
  assert.doesNotMatch(websocket, /reactShellActive|isBrowserReactShellMounted|getElementById\("current-task"\)/);
  assert.match(websocket, /getElementById\("permission-actions-label"\)/);
  // switchToSessionView 不再写 React 拥有的 #blank-chat/#output/#chat-output 可见性，
  // 也不再写已经被删掉的标题栏节点。
  assert.doesNotMatch(input, /isBrowserReactShellMounted|reactShellActive/);
  for (const dead of ['getElementById("terminal-title")', 'getElementById("terminal-info")',
                      '".session-summary-value"', 'data-session-id']) {
    assert.ok(!input.includes(dead), `${dead} should stay deleted`);
  }
});

test("composer skill picker stays scoped to Claude SDK structured sessions", () => {
  const engine = readFileSync(path.join(root, "src/web-ui/browser/session-engine.ts"), "utf8");
  const input = readFileSync(path.join(root, "src/web-ui/browser/input.ts"), "utf8");
  const events = readFileSync(path.join(root, "src/web-ui/browser/events.ts"), "utf8");
  const host = readFileSync(path.join(root, "src/web-ui/react/composer-config/host.tsx"), "utf8");
  const skillsHost = readFileSync(path.join(root, "src/web-ui/react/composer-skills/host.tsx"), "utf8");

  assert.match(engine, /session\.sessionKind === "structured"/);
  assert.match(engine, /session\.provider === "claude"/);
  assert.match(engine, /session\.runner === "claude-sdk"/);
  // trigger 与弹层的作用域守卫都在 legacy 侧算（弹层不支持时直接清空 portal），
  // React 只按 skillsVisible 渲染按钮、按 mount 渲染弹层。
  assert.match(engine, /skillsVisible: supportsClaudeSkillSelection\(session\)/);
  assert.match(engine, /if \(!supportsClaudeSkillSelection\(session\)\) \{\n          syncBrowserComposerSkills\(EMPTY_COMPOSER_SKILLS\);/);
  assert.match(host, /data-claude-skills-trigger/);
  assert.match(host, /scope === "all" && mount\.skillsVisible/);
  assert.match(input, /supportsClaudeSkillSelection\(session\) \? \{ skills: getSelectedClaudeSkills\(session\) \} : \{\}/);
  // 选项渲染与点击已迁到 React；legacy 只保留「点外部关闭」与 Escape 的节点判断。
  assert.match(skillsHost, /data-claude-skill-name/);
  assert.match(events, /getElementById\("composer-skills-popover"\)/);
  // trigger 自己的 click 由 React 的 onClick 处理；“点外部关闭”必须排除它，
  // 否则同一次 click 会被当成外部点击立刻关掉刚打开的弹层。
  assert.match(events, /!target\.closest\("\[data-claude-skills-trigger\]"\)/);
});

test("PTY running indicators stop when the provider exits into its retained shell", () => {
  const utils = readFileSync(path.join(root, "src/web-ui/browser/utils.ts"), "utf8");
  const sessions = readFileSync(path.join(root, "src/web-ui/browser/session-engine.ts"), "utf8");
  assert.match(utils, /session\.providerCliActive !== false/);
  // provider CLI 会话必须 ptyBusy 信号才显示运行中；裸 shell 保持进程存活即运行
  assert.match(utils, /var ptyRunning = ptyTurnActive\(session\) && providerCliRunning;/);
  assert.match(utils, /if \(isProviderCliSession\(session\)\) return session\.ptyBusy === true;/);
  assert.match(sessions, /capabilities: \{ ptyAck: true \}/);
});

test("terminal initialization cannot expose PTY chrome for a structured session", () => {
  const terminal = readFileSync(path.join(root, "src/web-ui/browser/terminal.ts"), "utf8");
  const sessions = readFileSync(path.join(root, "src/web-ui/browser/session-engine.ts"), "utf8");

  assert.match(terminal, /var shouldExposeTerminal = !!selectedSession\s*&& !isStructuredSession\(selectedSession\)\s*&& state\.currentView === "terminal";/s);
  assert.match(terminal, /if \(shouldExposeTerminal\) \{\s*container\.classList\.remove\("hidden"\);\s*container\.classList\.add\("active"\);/s);
  assert.doesNotMatch(terminal, /if \(state\.selectedId\) \{\s*container\.classList\.remove\("hidden"\)/s);
  assert.match(sessions, /!state\.terminal && terminalContainer && selectedSession && !isStructuredSession\(selectedSession\)/);
});

test("terminal snapshots survive WebSocket init arriving before xterm mounts", () => {
  const state = readFileSync(path.join(root, "src/web-ui/browser/state.ts"), "utf8");
  const terminal = readFileSync(path.join(root, "src/web-ui/browser/terminal.ts"), "utf8");
  const sessions = readFileSync(path.join(root, "src/web-ui/browser/session-engine.ts"), "utf8");

  assert.match(state, /terminalStatesBySession: \{\}/);
  assert.match(terminal, /if \(sessionId\) state\.terminalStatesBySession\[sessionId\] = snapshot;/);
  assert.match(terminal, /if \(!state\.terminal\) return true;/);
  assert.match(terminal, /session\.terminalState \|\| cachedState/);
  assert.match(sessions, /if \(!sessionIds\.has\(id\)\) delete state\.terminalStatesBySession\[id\]/);
});

test("PTY terminal interaction keeps a usable web composer and only the native embed hides it", () => {
  const input = readFileSync(path.join(root, "src/web-ui/browser/input.ts"), "utf8");
  const sessions = readFileSync(path.join(root, "src/web-ui/browser/session-engine.ts"), "utf8");
  const render = readFileSync(path.join(root, "src/web-ui/browser/render.ts"), "utf8");
  const styles = readFileSync(path.join(root, "src/web-ui/content/styles.css"), "utf8");

  assert.match(input, /composerShell\.classList\.toggle\("is-terminal-interactive", !!state\.terminalInteractive\)/);
  assert.match(input, /shouldUseTerminalPassthrough\(selectedSession\)/);
  assert.match(input, /var terminalPassthrough = el\.classList\.contains\("is-terminal-passthrough"\)/);
  assert.match(render, /state\.terminalInteractive \? ' is-terminal-interactive' : ''/);
  // 网页端 composer 是真实的 PTY 输入面：保留 textarea，只收纳 Agent-only 章节。
  assert.match(styles, /\.input-composer\.is-terminal-interactive \.composer-input-wrap[\s\S]*?display: flex;/);
  assert.match(styles, /\.input-composer\.is-terminal-interactive \.composer-actions-left[\s\S]*?display: none !important;/);
  // 直通规则必须带 html:not(.is-wand-app) 前缀：基础 composer 规则在
  // :focus-within / .is-expanded 变体下是 0-3-1 特指度，不带前缀的直通规则只有
  // 0-3-0，打字（textarea 聚焦）时会输给基础规则，把 composer 顶回 84/100px。
  assert.match(styles, /html:not\(\.is-wand-app\) \.input-composer\.is-terminal-interactive \.composer-main-row[\s\S]*?grid-template-rows: auto;/);
  assert.match(styles, /html:not\(\.is-wand-app\) \.input-composer\.is-terminal-interactive:focus-within \.composer-main-row/);
  assert.match(styles, /html:not\(\.is-wand-app\) \.input-composer\.is-terminal-interactive \.input-textarea[\s\S]*?height: 40px;/);
  // 原生嵌入壳才把 drafting row 整个交还给原生底栏。
  assert.match(styles, /html\.is-wand-embed-terminal \.input-composer\.is-terminal-interactive \.composer-input-wrap[\s\S]*?display: none;/);
  assert.match(styles, /html\.is-wand-embed-terminal \.input-composer\.is-terminal-interactive \.composer-main-row[\s\S]*?grid-template-rows: 48px;[\s\S]*?min-height: 48px;/);
  // #input-box 自己拥有按键（逐字透传走 input 事件），不能再被 keydown 捕获重复发送。
  assert.match(input, /if \(target\.closest && target\.closest\("#input-box"\)\) return false;/);
  // Enter 提交：先文本（若有）后单独 "\r"，符合 PTY 输入契约。
  assert.match(input, /queueDirectInput\("\\r", "enter_text"\)/);
  // 直通模式下退格翻译成 \x7f 送给 PTY，而不是在空 textarea 里做本地删除。
  assert.match(sessions, /state\.terminalInteractive\s*&& !document\.documentElement\.classList\.contains\("is-wand-embed-terminal"\)[\s\S]*?String\.fromCharCode\(127\), "backspace"/);
});

test("PTY passthrough composer renders its trailing action with Appica", () => {
  const render = readFileSync(path.join(root, "src/web-ui/browser/render.ts"), "utf8");
  const input = readFileSync(path.join(root, "src/web-ui/browser/input.ts"), "utf8");
  const adapter = readFileSync(path.join(root, "src/web-ui/browser/composer-rail-adapter.ts"), "utf8");
  const host = readFileSync(path.join(root, "src/web-ui/react/composer-rail/host.tsx"), "utf8");
  const overlay = readFileSync(path.join(root, "src/web-ui/react/overlay-host.tsx"), "utf8");
  const styles = readFileSync(path.join(root, "src/web-ui/content/styles.css"), "utf8");

  // 宿主 span 由 composer 标记提供，端口渲染进 composer-actions-right。
  assert.match(render, /<span class="composer-rail-host" data-composer-rail-host="pty"><\/span>/);
  assert.match(overlay, /<ComposerRailHost \/>/);
  // 业务模块只认 Wand*，第三方组件 API 不进 browser/ 层。
  assert.match(host, /<WandButton[\s\S]*?<WandIcon name="enter" slot="start"/);
  assert.doesNotMatch(host, /@appica\/ui-react/);
  // 只有「网页端 + 直通 + 非嵌入壳」才挂载；原生壳与结构化会话都要清空。
  assert.match(
    input,
    /syncBrowserComposerRail\(\{[\s\S]*?return !!state\.terminalInteractive[\s\S]*?!document\.documentElement\.classList\.contains\("is-wand-embed-terminal"\)/,
  );
  assert.match(adapter, /if \(!config\.active\(\)\) \{[\s\S]*?composerRailController\.clear\(\);/);
  assert.match(adapter, /document\.querySelectorAll<HTMLElement>\("\[data-composer-rail-host\]"\)/);
  // 空宿主不占位（结构化会话保留 legacy 发送按钮），直通下按钮与 40px 输入框对齐。
  assert.match(styles, /\.composer-rail-host:empty \{\s*display: none;/);
  assert.match(styles, /html:not\(\.is-wand-app\) \.input-composer\.is-terminal-interactive \.composer-rail-host[\s\S]*?min-height: 40px;/);
});

test("composer rail controller publishes and clears Appica mounts", async () => {
  const { composerRailController } = await import("../src/web-ui/react/composer-rail/controller.js");
  const target = {} as HTMLElement;
  let notified = 0;
  const unsubscribe = composerRailController.subscribe(() => { notified += 1; });

  try {
    composerRailController.clear();
    assert.equal(composerRailController.getSnapshot().mounts.length, 0);

    composerRailController.sync([{ key: "pty", target, onSubmit() {} }]);
    const snapshot = composerRailController.getSnapshot();
    assert.equal(snapshot.mounts.length, 1);
    assert.equal(snapshot.mounts[0].key, "pty");
    assert.equal(snapshot.mounts[0].target, target);
    assert.ok(snapshot.revision > 0);

    composerRailController.clear();
    assert.equal(composerRailController.getSnapshot().mounts.length, 0);
    assert.equal(notified, 2);
  } finally {
    unsubscribe();
    composerRailController.clear();
  }
});

test("legacy shell chrome writes that can no longer take effect stay deleted", () => {
  const engine = readFileSync(path.join(root, "src/web-ui/browser/session-engine.ts"), "utf8");
  const render = readFileSync(path.join(root, "src/web-ui/browser/render.ts"), "utf8");

  // 这些 id / class 只出现在已删除的 legacy Shell markup 里 —— React Shell
  // 不渲染它们，登录页也没有 —— 所以原来对它们的写入必然是空操作。
  for (const dead of [
    'getElementById("terminal-title")',
    'getElementById("terminal-info")',
    'getElementById("session-kind-display")',
    'querySelector(".session-summary-value")',
    'querySelector(".topbar-session-title, .topbar-tagline")',
  ]) {
    assert.ok(!engine.includes(dead), `${dead} should stay deleted`);
  }
  assert.ok(!render.includes('getElementById("blank-chat-cwd-path")'));

  // 槽位可见性 class 归 React Shell 所有，legacy 侧不能再 toggle，
  // 也不能再长出 `!reactShellActive &&` 这种在 React 外壳下永不执行的半死分支。
  assert.ok(!engine.includes("!reactShellActive"));
  for (const dead of ["terminalContainer.classList", "chatContainer.classList", "blankChat.classList"]) {
    assert.ok(!engine.includes(dead), `${dead} should stay deleted`);
  }

  // legacy 真正拥有的部分必须保留：#stop-button 在 legacy 种子 composer 槽内，
  // #output 是槽根（只用来判断终端实例），#chat-output 的聊天容器仍需命令式收口。
  assert.match(engine, /if \(!selectedSession\) \{\s*if \(stopBtn\) stopBtn\.classList\.add\("hidden"\);/);
  assert.match(engine, /var terminalContainer = document\.getElementById\("output"\);/);
  assert.match(engine, /if \(chatContainer && showChat\) \{\s*ensureChatMessagesContainer\(chatContainer\);/s);
});
