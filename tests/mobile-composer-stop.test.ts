import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Scoped UI wiring checks only. Lifecycle and input-delivery behavior belongs
// to the platform stores/protocol tests; no container, size or child order is fixed here.
test("Android projects active execution into stop and preserves action availability", () => {
  const root = "android/app/src/main/java/com/wand/app/ui/screens/";
  assert.match(source(root + "ChatScreen.kt"), /if \(store\.isResponding\) SendActionVisual\.Stop else sendActionVisual/);
  assert.match(source(root + "ChatScreen.kt"), /visible = store\.isResponding \|\| canSend \|\| sendPhase != SendPhase\.Idle/);
  assert.match(source(root + "ComposerSendActions.kt"), /enabled = visible && !busy/);
  assert.match(source(root + "ComposerSendActions.kt"), /if \(!visible\) hideFromAccessibility\(\)/);
  assert.match(source(root + "ConversationScreens.kt"), /visual = if \(running && !taskMode\) SendActionVisual\.Stop else visual/);
});

test("iOS projects active execution without treating it as an unsent draft", () => {
  const root = "ios/Wand/";
  assert.match(source(root + "ChatView.swift"), /phase: store\.isResponding \? \.idle/);
  assert.match(source(root + "ChatView.swift"), /hasDraft: !store\.isResponding/);
  for (const file of ["ChatView.swift", "ConversationViews.swift", "ChatDesignPreview.swift"]) assert.match(source(root + file), /primaryVisible:/);
});
