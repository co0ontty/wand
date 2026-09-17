import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildPtyAttachmentChunks,
  buildTerminalPasteSequence,
  buildTerminalPathPasteSequence,
  clipboardImageExtension,
  isClipboardImageMimeType,
  isImageAttachmentSource,
  providerGluesAfterAttachment,
  quoteTerminalPath,
} from "../src/web-ui/browser/pty-paste.js";

test("terminal paste uses bracketed-paste delimiters so TUIs receive one paste event", () => {
  assert.equal(
    buildTerminalPasteSequence("/tmp/image with spaces.png"),
    "\u001b[200~/tmp/image with spaces.png\u001b[201~",
  );
  assert.equal(buildTerminalPasteSequence("first\nsecond"), "\u001b[200~first\rsecond\u001b[201~");
  assert.equal(buildTerminalPasteSequence("first\nsecond", false), "first\rsecond");
  assert.equal(buildTerminalPasteSequence("safe\u001b[201~tail"), "\u001b[200~safe␛[201~tail\u001b[201~");
  assert.equal(buildTerminalPasteSequence(""), "");
});

test("terminal image-path paste preserves paths that contain shell punctuation", () => {
  assert.equal(quoteTerminalPath("/tmp/image.png"), "/tmp/image.png");
  assert.equal(quoteTerminalPath("/tmp/image with spaces.png"), "'/tmp/image with spaces.png'");
  assert.equal(quoteTerminalPath("/tmp/owner's image.png"), "'/tmp/owner'\\''s image.png'");
  assert.equal(
    buildTerminalPathPasteSequence("/tmp/image with spaces.png"),
    "\u001b[200~'/tmp/image with spaces.png'\u001b[201~",
  );
});

test("clipboard image detection accepts browser image MIME types", () => {
  assert.equal(isClipboardImageMimeType("image/png"), true);
  assert.equal(isClipboardImageMimeType("IMAGE/JPEG"), true);
  assert.equal(isClipboardImageMimeType("text/plain"), false);
  assert.equal(isClipboardImageMimeType(undefined), false);
  assert.equal(clipboardImageExtension("image/jpeg"), ".jpg");
  assert.equal(clipboardImageExtension("image/webp"), ".webp");
  assert.equal(clipboardImageExtension("image/png"), ".png");
});

test("web PTY image paste is wired through upload and stable-session input", () => {
  const engine = readFileSync(
    new URL("../src/web-ui/browser/session-engine.ts", import.meta.url),
    "utf8",
  );
  const events = readFileSync(
    new URL("../src/web-ui/browser/events.ts", import.meta.url),
    "utf8",
  );
  const input = readFileSync(
    new URL("../src/web-ui/browser/input.ts", import.meta.url),
    "utf8",
  );

  assert.match(engine, /export function handlePtyImagePaste/);
  assert.match(engine, /uploadAttachments\(sessionId, entries\)/);
  assert.match(engine, /buildPtyAttachmentChunks\(uploadedFiles, \{/);
  assert.match(engine, /"terminal",\s*sessionId\);/);
  assert.match(events, /document\.addEventListener\("paste"/);
  assert.match(engine, /function ptyPasteTargetSessionId/);
  assert.match(engine, /target\.closest\("#output, \.xterm"\)/);
  assert.match(input, /buildPtyAttachmentChunks\(imageFiles, \{/);
});

test("attachment chunks separate the chip from the next chunk unless the CLI does", () => {
  const image = { savedPath: "/tmp/pic.png", mimeType: "image/png" };
  const note = { savedPath: "/tmp/note.txt", mimeType: "text/plain" };

  // claude / pi glue the chip to the next chunk, so every attachment needs the space.
  assert.equal(providerGluesAfterAttachment("claude"), true);
  assert.equal(providerGluesAfterAttachment("Pi"), true);
  for (const provider of ["codex", "opencode", "grok", "qoder", "unknown", undefined]) {
    assert.equal(providerGluesAfterAttachment(provider), false);
  }

  // Codex-style provider: its own chip spacing, so no extra space for the image,
  // but a plain path would glue to the next keystroke and still needs one.
  // 图片粘贴带 image 标记，写入方据此给紧随其后的那一包更长的重绘预算。
  assert.deepEqual(buildPtyAttachmentChunks([image, note], { provider: "codex" }), [
    { data: "\u001b[200~/tmp/pic.png\u001b[201~", shortcutKey: "paste", image: true },
    { data: "\u001b[200~/tmp/note.txt\u001b[201~", shortcutKey: "paste" },
    { data: " " },
  ]);

  // claude-style provider: chip does not space itself.
  assert.deepEqual(buildPtyAttachmentChunks([image], { provider: "claude" }), [
    { data: "\u001b[200~/tmp/pic.png\u001b[201~", shortcutKey: "paste", image: true },
    { data: " " },
  ]);

  // No provider known yet (terminal passthrough on an unknown command): keep the
  // separator so text never glues to the pasted path.
  assert.deepEqual(buildPtyAttachmentChunks([note], {}), [
    { data: "\u001b[200~/tmp/note.txt\u001b[201~", shortcutKey: "paste" },
    { data: " " },
  ]);

  // Multiple files keep one paste boundary each, so each becomes its own chip.
  assert.deepEqual(buildPtyAttachmentChunks([image, note, image], { bracketedPaste: false }), [
    { data: "/tmp/pic.png", shortcutKey: "paste", image: true },
    { data: "/tmp/note.txt", shortcutKey: "paste" },
    { data: " " },
    { data: "/tmp/pic.png", shortcutKey: "paste", image: true },
  ]);

  // Paths that need shell quoting stay quoted, entries without a path are skipped.
  assert.deepEqual(
    buildPtyAttachmentChunks(
      [{ savedPath: "/tmp/with space.png" }, { savedPath: "/tmp/note with space.txt" }, null],
      { provider: "grok" },
    ),
    [
      { data: "\u001b[200~'/tmp/with space.png'\u001b[201~", shortcutKey: "paste", image: true },
      { data: "\u001b[200~'/tmp/note with space.txt'\u001b[201~", shortcutKey: "paste" },
      { data: " " },
    ],
  );
});

test("attachment image detection covers MIME type, path and original name", () => {
  assert.equal(isImageAttachmentSource({ mimeType: "image/png" }), true);
  assert.equal(isImageAttachmentSource({ savedPath: "/tmp/a.JPEG" }), true);
  assert.equal(isImageAttachmentSource({ originalName: "shot.webp" }), true);
  assert.equal(isImageAttachmentSource({ savedPath: "/tmp/a.txt", mimeType: "text/plain" }), false);
  assert.equal(isImageAttachmentSource(null), false);
});

test("composer attachment submission tags the paste and the prompt separately", () => {
  const input = readFileSync(
    new URL("../src/web-ui/browser/input.ts", import.meta.url),
    "utf8",
  );
  // Path chunks keep shortcutKey "paste" (out of the session-topic inference);
  // only the typed text and the Enter carry enter_text.
  assert.match(input, /ptyAttachmentChunks\.push\(\{ data: ptyText, shortcutKey: "enter_text" \}\)/);
  assert.match(input, /var submitChunks = ptyAttachmentChunks \|\| getTerminalSubmitChunks/);
  assert.match(input, /function normalizeTerminalChunk\(entry\)/);
  assert.match(input, /chunk\.shortcutKey !== undefined/);
  // 图片芯片比普通重绘慢，紧跟图片粘贴后的那一包要等更久（见 PTY_IMAGE_CHIP_SETTLE_MAX_MS）。
  assert.match(input, /previousChunk\.image \? PTY_IMAGE_CHIP_SETTLE_MAX_MS : undefined/);
  assert.match(input, /var PTY_IMAGE_CHIP_SETTLE_MAX_MS = 3000;/);
  assert.match(input, /return \{ data: entry\.data, shortcutKey: entry\.shortcutKey, image: !!entry\.image \};/);
  // 冷启动的 CLI 还没进 bracketed paste 模式，恢复后先把粘贴序列写成字面量
  // （codex 草稿行出现 ^[[200~）。所以发送前等它画出 TUI。
  assert.match(input, /return waitForProviderPaint\(\)\.then\(function\(\) \{ return data; \}\)/);
  assert.match(
    readFileSync(new URL("../src/web-ui/browser/terminal.ts", import.meta.url), "utf8"),
    /export function waitForProviderPaint\(timeoutMs\?: number\)/,
  );
});

test("terminal view keeps the attachment button and one waiting batch per pick", () => {
  const engine = readFileSync(
    new URL("../src/web-ui/browser/session-engine.ts", import.meta.url),
    "utf8",
  );
  const css = readFileSync(
    new URL("../src/web-ui/content/styles.css", import.meta.url),
    "utf8",
  );
  const terminal = readFileSync(
    new URL("../src/web-ui/browser/terminal.ts", import.meta.url),
    "utf8",
  );

  // One picker selection = one upload request + one serialized write batch;
  // per-file calls let "previous chip separator" interleave with "next path".
  assert.match(engine, /export function addPendingAttachments\(files\)/);
  assert.match(engine, /var attachmentWriteChain: Promise<unknown> = Promise\.resolve\(\)/);
  assert.match(engine, /return index < chunks\.length - 1 \? send\.then\(waitForTerminalSettled\) : send/);

  // claude / pi repaint the draft line when they swap a path for [Image #N], so
  // the next chunk waits for terminal output to settle instead of a fixed delay.
  assert.match(terminal, /export function waitForTerminalSettled\(wroteAtMs\?: number, maxMs\?: number\)/);

  // 直通 composer: 排版成三列把附件按钮放回来（composer-actions-left 占第 1 列，
  // 输入行占第 2 列），popover 里只留上传附件，锚点上移到 62px 对齐 50px 高的一行。
  assert.match(
    css,
    /html:not\(\.is-wand-app\) \.input-composer\.is-terminal-interactive \.composer-main-row[^{]*\{\s*grid-template-columns: auto minmax\(0, 1fr\) auto;/,
  );
  assert.match(
    css,
    /html:not\(\.is-wand-app\) \.input-composer\.is-terminal-interactive \.composer-actions-left[^{]*\{\s*grid-column: 1;/,
  );
  assert.match(
    css,
    /\has\(\.input-composer\.is-terminal-interactive\) \.composer-plus-popover > \.plus-popover-trio-wrap \{\s*display: none !important;/,
  );
  assert.match(
    css,
    /\has\(\.input-composer\.is-terminal-interactive\) \.composer-plus-popover \{\s*bottom: calc\(\s*62px/,
  );
});
