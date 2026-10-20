import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Android reserves the whole reading viewport below top controls, including preview and IM", () => {
  const root = "android/app/src/main/java/com/wand/app/ui/screens/";
  assert.match(source(root + "FloatingChatControls.kt"), /ChatFloatingControlsClearance = FloatingControlTouch \+ FloatingControlRowInset \* 2/);
  const companion = source(root + "TopChatCompanion.kt");
  // Identity now includes two scalable name lines and a status line; its text, not only the avatar, owns the safe area.
  assert.match(companion, /MaterialTheme\.typography\.labelMedium\.lineHeight\.toDp\(\) \* 2 \+ MaterialTheme\.typography\.labelSmall\.lineHeight\.toDp\(\)/);
  assert.match(companion, /return maxOf\(ChatFloatingControlsClearance, if \(compact\) textHeight \+ 8\.dp else 56\.dp \+ 4\.dp \+ textHeight \+ 8\.dp\)/);
  assert.match(companion, /\.height\(topCompanionClearance\(\)\)/);
  assert.match(source(root + "ChatScreen.kt"), /top = padding\.calculateTopPadding\(\) \+ topCompanionClearance\(\)/);
  assert.match(source(root + "ChatScreen.kt"), /\.padding\(chatPadding\)\s*\.clipToBounds\(\)/);
  assert.match(source(root + "ConversationScreens.kt"), /Box\(Modifier\.fillMaxSize\(\)\.clipToBounds\(\)\)/);
  assert.match(source("android/app/src/preview/java/com/wand/app/ChatPreviewActivity.kt"), /\.padding\(top = topClearance\)\.clipToBounds\(\)/);
});

test("iOS uses shared native top geometry and clips chat, IM and preview at their reading boundary", () => {
  const root = "ios/Wand/";
  assert.match(source(root + "FocusComposer.swift"), /controlsClearance = controlTouch \+ controlRowInset \* 2/);
  const metrics = source(root + "FocusComposer.swift");
  assert.match(metrics, /@ScaledMetric\(relativeTo: \.caption\) var titleLine/);
  assert.match(metrics, /@ScaledMetric\(relativeTo: \.caption2\) var statusLine/);
  assert.match(metrics, /var textHeight: CGFloat \{ titleLine \* 2 \+ 2 \+ statusLine \}/);
  assert.match(metrics, /max\(ChatTopLayout\.controlsClearance, compact \? textHeight \+ 8 : 4 \+ faceSize \+ 4 \+ textHeight \+ 4\)/);
  for (const file of ["ChatView.swift", "ConversationViews.swift", "ChatDesignPreview.swift"]) {
    const text = source(root + file);
    assert.match(text, /private var identityMetrics = ChatIdentityLayoutMetrics\(\)/);
    assert.match(text, /\.padding\(\.top, (?:showsNavigationChrome \? )?identityMetrics\.clearance(?: : 0)?\)/);
    assert.match(text, /\.clipped\(\)/);
    assert.doesNotMatch(text, /\.padding\(\.top, (?:showsNavigationChrome \? \()?verticalSizeClass == \.compact \? 56 : 100/);
  }
  assert.match(source(root + "NativeComposer.swift"), /\.frame\(width: ChatTopLayout\.controlTouch, height: ChatTopLayout\.controlTouch\)/);
});
