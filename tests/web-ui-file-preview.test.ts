import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createFilePreviewModule } from "../src/web-ui/react/file-preview/controller.ts";
import { MemoryFilePreviewRepository } from "../src/web-ui/react/file-preview/memory-repository.ts";
import {
  clampFilePreviewFontSize,
  formatFilePreviewSize,
  nextFilePreviewSibling,
  normalizeFilePreviewRequest,
  parseFilePreviewMarkdown,
  shellQuoteFilePath,
  tokenizeFilePreviewCode,
  tokenizeFilePreviewMarkdownInline,
} from "../src/web-ui/react/file-preview/model.ts";
import { HttpFilePreviewRepository } from "../src/web-ui/react/file-preview/repository.ts";
import type {
  FilePreviewFile,
  FilePreviewRuntimeAdapter,
} from "../src/web-ui/react/file-preview/types.ts";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textFile(path = "/tmp/a.ts", content = "const value = 1;"): FilePreviewFile {
  const name = path.split("/").pop() || "a.ts";
  return {
    kind: "text",
    path,
    name,
    ext: ".ts",
    mime: "text/plain",
    lang: "typescript",
    content,
    size: new TextEncoder().encode(content).byteLength,
    rawUrl: `/raw/${name}`,
    url: `/download/${name}`,
  };
}

test("file preview model normalizes siblings, wraps navigation, and clamps view state", () => {
  const request = normalizeFilePreviewRequest({
    path: " /tmp/a.ts ",
    siblings: [
      { path: "/tmp/folder", type: "dir" },
      { path: "/tmp/a.ts" },
      { path: "/tmp/b.ts", name: " b.ts " },
      { path: "/tmp/b.ts" },
    ],
  });

  assert.deepEqual(request, {
    path: "/tmp/a.ts",
    siblings: [
      { path: "/tmp/a.ts", name: "a.ts", type: "file" },
      { path: "/tmp/b.ts", name: "b.ts", type: "file" },
    ],
  });
  assert.equal(nextFilePreviewSibling(request, -1)?.path, "/tmp/b.ts");
  assert.equal(nextFilePreviewSibling({ ...request!, path: "/tmp/b.ts" }, 1)?.path, "/tmp/a.ts");
  assert.equal(clampFilePreviewFontSize(-100), 10);
  assert.equal(clampFilePreviewFontSize(100), 22);
  assert.equal(clampFilePreviewFontSize(Number.NaN), 13);
  assert.equal(formatFilePreviewSize(1536), "1.5 KB");
  assert.equal(shellQuoteFilePath("/tmp/a'b"), "'/tmp/a'\\''b'");
});

test("safe code and Markdown models preserve formatting without executable HTML", () => {
  const code = tokenizeFilePreviewCode("const answer = 'yes'; // note");
  assert.ok(code.some((token) => token.value === "const" && token.kind === "keyword"));
  assert.ok(code.some((token) => token.value === "'yes'" && token.kind === "string"));
  assert.ok(code.some((token) => token.value === "// note" && token.kind === "comment"));

  const unsafe = tokenizeFilePreviewMarkdownInline(
    "[unsafe](javascript:alert(1)) ![bad](javascript:alert(2)) [safe](https://example.com)",
  );
  assert.ok(!unsafe.some((token) => (token.type === "link" || token.type === "image") && token.url.startsWith("javascript:")));
  assert.ok(unsafe.some((token) => token.type === "link" && token.url === "https://example.com"));

  const blocks = parseFilePreviewMarkdown([
    "# Title",
    "",
    "| left | right |",
    "| :--- | ---: |",
    "| one | two |",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "",
    "<script>alert(1)</script>",
  ].join("\n"));
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "table", "code", "paragraph"]);
  assert.equal(blocks.find((block) => block.type === "table")?.aligns[1], "right");

  const host = readFileSync(new URL("../src/web-ui/react/file-preview/host.tsx", import.meta.url), "utf8");
  assert.ok(!host.includes("dangerouslySetInnerHTML"));
  assert.ok(!host.includes("innerHTML ="));
});

test("memory repository clones reads, records calls, saves text, and exposes failures", async () => {
  const repository = new MemoryFilePreviewRepository({ files: [textFile()] });
  const first = await repository.load("/tmp/a.ts");
  assert.equal(first.ok, true);
  if (first.ok) first.file.content = "mutated outside repository";
  const second = await repository.load("/tmp/a.ts");
  assert.equal(second.ok && second.file.content, "const value = 1;");

  const save = await repository.save("/tmp/a.ts", "你好");
  assert.deepEqual(save, { ok: true, result: { path: "/tmp/a.ts", size: 6 } });
  const afterSave = await repository.load("/tmp/a.ts");
  assert.equal(afterSave.ok && afterSave.file.content, "你好");
  assert.deepEqual(repository.calls.map((call) => call.operation), ["load", "load", "save", "load"]);

  repository.setLoadFailure("/tmp/a.ts", { message: "denied", status: 403 });
  assert.deepEqual(await repository.load("/tmp/a.ts"), {
    ok: false,
    failure: { message: "denied", status: 403 },
  });
});

test("HTTP repository preserves preview/write contracts and 413 downloads", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const repository = new HttpFilePreviewRepository(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("/api/file-preview")) {
      if (url.includes("large")) return json({ error: "too large", size: 8_000_000, maxSize: 4_000_000 }, 413);
      return json({
        kind: "text",
        path: "/tmp/a b.md",
        name: "a b.md",
        size: 12,
        mime: "text/markdown",
        lang: "markdown",
        content: "# hello",
      });
    }
    return json({ path: "/tmp/a b.md", size: 3, mtime: "now" });
  });

  const loaded = await repository.load("/tmp/a b.md");
  assert.equal(calls[0].url, "/api/file-preview?path=%2Ftmp%2Fa%20b.md");
  assert.equal(loaded.ok && loaded.file.rawUrl, "/api/file-raw?path=%2Ftmp%2Fa%20b.md");
  assert.equal(loaded.ok && loaded.file.url, "/api/file-raw?download=1&path=%2Ftmp%2Fa%20b.md");

  const tooLarge = await repository.load("/tmp/large.bin");
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) {
    assert.equal(tooLarge.failure.status, 413);
    assert.equal(tooLarge.failure.download?.url, "/api/file-raw?download=1&path=%2Ftmp%2Flarge.bin");
  }

  assert.deepEqual(await repository.save("/tmp/a b.md", "new"), {
    ok: true,
    result: { path: "/tmp/a b.md", size: 3, mtime: "now" },
  });
  assert.equal(calls[2].url, "/api/file-write");
  assert.equal(calls[2].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), { path: "/tmp/a b.md", content: "new" });
});

test("controller owns navigation, editing, save, runtime commands, and view state", async () => {
  const copied: string[] = [];
  const composer: string[] = [];
  const notices: Array<[string, string]> = [];
  const saved: string[] = [];
  const confirmations: string[] = [];
  const runtime: FilePreviewRuntimeAdapter = {
    confirmDiscard: async (reason) => { confirmations.push(reason); return true; },
    copyText: async (value) => { copied.push(value); },
    appendToComposer: (value) => { composer.push(value); return true; },
    notify: (message, tone) => { notices.push([message, tone]); },
    onSaved: async (path) => { saved.push(path); },
  };
  const repository = new MemoryFilePreviewRepository({
    files: [
      textFile("/tmp/a.ts", "const a = 1;"),
      textFile("/tmp/b.ts", "const b = 2;"),
      { ...textFile("/tmp/photo.png", ""), kind: "image", ext: ".png", content: undefined },
    ],
  });
  const module = createFilePreviewModule({ repository, runtime });
  const siblings = [
    { path: "/tmp/a.ts" },
    { path: "/tmp/b.ts" },
    { path: "/tmp/photo.png" },
  ];

  assert.equal(await module.controller.open({ path: "/tmp/a.ts", siblings }), true);
  assert.equal(module.store.getSnapshot().status, "ready");
  assert.equal(await module.controller.execute({ type: "navigate", direction: -1 }), true);
  assert.equal(module.store.getSnapshot().request?.path, "/tmp/photo.png");
  assert.equal(await module.controller.execute({ type: "view.image.zoom.toggle" }), true);
  assert.equal(module.store.getSnapshot().imageZoomed, true);
  assert.equal(await module.controller.execute({ type: "navigate", direction: 1 }), true);

  assert.equal(await module.controller.execute({ type: "edit.enter" }), true);
  assert.equal(await module.controller.execute({ type: "edit.change", value: "const a = 3;" }), true);
  assert.equal(module.store.getSnapshot().dirty, true);
  assert.equal(await module.controller.execute({ type: "navigate", direction: 1 }), false);
  assert.equal(await module.controller.execute({ type: "edit.save" }), true);
  assert.equal(module.store.getSnapshot().dirty, false);
  assert.equal(module.store.getSnapshot().file?.content, "const a = 3;");
  assert.deepEqual(saved, ["/tmp/a.ts"]);

  assert.equal(await module.controller.execute({ type: "edit.exit" }), true);
  await module.controller.execute({ type: "copy.path" });
  await module.controller.execute({ type: "copy.content" });
  await module.controller.execute({ type: "composer.path" });
  await module.controller.execute({ type: "composer.cat" });
  await module.controller.execute({ type: "view.wrap.toggle" });
  await module.controller.execute({ type: "view.font.adjust", delta: 100 });
  assert.deepEqual(copied, ["/tmp/a.ts", "const a = 3;"]);
  assert.deepEqual(composer, ["/tmp/a.ts", "cat -- '/tmp/a.ts'"]);
  assert.equal(module.store.getSnapshot().wrap, true);
  assert.equal(module.store.getSnapshot().fontSize, 22);
  assert.ok(notices.some(([message, tone]) => message === "已保存" && tone === "success"));
  assert.deepEqual(confirmations, []);
});

test("dirty confirmation keeps state on cancel and discards only after approval", async () => {
  const decisions = [false, true, false, true];
  const reasons: string[] = [];
  const repository = new MemoryFilePreviewRepository({
    files: [textFile("/tmp/a.ts", "a"), textFile("/tmp/b.ts", "b")],
  });
  const module = createFilePreviewModule({
    repository,
    runtime: {
      confirmDiscard: async (reason) => { reasons.push(reason); return decisions.shift() ?? false; },
      copyText: async () => {},
      appendToComposer: () => true,
      notify: () => {},
      onSaved: () => {},
    },
  });

  await module.controller.open("/tmp/a.ts");
  await module.controller.execute({ type: "edit.enter" });
  await module.controller.execute({ type: "edit.change", value: "changed" });
  assert.equal(await module.controller.execute({ type: "edit.exit" }), false);
  assert.equal(module.store.getSnapshot().editing, true);
  assert.equal(await module.controller.execute({ type: "edit.exit" }), true);
  assert.equal(module.store.getSnapshot().editing, false);

  await module.controller.execute({ type: "edit.enter" });
  await module.controller.execute({ type: "edit.change", value: "changed again" });
  assert.equal(await module.controller.open("/tmp/b.ts"), false);
  assert.equal(module.store.getSnapshot().request?.path, "/tmp/a.ts");
  assert.equal(await module.controller.open("/tmp/b.ts"), true);
  assert.equal(module.store.getSnapshot().request?.path, "/tmp/b.ts");
  assert.deepEqual(reasons, ["exit-edit", "exit-edit", "replace", "replace"]);
  assert.equal(await module.controller.execute({ type: "close" }), true);
  assert.equal(module.controller.isOpen(), false);
});

test("clean close is synchronous so a competing overlay never overlaps it", async () => {
  const repository = new MemoryFilePreviewRepository({ files: [textFile()] });
  const module = createFilePreviewModule({
    repository,
    runtime: {
      confirmDiscard: async () => true,
      copyText: async () => {},
      appendToComposer: () => true,
      notify: () => {},
      onSaved: () => {},
    },
  });

  await module.controller.open("/tmp/a.ts");
  assert.equal(module.controller.closeIfOpen(), true);
  assert.equal(module.controller.isOpen(), false, "clean preview must close before closeIfOpen returns");
});
