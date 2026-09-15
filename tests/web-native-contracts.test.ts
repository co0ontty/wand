import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function includesAll(relativePath: string, contracts: ReadonlyArray<string>): void {
  const contents = source(relativePath);
  for (const contract of contracts) {
    assert.ok(
      contents.includes(contract),
      `${relativePath} must preserve native WebView contract: ${contract}`,
    );
  }
}

test("web entry preserves native URL, viewport, and global bridge contracts", () => {
  includesAll("src/web-ui/index.ts", [
    "viewport-fit=cover",
    "interactive-widget=resizes-content",
  ]);
  includesAll("src/web-ui/browser/state.ts", [
    'url.searchParams.get("session")',
    'url.searchParams.delete("session")',
  ]);
  includesAll("src/web-ui/browser/main.ts", [
    "/WandApp\\//",
    "/WandPlatform\\/iOS/",
    "/WandPlatform\\/Android/",
    'params.get("embed") === "terminal"',
    'params.get("nativeInput") === "1"',
    'params.get("passthrough") === "1"',
    "__wandNativeBackHooked",
  ]);
  includesAll("src/web-ui/browser/notifications.ts", ["handleNativeBack"]);
  includesAll("src/web-ui/react/settings/repository.ts", ["_onNativePermissionResult"]);
});

test("web source preserves native events, safe-area variables, and selector hooks", () => {
  includesAll("src/web-ui/browser/render.ts", [
    "wand-android-resume",
    "wand-android-network",
    "wand-ime-state",
    'id="output"',
    'id="terminal-scale-down-top"',
    'id="terminal-scale-label-top"',
    'id="terminal-scale-up-top"',
    'id="page-refresh-btn"',
  ]);
  includesAll("src/web-ui/browser/viewport.ts", [
    "wand-ios-ime-state",
    "--app-viewport-top",
    "--app-viewport-height",
    "wand-joystick-root",
  ]);
  includesAll("src/web-ui/browser/input.ts", [
    "shouldLockNativeInputTerminalIme",
    "lockNativeInputTerminalIme",
    "installNativeInputImeGuard",
    "is-wand-native-input",
    "is-wand-terminal-passthrough",
  ]);
  includesAll("src/web-ui/content/styles.css", [
    "--app-inset-top",
    "--app-inset-bottom",
    "--app-inset-left",
    "--app-inset-right",
    "--wand-safe-top",
    "--wand-safe-bottom",
    "--wand-safe-left",
    "--wand-safe-right",
    ".is-wand-app-native-insets",
    ".is-wand-embed-terminal .file-side-panel",
    ".is-wand-embed-terminal .main-content.file-panel-open",
    ".is-wand-embed-terminal .terminal-scroll-wrap",
    ".is-wand-embed-terminal.is-wand-native-input .input-panel",
    ".is-wand-embed-terminal .terminal-container",
  ]);
});

test("Android WebView preserves its half of the web/native protocol", () => {
  includesAll("android/app/src/main/java/com/wand/app/MainActivity.java", [
    "window.handleNativeBack",
    // window._onNativePermissionResult 已随通知权限桥接一并移除（1168cfa），
    // web 侧保留防御性回调并有 resume / timeout 兑底，不再要求原生端实现。
    "wand-android-resume",
    "wand-android-network",
    "wand-ime-state",
    'appendQueryParameter("session", sessionId)',
    'WandPlatform/Android',
    "webView.canGoBack()",
    "onShowFileChooser",
    "onCreateWindow",
    "onPermissionRequest",
    "setDownloadListener",
    // openNotificationSettings 已随通知权限桥接一并移除（1168cfa）。
  ]);
  includesAll("android/app/src/main/java/com/wand/app/ui/screens/PtyTerminalScreen.kt", [
    'appendQueryParameter("embed", "terminal")',
    'appendQueryParameter("nativeInput", "1")',
    'appendQueryParameter("passthrough", "1")',
    "EnableTerminalPassthroughScript",
  ]);
});

test("Apple WebViews preserve deep links, bridge globals, and terminal hooks", () => {
  includesAll("ios/Wand/WebContainerView.swift", [
    "window.__wandIosNative = true",
    "window.__wandBackToNative",
    "window.WandNative",
    'URLQueryItem(name: "session", value: sessionId)',
    'URLQueryItem(name: "embed", value: "terminal")',
    'URLQueryItem(name: "nativeInput", value: "1")',
    'URLQueryItem(name: "passthrough", value: "1")',
    "WandPlatform/iOS",
    "terminal-scale-down-top",
    "terminal-scale-label-top",
    "terminal-scale-up-top",
    "page-refresh-btn",
    ".is-wand-embed-terminal .wand-joystick-root",
    ".is-wand-embed-terminal .terminal-scroll-wrap",
    ".is-wand-embed-terminal .input-panel",
    ".is-wand-embed-terminal .notification-bubble",
    ".is-wand-embed-terminal .terminal-container",
    "__wandNativeInputImeGuard",
    "restoreEmbeddedTerminalInput",
    "refitEmbeddedTerminalViewport",
    "suppressEmbeddedTerminalIme",
  ]);
  includesAll("ios/Wand/NativeComposer.swift", [
    "IMEAwareComposerTextView",
    "markedTextRange",
    "composerShouldApplyExternalText",
    "composerShouldSubmitReturn",
    "composerDraftIsSendable",
  ]);
  includesAll("ios/Wand/ChatView.swift", [
    "IMEAwareComposerTextView",
    "composerIsComposing",
  ]);
  includesAll("ios/Wand/SessionDestinationView.swift", [
    "IMEAwareComposerTextView",
    "composerIsComposing",
    "suppressEmbeddedTerminalIme",
  ]);
  includesAll("ios/Wand/WebBridge.swift", [
    "wand-ios-ime-state",
    "__wandNativeBackHooked",
  ]);
  includesAll("macos/Wand/WebContainerView.swift", [
    "window.__wandMacNative = true",
    "window.__wandBackToNative",
    "var embedTerminal: Bool = false",
    "embedTerminal: embedTerminal",
    "var embedNativeInput: Bool = false",
    "embedNativeInput: embedNativeInput",
    'URLQueryItem(name: "session", value: sessionId)',
    'URLQueryItem(name: "embed", value: "terminal")',
    'URLQueryItem(name: "nativeInput", value: "1")',
    "WandPlatform/macOS",
  ]);
  includesAll("macos/Wand/MainShellView.swift", [
    "if session?.isStructured == false",
    "SessionHeaderView(",
    "PtySessionView(sessionId: sessionId, api: api)",
  ]);
  includesAll("macos/Wand/ChatView.swift", [
    "embedTerminal: true",
    "embedNativeInput: true",
    "IMEAwareComposerTextView",
    "doCommandBy commandSelector",
    "textView.hasMarkedText()",
    "textView.unmarkText()",
    "composerIsComposing",
  ]);
});

test("subagent role windows stay compact, avatar-free, and follow the newest content", () => {
  includesAll("src/web-ui/browser/chat-render.ts", [
    'data-follow-tail="true"',
    'class="subagent-panel-body"',
  ]);
  includesAll("src/web-ui/browser/events.ts", [
    '.subagent-panel[data-follow-tail="true"]',
    "body.scrollTop = body.scrollHeight",
  ]);
  includesAll("src/web-ui/content/styles.css", [
    ".subagent-panel-body",
    "height: 320px",
    "overflow-y: auto",
  ]);
  assert.doesNotMatch(
    source("src/web-ui/browser/chat-render.ts"),
    /class="subagent-panel-avatar"/,
    "Web subagent window must not reserve a left avatar box",
  );

  includesAll("ios/Wand/ChatView.swift", [
    "private let subagentWindowContentHeight: CGFloat = 280",
    "ScrollViewReader { proxy in",
    "subagentTailRefreshToken(items)",
    "proxy.scrollTo(tailAnchorID, anchor: .bottom)",
  ]);
  assert.ok(
    !source("ios/Wand/ChatView.swift").includes("avatar(running: running(items))"),
    "iOS subagent window must not keep the detached left avatar",
  );

  includesAll("android/app/src/main/java/com/wand/app/ui/screens/ChatBlocks.kt", [
    "collectSubagentActivities",
    "SubagentActivityDock",
    "AgentBubbleRail",
    "SubcomposeLayout",
    "StackedAgentCluster",
    "GeneratedAgentLogo",
    "agentLogoVariant",
    "Agent:",
    "WandIcons.agent",
    "Brush.linearGradient",
    "正在运行",
    "HorizontalPager",
    "key = { page -> activities.getOrNull(page)?.id",
    "pagerState.settledPage",
    "ValueAnimator.areAnimatorsEnabled()",
    "collapseActivities = false",
    "snapshotFlow { scrollState.maxValue }",
    "LaunchedEffect(refreshToken)",
    "scrollState.scrollTo(maxValue)",
    "SubagentActivityPage(activity)",
  ]);
  includesAll("android/app/src/main/java/com/wand/app/ui/screens/ChatScreen.kt", [
    "showActivityDock",
    "SubagentActivityDock(",
    ".align(Alignment.BottomCenter)",
  ]);

  includesAll("macos/Wand/ChatView.swift", [
    "splitAssistantContentBySubagent(turn.content)",
    "private let subagentWindowContentHeight: CGFloat = 280",
    "subagentTailRefreshToken(items)",
    "proxy.scrollTo(tailAnchorID, anchor: .bottom)",
  ]);
});

test("activity folds stay consecutive and split when prose arrives", () => {
  includesAll("src/web-ui/browser/chat-render.ts", [
    "flushPendingActivity(false)",
    "flushPendingActivity(true)",
    "opts.isTrailing",
    "isFoldableActivityBlock",
    'class="chat-activity-top"',
  ]);
  assert.doesNotMatch(
    source("src/web-ui/browser/chat-render.ts"),
    /正文在上、活动状态条在下/,
    "Web must not collect every activity run under all prose",
  );

  includesAll("android/app/src/main/java/com/wand/app/ui/screens/ChatBlocks.kt", [
    "连续思考/工具收成一条压缩条",
    "fun collapseActivityItems(",
    "renderItems.last() is SegmentRenderItem.Activity",
  ]);

  includesAll("ios/Wand/ChatView.swift", [
    "struct ActivityFoldCard",
    // 折叠展开态由卡片自己的 @State 管理；running 只看当前轮次是否在回复。
    "@State private var expanded = false",
    "summarizeActivityItems",
  ]);

  includesAll("macos/Wand/ChatView.swift", [
    "struct ActivityFoldCard",
    "@State private var expanded = false",
    "summarizeActivityItems",
  ]);
});

test("embedded passthrough terminal pins its width so fit cannot shrink it", () => {
  // 直通输入模式下原生壳把 .terminal-scroll-wrap 从 absolute 改成 relative，好让
  // .xterm-helpers 里的透明输入层有尺寸参照。但 .terminal-container.active 是 row
  // 方向的 flex 容器：wrap 落回文档流后是 flex-grow: 0 的收缩型 flex item，宽度会被
  // xterm 自身网格宽度反向决定，而 FitAddon 又按这个宽度反算列数 —— 自反馈会让终端
  // 每 fit 一次就更窄一点（表现为右侧铺不满并逐渐缩小）。两处都必须钉死宽度。
  const rulePattern = /\.is-wand-terminal-passthrough\s+\.terminal-scroll-wrap\s*\{[^}]*\}/;
  for (const file of ["ios/Wand/WebContainerView.swift", "src/web-ui/content/styles.css"]) {
    const rule = source(file).match(rulePattern);
    assert.ok(rule, `${file} must keep the passthrough .terminal-scroll-wrap rule`);
    assert.match(rule[0], /width:\s*100%/, `${file} must pin the passthrough wrap width`);
    assert.match(rule[0], /min-width:\s*0/, `${file} must let the passthrough wrap shrink`);
  }
});

test("terminal fit geometry ignores the unused overview ruler reserve", () => {
  // @xterm/addon-fit 只要 scrollback > 0 就固定预留 14px 给 overview ruler，而 Wand
  // 从未启用 overviewRuler（ruler 画布根本不会创建）。终端 fit 必须走
  // terminal-fit.ts 的 proposeTerminalDimensions，把这条白扣的宽度补回来。
  includesAll("src/web-ui/browser/terminal-fit.ts", [
    "proposeTerminalDimensions",
    ".xterm-decoration-overview-ruler",
  ]);
  for (const file of [
    "src/web-ui/browser/terminal.ts",
    "src/web-ui/browser/viewport.ts",
    "src/web-ui/browser/terminal-pool.ts",
    "src/web-ui/browser/file-browser.ts",
  ]) {
    const contents = source(file);
    assert.ok(
      contents.includes("fitTerminalToContainer"),
      `${file} must fit terminals through terminal-fit.ts`,
    );
    assert.doesNotMatch(
      contents,
      /\b(?:state\.)?terminalFitAddon\.fit\(\)|fitAddon\.fit\(\)/,
      `${file} must not call FitAddon.fit() directly (it reserves 14px for an unused ruler)`,
    );
  }
});
