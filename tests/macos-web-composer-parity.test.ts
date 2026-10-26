import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const available = existsSync(resolve(import.meta.dirname, "../macos/Wand/FocusComposer.swift"));
const source = (name: string) => !available && name.startsWith("macos/") ? "" : readFileSync(resolve(import.meta.dirname, "..", name), "utf8");
const web = source("src/web-ui/react/chat-composer-styles.ts");
const base = source("src/web-ui/content/styles.css");
const native = source("macos/Wand/FocusComposer.swift");
const chat = source("macos/Wand/ChatView.swift");
const communications = source("macos/Wand/CommunicationsViews.swift");

// Static cross-platform contract only. Native XCTest geometry and real screenshots
// remain mandatory; this does not pretend that reading source is visual acceptance.
test("desktop composer uses Web control size and radius instead of a separate capsule", { skip: !available }, () => {
  const size = Number(web.match(/--composer-control-height:(\d+)px/)?.[1]);
  const radius = Number(source("src/web-ui/react/theme-palettes.ts").match(/\bborderRadius:\s*(\d+)/)?.[1]);
  assert.ok(Number.isFinite(radius), "Web must expose its actual control-radius token");
  assert.equal(size, 32);
  assert.match(native, new RegExp(`static let touch: CGFloat = ${size}\\b`));
  assert.match(native, new RegExp(`static let controlRadius: CGFloat = ${radius}\\b`));
  const surface = native.slice(native.indexOf("struct FocusComposerSurface"), native.indexOf("enum ComposerHeaderKind"));
  assert.match(web, /border-radius:0; background:transparent/);
  assert.doesNotMatch(surface, /outline\.fill|outline\.stroke|\.background\(/);
  assert.match(surface, /\.overlay\(alignment: \.top\)/);
  assert.match(surface, /frame\(height: isFocused \? 2 : 1\)/);
});

test("runtime anchors match Web while permission stays in the add panel", { skip: !available }, () => {
  assert.match(web, /composer-inline-config \{ position:absolute;[^\n]*inset-inline-end:0/);
  assert.match(base, /composer-floating-avatar[^\n]*inset-block-start:-76px; width:72px; height:72px/);
  assert.match(native, /frame\(height: hasPortrait \? \(kind == \.task \? 65 : 76\) : \(kind == \.task \? 32 : 28\)\)/);
  assert.match(native, /portrait\(\)\.frame\(width: 72, height: 72\)/);
  assert.match(native, /padding\(\.leading, hasPortrait \? 84 : 0\)/);
  const bar = chat.slice(chat.indexOf("private var inputBar:"), chat.indexOf("private var modePanel:"));
  assert.match(bar, /WorkingAvatar\(/);
  assert.match(communications, /ComposerIdentityHeader\(kind: \.conversation/);
  assert.match(communications, /ExecutingConversationCompanion/);
  assert.match(source("macos/Wand/SharedPlushScene.swift"), /static let liveMinCores = 4/);
  assert.match(source("macos/Wand/SharedPlushScene.swift"), /static let liveMinMemoryGB = 4\.0/);
  assert.match(source("src/web-ui/avatar-hardware.ts"), /AVATAR_LIVE_MIN_CORES = 4/);
  assert.match(source("src/web-ui/avatar-hardware.ts"), /AVATAR_LIVE_MIN_MEMORY_GB = 4/);
  assert.match(native, /\(viewportWidth \?\? geometry\.size\.width\) > 640/);
  assert.match(native, /window\?\.contentLayoutRect\.width/);
  assert.match(chat, /modelThinkingChip\(inMenu: false\)/);
  assert.match(chat, /thinkingChip\(inMenu: false\)/);
  assert.doesNotMatch(bar, /ComposerSettingLabel\(title:.*权限/);
  assert.match(chat, /modelThinkingChip\(inMenu: true\)/);
  assert.match(chat, /thinkingChip\(inMenu: true\)/);
  assert.match(chat, /showComposerActions == inMenu/);
  assert.match(communications, /ComposerIdentityHeader\(kind: \.conversation/);
});

test("footer follows Web add, entry, submit order and full-width editor", { skip: !available }, () => {
  const surface = native.slice(native.indexOf("struct FocusComposerSurface"), native.indexOf("enum ComposerHeaderKind"));
  const ordered = ["editor()", "add()", "Button(action: onFocus)", "send()"];
  let previous = -1;
  for (const marker of ordered) {
    const index = surface.indexOf(marker);
    assert.ok(index > previous, marker);
    previous = index;
  }
  assert.doesNotMatch(surface, /padding\(\.horizontal, 16\)/);
  assert.match(chat, /isFocused: inputFocused/);
  assert.match(chat, /textView\.font = \.systemFont\(ofSize: 14\)/);
  assert.match(chat, /textView\.textContainerInset = \.zero/);
  assert.match(chat, /textContainer\?\.lineFragmentPadding = 0/);
  assert.match(chat, /paragraph\.minimumLineHeight = 21; paragraph\.maximumLineHeight = 21/);
  assert.match(communications, /isFocused: focus.focused/);
  assert.match(native, /RoundedRectangle\(cornerRadius: FocusComposerMetrics\.controlRadius\)\.fill\(tint\)/);
  assert.match(native, /stopping \? Theme\.danger/);
});

test("Todo shares the desktop input edge and opens without replacing the editor", { skip: !available }, () => {
  const render = source("src/web-ui/browser/render.ts");
  assert.ok(render.indexOf('class="composer-top-row"') > render.indexOf('class="input-composer\''));
  assert.match(base, /composer-top-row \{ position:absolute/);
  assert.match(web, /composer-todo-width/);
  assert.match(native, /progress\.frame\(width: progressWidth\)/);
  assert.match(chat, /progress: composerProgress/);
  assert.match(chat, /TodoProgressBar\(todos: visibleTodos\)/);
  const todo = chat.slice(chat.indexOf("struct TodoProgressBar:"), chat.indexOf("private struct QueueBar:"));
  assert.match(todo, /\.popover\(isPresented: \$expanded, arrowEdge: \.bottom\)/);
  assert.match(todo, /Text\("\\\(completed\) \/ \\\(todos\.count\)"\)/);
  assert.doesNotMatch(todo, /currentStep/);
});

test("pending messages share Todo space with width-aware summaries on both desktops", { skip: !available }, () => {
  const queue = source("src/web-ui/browser/queue-view-adapter.tsx");
  assert.match(base, /container:queue-summary \/ inline-size/);
  assert.match(base, /@container queue-summary \(min-width:180px\)/);
  assert.match(queue, /queue-summary-label">待发消息/);
  const nativeQueue = chat.slice(chat.indexOf("struct ComposerQueue:"), chat.indexOf("private struct QueueItemRow:"));
  assert.match(nativeQueue, /geometry\.size\.width >= 180/);
  assert.match(nativeQueue, /Text\("待发消息"\)/);
  assert.match(nativeQueue, /\.popover\(isPresented: \$expanded, arrowEdge: \.bottom\)/);
  const bar = chat.slice(chat.indexOf("private var composerProgress:"), chat.indexOf("private var modePanel:"));
  assert.ok(bar.indexOf("ComposerQueue(") < bar.indexOf("private var inputBar:"), "queue belongs to the shared header, not editor accessory");
});

test("new-work invitation centers above the composer on both desktop clients", { skip: !available }, () => {
  const styles = source("src/web-ui/react/new-session/start-styles.ts");
  assert.match(styles, /\.new-work-context \{[^\n]*align-items:center; justify-content:center/);
  assert.match(styles, /\.new-work-context \{[^\n]*padding:24px var\(--wand-page-inset\)/);
  const host = source("src/web-ui/react/new-session/host.tsx");
  assert.doesNotMatch(host, /<WandBrandMark/);
  assert.match(host, /今天你想与[\s\S]*new-work-inline-avatar[\s\S]*在[\s\S]*new-work-inline-directory[\s\S]*的[\s\S]*NewSessionTaskField[\s\S]*inline[\s\S]*中创造些什么？/);
  const view = source("macos/Wand/NewSessionView.swift");
  const invitation = view.slice(view.indexOf("private var form: some View"), view.indexOf("private var projectName:"));
  assert.doesNotMatch(invitation, /WandBrandMark/);
  assert.match(invitation, /NewWorkPage \{ width in[\s\S]*content: \{ width in\s+creationFeedback/);
  const page = view.slice(view.indexOf("struct NewWorkPage<"));
  assert.match(page, /Spacer\(minLength: 32\)\s+heading\(geometry.size.width\)\s+Spacer\(minLength: 32\)\s+content\(geometry.size.width\)/);
  assert.match(invitation, /NewWorkInvitation\(width: width\)[\s\S]*showEmployeePicker[\s\S]*showDirectoryOptions[\s\S]*showTaskOptions/);
  const sentence = view.slice(view.indexOf("struct NewWorkInvitation<"));
  assert.match(sentence, /今天你想与[\s\S]*employee\(\)[\s\S]*Text\("在"\)[\s\S]*directory\(\)[\s\S]*Text\("的"\)[\s\S]*task\(\)[\s\S]*中创造些什么？/);
  assert.match(source("macos/Wand/TaskBoardCreateView.swift"), /NewWorkInvitation\(width: width\)/);
  assert.doesNotMatch(invitation, /padding\(\.top, 12\)|Spacer\(minLength: 64\)/);
});

test("native default colors match Web warm and graphite palettes", { skip: !available }, () => {
  const palettes = source("src/web-ui/react/theme-palettes.ts");
  const theme = source("macos/Wand/Theme.swift");
  const warm = palettes.match(/\{ id: "warm",[^\n]+/)?.[0] ?? "";
  const graphite = palettes.match(/\{ id: "graphite",[^\n]+/)?.[0] ?? "";
  for (const [nativeToken, webToken] of [["wandAccent", "primary"], ["background", "background"], ["surface", "surface"], ["border", "border"], ["textPrimary", "text"], ["textSecondary", "secondary"]]) {
    const light = warm.match(new RegExp(`\\b${webToken}: "#([a-f0-9]+)"`))?.[1]?.toUpperCase();
    const dark = graphite.match(new RegExp(`\\b${webToken}: "#([a-f0-9]+)"`))?.[1]?.toUpperCase();
    assert.ok(light && dark, webToken);
    assert.match(theme, new RegExp(`static let ${nativeToken} = dynamic\\(light: hex\\(0x${light}\\), dark: hex\\(0x${dark}\\)\\)`));
  }
});
