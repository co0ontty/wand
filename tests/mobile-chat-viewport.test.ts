import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Android reserves the whole reading viewport below top controls, including preview and IM", () => {
  const root = "android/app/src/main/java/com/wand/app/ui/screens/";
  assert.match(source(root + "FloatingChatControls.kt"), /ChatFloatingControlsClearance = FloatingControlTouch \+ FloatingControlRowInset \* 2/);
  assert.match(source(root + "TopChatCompanion.kt"), /return maxOf\(ChatFloatingControlsClearance, top \+ size \+ 8\.dp\)/);
  assert.match(source(root + "ChatScreen.kt"), /top = padding\.calculateTopPadding\(\) \+ topCompanionClearance\(\)/);
  assert.match(source(root + "ChatScreen.kt"), /\.padding\(chatPadding\)\s*\.clipToBounds\(\)/);
  assert.match(source(root + "ConversationScreens.kt"), /Box\(Modifier\.fillMaxSize\(\)\.clipToBounds\(\)\)/);
  assert.match(source("android/app/src/preview/java/com/wand/app/ChatPreviewActivity.kt"), /\.padding\(top = topClearance\)\.clipToBounds\(\)/);
});

test("iOS uses shared native top geometry and clips chat, IM and preview at their reading boundary", () => {
  const root = "ios/Wand/";
  assert.match(source(root + "FocusComposer.swift"), /controlsClearance = controlTouch \+ controlRowInset \* 2/);
  assert.match(source(root + "FocusComposer.swift"), /max\(controlsClearance, compact \? 56 : 100\)/);
  for (const file of ["ChatView.swift", "ConversationViews.swift", "ChatDesignPreview.swift"]) {
    const text = source(root + file);
    assert.match(text, /ChatTopLayout\.clearance\(compact: verticalSizeClass == \.compact\)/);
    assert.match(text, /\.clipped\(\)/);
    assert.doesNotMatch(text, /\.padding\(\.top, (?:showsNavigationChrome \? \()?verticalSizeClass == \.compact \? 56 : 100/);
  }
  assert.match(source(root + "NativeComposer.swift"), /\.frame\(width: ChatTopLayout\.controlTouch, height: ChatTopLayout\.controlTouch\)/);
});
