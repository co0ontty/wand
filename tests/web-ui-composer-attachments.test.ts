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

test("附件注册表按 item 明细比较，值没变不广播", () => {
  const controller = new ComposerAttachmentsController();
  let notifications = 0;
  const unsubscribe = controller.subscribe(() => { notifications += 1; });

  controller.sync([mountFor()]);
  assert.equal(notifications, 1);
  const first = controller.getSnapshot();

  // renderAttachmentPreview() 每次都会重放；回调变了但 items 相同不能广播。
  controller.sync([mountFor(ITEMS, { onRemove() {} })]);
  assert.equal(notifications, 1);
  assert.equal(controller.getSnapshot(), first);

  // 只有大小文案变化也要广播（对象字面量是新建的，必须逐字段比较）。
  controller.sync([mountFor([
    { ...ITEMS[0], sizeLabel: "12.5 KB" },
    ITEMS[1],
  ])]);
  assert.equal(notifications, 2);

  controller.sync([mountFor([ITEMS[1]], { key: "composer-attachments" })]);
  assert.equal(notifications, 3);
  assert.equal(controller.getSnapshot().mounts[0].items.length, 1);

  // 列表清空 → 适配器传空 mounts。
  controller.clear();
  assert.equal(notifications, 4);
  assert.equal(controller.getSnapshot().mounts.length, 0);
  unsubscribe();
});

test("图片附件渲染 img，其他类型渲染 file 图标", () => {
  const html = render(mountFor());
  assert.equal((html.match(/<img src="blob:wand\/1" alt=""\/>/g) || []).length, 1);
  assert.equal((html.match(/class="att-icon"/g) || []).length, 1);
});

test("pill 暴露下标、大小与可访问的移除按钮", () => {
  const html = render(mountFor());
  assert.match(html, /<span class="attachment-pill" data-index="0">/);
  assert.match(html, /data-index="1"/);
  assert.match(html, /class="att-size">12.4 KB</);
  assert.match(html, /title="shot\.png">shot\.png</);
  assert.match(html, /class="att-remove" data-index="0" type="button" title="移除" aria-label="移除附件 shot\.png"/);
  assert.equal((html.match(/class="att-remove"/g) || []).length, 2);
});

test("预览条保留原有 class 与 live region 语义", () => {
  const html = render(mountFor());
  assert.match(html, /<div class="attachment-preview" aria-label="待发送附件" aria-live="polite">/);
  // 空状态交给适配器（不发布 mount），不再用 .hidden。
  assert.doesNotMatch(html, /attachment-preview hidden/);
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
