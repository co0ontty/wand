import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ComposerAttachmentsController,
  type ComposerAttachmentItem,
  type ComposerAttachmentsMount,
} from "../src/web-ui/react/composer-attachments/controller.ts";
import { ComposerAttachments } from "../src/web-ui/react/composer-attachments/host.tsx";

const TARGET = {} as HTMLElement;

const ITEMS: readonly ComposerAttachmentItem[] = [
  { index: 0, name: "shot.png", sizeLabel: "12.4 KB", previewUrl: "blob:wand/1" },
  { index: 1, name: "notes.txt", sizeLabel: "3 B", previewUrl: null },
];

function mountFor(
  items: ReadonlyArray<ComposerAttachmentItem> = ITEMS,
  overrides: Partial<ComposerAttachmentsMount> = {},
): ComposerAttachmentsMount {
  return { key: "composer-attachments", target: TARGET, items, onRemove() {}, ...overrides };
}

function render(mount: ComposerAttachmentsMount): string {
  return renderToStaticMarkup(React.createElement(ComposerAttachments, { mount }));
}

test("附件只使用 X 的展示入口，SSR 保留 live region 与受控上传", () => {
  const html = render(mountFor());
  assert.match(html, /ant-attachment/);
  assert.match(html, /aria-label="待发送附件" aria-live="polite"/);
  assert.match(html, /ant-upload-select" style="display:none"/);
  assert.doesNotMatch(html, /attachment-pill|att-remove/);
});

test("附件身份、大小与移除动作映射到唯一 composer 快照", () => {
  const host = readFileSync(new URL("../src/web-ui/react/composer-attachments/host.tsx", import.meta.url), "utf8");
  assert.match(host, /uid: String\(item\.index\)/);
  assert.match(host, /size: item\.size/);
  assert.match(host, /thumbUrl: item\.previewUrl/);
  assert.match(host, /onRemove\(Number\(item\.uid\)\)/);
  assert.match(host, /node\.setAttribute\("aria-label", `移除附件/);
  assert.match(host, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(host, /getDropContainer=\{\(\) => null\}/);
  // Actual image/file rendering and keyboard removal are covered by the opt-in production Chrome gate.
});

test("预览条播报新附件，空列表的挂载由适配器负责", () => {
  assert.match(render(mountFor()), /<div aria-label="待发送附件" aria-live="polite">/);
  assert.doesNotMatch(render(mountFor()), /attachment-preview hidden/);
});

test("适配器在空列表时不发布 mount，legacy 侧不再重建 DOM", () => {
  const adapter = readFileSync(
    new URL("../src/web-ui/browser/composer-attachments-adapter.ts", import.meta.url),
    "utf8",
  );
  assert.match(adapter, /if \(items\.length === 0\) return null;/);
  assert.match(adapter, /data-composer-attachments-host/);

  const sessionEngine = readFileSync(
    new URL("../src/web-ui/browser/session-engine.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(sessionEngine, /getElementById\("attachment-preview"\)/);
  assert.doesNotMatch(sessionEngine, /att-remove"\)\.forEach/);
  assert.doesNotMatch(sessionEngine, /bar\.innerHTML = html;/);
});
