import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildTerminalPasteSequence,
  buildTerminalPathPasteSequence,
  clipboardImageExtension,
  isClipboardImageMimeType,
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
  assert.match(engine, /buildTerminalPathPasteSequence\(path, bracketedPaste\)/);
  assert.match(engine, /"terminal",\s*sessionId,/);
  assert.match(events, /document\.addEventListener\("paste"/);
  assert.match(engine, /function ptyPasteTargetSessionId/);
  assert.match(engine, /target\.closest\("#output, \.xterm"\)/);
  assert.match(input, /buildTerminalPathPasteSequence\(\s*\n?\s*file\.savedPath/);
});
