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
    ".is-wand-embed-terminal .terminal-scroll-wrap",
    ".is-wand-embed-terminal.is-wand-native-input .input-panel",
    ".is-wand-embed-terminal .terminal-container",
  ]);
});

test("Android WebView preserves its half of the web/native protocol", () => {
  includesAll("android/app/src/main/java/com/wand/app/MainActivity.java", [
    "window.handleNativeBack",
    "window._onNativePermissionResult",
    "wand-android-resume",
    "wand-android-network",
    "wand-ime-state",
    'appendQueryParameter("session", sessionId)',
    'WandPlatform/Android',
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
    "WandPlatform/iOS",
    "terminal-scale-down-top",
    "terminal-scale-label-top",
    "terminal-scale-up-top",
    "page-refresh-btn",
    ".is-wand-embed-terminal .wand-joystick-root",
    ".is-wand-embed-terminal .terminal-scroll-wrap",
    ".is-wand-embed-terminal .input-panel",
    ".is-wand-embed-terminal .notification-bubble.update-card",
    ".is-wand-embed-terminal .terminal-container",
  ]);
  includesAll("ios/Wand/WebBridge.swift", [
    "wand-ios-ime-state",
    "__wandNativeBackHooked",
  ]);
  includesAll("macos/Wand/WebContainerView.swift", [
    "window.__wandMacNative = true",
    "window.__wandBackToNative",
    'URLQueryItem(name: "session", value: sessionId)',
    "WandPlatform/macOS",
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
