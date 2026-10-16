import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Scoped UI wiring checks only. Lifecycle and input-delivery behavior belongs
// to the platform stores/protocol tests; no container, size or child order is fixed here.
test("Android projects execution and new drafts through the shared send/stop owner", () => {
  const root = "android/app/src/main/java/com/wand/app/ui/screens/";
  const chat = source(root + "ChatScreen.kt");
  const actions = source(root + "ComposerSendActions.kt");
  const conversation = source(root + "ConversationScreens.kt");
  assert.match(chat, /composerPrimaryVisual\(sendPhase, store\.isResponding, canSend, canSubmit\)/);
  assert.match(chat, /actionCount = composerActionPresentation\(sendPhase, store\.isResponding, canSend, canSubmit\)\.slotCount/);
  assert.match(chat, /composerMenuHasStop\(store\.isResponding/);
  assert.match(actions, /sendActionVisual\(phase, running, hasDraft\)/);
  assert.match(actions, /running && primary != SendActionVisual\.Stop/);
  assert.match(actions, /if \(presentation\.stop\) SubmitMorphButton/);
  assert.match(actions, /presentation\.send\?\.let/);
  assert.match(actions, /enabled = !busy && visual == SendActionVisual\.Send && canSubmit/);
  assert.match(actions, /stop = running/);
  assert.match(conversation, /composerActionPresentation\(composer\.sendPhase, running && !taskMode,/);
  assert.match(conversation, /actionCount = actions\.slotCount/);
});

test("iOS projects execution and new drafts independently and retains a stop path", () => {
  const root = "ios/Wand/";
  const chat = source(root + "ChatView.swift");
  const actions = source(root + "NativeComposer.swift");
  assert.match(chat, /phase: store\.inputSending \? \.sending : \.idle/);
  assert.match(chat, /turnRunning: store\.isResponding/);
  assert.match(chat, /hasDraft: hasComposerDraft/);
  assert.match(chat, /!draft\.trimmingCharacters\(in: \.whitespacesAndNewlines\)\.isEmpty \|\| !attachments\.attachments\.isEmpty/);
  assert.match(actions, /phase == \.idle && turnRunning && !hasDraft/);
  assert.match(actions, /if stopping \{ onStop\(\) \} else \{ onSend\(\) \}/);
  assert.match(chat, /if store\.isResponding \{ Button\("停止当前任务"/);
  assert.match(source(root + "ConversationViews.swift"), /turnRunning: running && !dispatch, hasDraft:/);
  assert.match(actions, /if actions\.stop/);
  assert.match(actions, /if actions\.send/);
  for (const file of ["ChatView.swift", "ConversationViews.swift", "ChatDesignPreview.swift"]) assert.match(source(root + file), /actionCount:/);
});
