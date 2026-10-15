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
  // Web input-wrap starts 11pt below surface top: -76 + 11 = -65.
  assert.match(native, /frame\(height: hasPortrait \? \(kind == \.task \? 65 : 76\)/);
  assert.match(native, /portrait\(\)\.frame\(width: 72, height: 72\)/);
  assert.match(native, /padding\(\.leading, 84\)/);
  assert.match(native, /\(viewportWidth \?\? geometry\.size\.width\) > 640/);
  assert.match(native, /window\?\.contentLayoutRect\.width/);
  assert.match(chat, /modelThinkingChip\(inMenu: false\)/);
  assert.match(chat, /thinkingChip\(inMenu: false\)/);
  const bar = chat.slice(chat.indexOf("private var inputBar:"), chat.indexOf("private var modePanel:"));
  assert.doesNotMatch(bar, /ComposerSettingLabel\(title:.*权限/);
  assert.match(chat, /modelThinkingChip\(inMenu: true\)/);
  assert.match(chat, /thinkingChip\(inMenu: true\)/);
  assert.match(chat, /showComposerActions == inMenu/);
  assert.match(communications, /ComposerIdentityHeader\(kind: \.conversation/);
});

test("footer follows Web add, voice, entry, submit order and full-width editor", { skip: !available }, () => {
  const surface = native.slice(native.indexOf("struct FocusComposerSurface"), native.indexOf("enum ComposerHeaderKind"));
  const ordered = ["editor()", "add()", "ComposerVoiceUnavailableButton()", "Button(action: onFocus)", "send()"];
  let previous = -1;
  for (const marker of ordered) {
    const index = surface.indexOf(marker);
    assert.ok(index > previous, marker);
    previous = index;
  }
  assert.doesNotMatch(surface, /padding\(\.horizontal, 16\)/);
  assert.match(native, /语音输入，macOS 尚未接入/);
  assert.match(native, /buttonStyle\(ComposerControlStyle\(\)\)\.disabled\(true\)/);
  assert.match(chat, /isFocused: inputFocused/);
  assert.match(chat, /textView\.font = \.systemFont\(ofSize: 14\)/);
  assert.match(chat, /textView\.textContainerInset = \.zero/);
  assert.match(chat, /textContainer\?\.lineFragmentPadding = 0/);
  assert.match(chat, /paragraph\.minimumLineHeight = 21; paragraph\.maximumLineHeight = 21/);
  assert.match(communications, /isFocused: focus.focused/);
  assert.match(native, /RoundedRectangle\(cornerRadius: FocusComposerMetrics\.controlRadius\)\.fill\(tint\)/);
  assert.match(native, /stopping \? Theme\.danger/);
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
