import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Android keeps voice inside and send/stop in a fixed exterior circle", () => {
  const root = "android/app/src/main/java/com/wand/app/ui/screens/";
  const focus = source(root + "FocusCapsuleComposer.kt");
  assert.match(focus, /modifier = Modifier\.weight\(1f\)/);
  assert.match(focus, /if \(exteriorAction != null\) microphone\(\)/);
  assert.match(focus, /if \(exteriorAction != null\) Box\(Modifier\.size\(ComposerActionTouchSize\)/);
  assert.match(source(root + "ChatScreen.kt"), /if \(store\.isResponding\) SendActionVisual\.Stop else sendActionVisual/);
  assert.match(source(root + "ChatScreen.kt"), /visible = store\.isResponding \|\| canSend \|\| sendPhase != SendPhase\.Idle/);
  assert.match(source(root + "ComposerSendActions.kt"), /enabled = visible && !busy/);
  assert.match(source(root + "ComposerSendActions.kt"), /if \(!visible\) hideFromAccessibility\(\)/);
  assert.match(source(root + "ConversationScreens.kt"), /visual = if \(running && !taskMode\) SendActionVisual\.Stop else visual/);
});

test("iOS mounts the same exterior action separately from the capsule voice", () => {
  const root = "ios/Wand/";
  const focus = source(root + "FocusComposer.swift");
  assert.match(focus, /HStack\(alignment: \.bottom, spacing: 4\) \{\s*capsule\s*send\(\)\.frame\(width: 48, height: 48\)/);
  assert.match(focus, /allowsHitTesting\(primaryVisible\)\.accessibilityHidden\(!primaryVisible\)/);
  assert.match(focus, /voice\(\)\s*\}\.padding\(\.horizontal, 4\)/);
  assert.doesNotMatch(focus, /if expanded \{ send\(\) \}/);
  assert.match(source(root + "ChatView.swift"), /phase: store\.isResponding \? \.idle/);
  assert.match(source(root + "ChatView.swift"), /hasDraft: !store\.isResponding/);
  for (const file of ["ChatView.swift", "ConversationViews.swift", "ChatDesignPreview.swift"]) assert.match(source(root + file), /primaryVisible:/);
});
