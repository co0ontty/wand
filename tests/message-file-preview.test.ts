import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderChatMarkdown } from "../src/web-ui/markdown.js";
import { messageFileTarget, resolvedMessageFileTarget } from "../src/web-ui/message-file-target.js";
import { isArtifactPreviewUrl, localFilePreviewHref, localHttpPreviewHref, localPreviewController } from "../src/web-ui/react/local-preview/controller.js";
import { openLocalPreviewFromLegacy } from "../src/web-ui/browser/local-preview-adapter.js";
import { MarkdownPreview } from "../src/web-ui/react/file-preview/markdown.js";
import { registerFileRoutes } from "../src/server-file-routes.js";
import { WandStorage } from "../src/storage.js";
import type { SessionSnapshot } from "../src/types.js";

test("HTML artifacts have one inline host, and images resolve against their source session", () => {
  const html = renderChatMarkdown("![头像](output/preview.png)\n\n[**三维**预览](output/preview.html)", { sessionId: "source-session" });
  assert.equal((html.match(/class="chat-html-preview"/g) || []).length, 1);
  assert.match(html, /data-html-preview-url="\/api\/session-file\/source-session\?path=output%2Fpreview.html&amp;mode=preview"/);
  assert.match(html, /<img src="\/api\/session-file\/source-session\?path=output%2Fpreview.png"/);
  assert.match(html, /<strong>三维<\/strong>/);
  assert.doesNotMatch(renderChatMarkdown("[x](output/preview.html)"), /chat-html-preview|session-file/);
  const other = renderChatMarkdown("[x](output/preview.html)", { sessionId: "other-session" });
  assert.match(other, /session-file\/other-session/);
  assert.doesNotMatch(other, /source-session/);
});

test("absolute paths and existing file API links converge, but web and unsafe references do not", () => {
  const file = messageFileTarget("file:///tmp/My%20Site/index.html");
  assert.equal(file?.previewUrl, localFilePreviewHref("/tmp/My Site/index.html"));
  assert.deepEqual(messageFileTarget(file!.previewUrl!), file);
  const relative = messageFileTarget("output/index.html", { sessionId: "source" })!;
  assert.deepEqual(messageFileTarget(relative.previewUrl!), relative);
  assert.deepEqual(messageFileTarget("/api/file-raw?path=%2Ftmp%2FMy%20Site%2Findex.html"), file);
  assert.match(renderChatMarkdown("![x](/tmp/a.png)"), /src="\/api\/file-raw\?path=%2Ftmp%2Fa.png"/);
  for (const unsafe of ["javascript:alert(1)", "data:text/html,a", "file://remote/tmp/a.html", "//remote/a.html", "/api/private", "a\u0000.html", "#part"]) {
    assert.equal(messageFileTarget(unsafe, { sessionId: "x" }), null, unsafe);
  }
  assert.equal(messageFileTarget("../outside.html", { cwd: "/tmp/site" }), null);
  assert.equal(messageFileTarget("./assets/../index.htm", { cwd: "/tmp/site" })?.path, "/tmp/site/index.htm");
  assert.equal(messageFileTarget("https://example.com/index.html"), null);
  assert.ok(localPreviewController.openPreview(file!.previewUrl!, "三维预览"));
  assert.equal(localPreviewController.getSnapshot().sourceLabel, "三维预览");
  localPreviewController.close();
  assert.equal(localPreviewController.openPreview("https://example.com/"), false);
});

test("HTML links separate navigation from decoded filenames and survive forwarding", () => {
  const absolute = messageFileTarget("/tmp/demo%23v2%3Ffinal.html?tab=one#settings")!;
  assert.equal(absolute.path, "/tmp/demo#v2?final.html");
  assert.equal(absolute.previewUrl, localFilePreviewHref(absolute.path)! + "?tab=one#settings");
  assert.equal(new URL(absolute.downloadUrl, "http://wand.invalid").searchParams.get("path"), absolute.path);
  assert.deepEqual(messageFileTarget(absolute.previewUrl!), absolute);
  assert.deepEqual(messageFileTarget("file:///tmp/demo%23v2%3Ffinal.html?tab=one#settings"), absolute);
  assert.ok(isArtifactPreviewUrl(absolute.previewUrl!));

  const relative = messageFileTarget("output/demo%23v2%3Ffinal.html?tab=one#settings", { sessionId: "source" })!;
  assert.equal(relative.path, "output/demo#v2?final.html");
  const preview = new URL(relative.previewUrl!, "http://wand.invalid");
  assert.equal(preview.searchParams.get("path"), relative.path);
  assert.equal(preview.searchParams.get("search"), "?tab=one");
  assert.equal(preview.hash, "#settings");
  assert.deepEqual(messageFileTarget(relative.previewUrl!, { sessionId: "wrong-session" }), relative);
  assert.ok(isArtifactPreviewUrl(relative.previewUrl!));
  assert.ok(isArtifactPreviewUrl("/api/session-file/source?mode=preview&path=output%2Fdemo.html#settings"));

  for (const filePath of ["/tmp/notes.md:12:3", "/tmp/demo.html:12", "/tmp/notes%23L12.md"]) {
    const target = messageFileTarget(filePath)!;
    assert.equal(target.path, decodeURIComponent(filePath));
    assert.equal(new URL(target.downloadUrl, "http://wand.invalid").searchParams.get("path"), target.path);
  }
  assert.ok(messageFileTarget("/tmp/demo.html:12:3")?.previewUrl);
  const relativeLocation = messageFileTarget("demo.html:12:3", { sessionId: "source" })!;
  assert.equal(relativeLocation.path, "demo.html:12:3");
  assert.ok(relativeLocation.previewUrl);
  assert.deepEqual(messageFileTarget(relativeLocation.previewUrl!), relativeLocation);
  assert.equal(messageFileTarget("/tmp/notes.md#L12C3")?.path, "/tmp/notes.md");
  assert.equal(messageFileTarget("/tmp/notes%23L12")?.path, "/tmp/notes#L12");
});

test("both Markdown renderers preserve forwarded links and file navigation", () => {
  const previewUrl = localFilePreviewHref("/tmp/demo#v2.html")! + "?tab=one#settings";
  const httpUrl = "/api/local-preview/127.0.0.1/5173/app/?tab=one#settings";
  const content = `[文件](${previewUrl}) [服务](${httpUrl}) [相对](demo.html?tab=one#settings) [源码](/tmp/source.ts:42) [相对源码](source.ts:42)`;
  for (const html of [renderChatMarkdown(content, { sessionId: "source" }),
    renderToStaticMarkup(createElement(MarkdownPreview, { content, fileContext: { sessionId: "source" } }))]) {
    assert.ok(html.includes(`href="${previewUrl}"`));
    assert.ok(html.includes(`href="${httpUrl}"`));
    assert.ok(html.includes("/api/session-file/source?path=demo.html&amp;mode=preview&amp;search=%3Ftab%3Done#settings"));
    assert.ok(html.includes("path=%2Ftmp%2Fsource.ts%3A42"));
    assert.ok(html.includes("path=source.ts%3A42"));
  }
});

test("forwarded preview navigation dispatches through the correct controller and clears stale failures", () => {
  const httpUrl = "/api/local-preview/::1/5173/app/?tab=one#settings";
  assert.equal(localHttpPreviewHref("http://[::1]:5173/app/?tab=one#settings"), httpUrl);
  assert.ok(openLocalPreviewFromLegacy(httpUrl));
  assert.equal(localPreviewController.getSnapshot().mode, "url");
  assert.equal(localPreviewController.getSnapshot().previewUrl, httpUrl);
  assert.equal(localPreviewController.openUrl("https://example.com"), false);
  assert.equal(localPreviewController.getSnapshot().previewUrl, null);
  const artifact = localFilePreviewHref("/tmp/demo.html")! + "?tab=one#settings";
  assert.ok(openLocalPreviewFromLegacy(artifact));
  assert.equal(localPreviewController.getSnapshot().previewUrl, artifact);
  assert.equal(localPreviewController.openFile("relative.html"), false);
  assert.equal(localPreviewController.getSnapshot().previewUrl, null);
  assert.ok(localPreviewController.openUrl(httpUrl));
  localPreviewController.setValue("https://example.com");
  localPreviewController.submit();
  assert.equal(localPreviewController.getSnapshot().previewUrl, null);
  for (const invalid of ["/api/local-preview/example.com/80/", "/api/local-preview/127.0.0.1/0/", "/api/local-preview/127.0.0.1/65536/"]) {
    assert.equal(localHttpPreviewHref(invalid), null);
  }
  localPreviewController.close();
});

test("session artifacts use stored cwd, enforce containment, and serve isolated HTML plus sibling assets", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-message-html-"));
  const site = path.join(root, "site");
  const outside = path.join(root, "outside.html");
  mkdirSync(site);
  writeFileSync(outside, "outside");
  writeFileSync(path.join(site, "index.html"), "<!doctype html><button>运行</button><script src='app.js'></script>");
  writeFileSync(path.join(site, "app.js"), "document.body.dataset.executed = 'yes';");
  symlinkSync(outside, path.join(site, "escape.html"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  storage.saveSession({ id: "source", command: "pi", cwd: site, mode: "default", status: "exited",
    startedAt: new Date().toISOString(), endedAt: null, exitCode: 0, output: "",
    archived: false, archivedAt: null, claudeSessionId: null } satisfies SessionSnapshot);
  const app = express();
  registerFileRoutes(app, { storage, defaultCwd: root });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const target = messageFileTarget("index.html", { sessionId: "source" })!;
    const response = await fetch(origin + target.previewUrl);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/html/);
    assert.match(response.headers.get("content-security-policy") || "", /sandbox allow-scripts/);
    assert.match(response.headers.get("content-security-policy") || "", /connect-src 'none'/);
    assert.match(await response.text(), /<button>运行/);
    assert.equal((await fetch(origin + target.previewUrl, { method: "HEAD" })).status, 200);
    const script = await fetch(new URL("app.js", response.url));
    assert.equal(script.status, 200);
    assert.match(await script.text(), /executed/);
    const download = await fetch(origin + target.downloadUrl);
    assert.match(download.headers.get("content-disposition") || "", /^attachment/);
    assert.equal((await fetch(origin + "/api/session-file/missing?path=index.html&mode=preview")).status, 404);
    for (const relative of ["../outside.html", "escape.html"]) {
      assert.equal((await fetch(origin + "/api/session-file/source?path=" + encodeURIComponent(relative) + "&mode=preview")).status, 403);
    }
    const escaped = await fetch(origin + localFilePreviewHref(site) + "escape.html");
    assert.equal(escaped.status, 403);
    assert.equal((await fetch(origin + "/api/session-file/source?path=%2Ftmp%2Fa.html")).status, 400);
    assert.equal((await fetch(origin + "/api/session-file/source?path=app.js&mode=preview")).status, 400);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    storage.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("link formats preserve server ownership across Markdown renderers", () => {
  const context = { sessionId: "original", serverOrigin: "https://wand.example:8443" };
  const relative = messageFileTarget("./docs/../说明%20书.md:12", context)!;
  assert.equal(new URL(relative.rawUrl, context.serverOrigin).pathname, "/api/session-file/original");
  for (const format of [relative.rawUrl, context.serverOrigin + relative.rawUrl]) {
    assert.deepEqual(messageFileTarget(format, { ...context, sessionId: "unrelated" }), relative);
  }
  const html = messageFileTarget("~/预览/index.html?tab=one#settings", context)!;
  assert.equal(html.path, "~/预览/index.html");
  assert.deepEqual(messageFileTarget(html.previewUrl!, context), html);
  const forwarded = "/api/local-file/" + Buffer.from("/tmp/site").toString("base64url") + "/sub/demo.html?tab=two&mode=download#panel";
  assert.equal(messageFileTarget(context.serverOrigin + forwarded, context)?.previewUrl, forwarded);
  const nestedFile = messageFileTarget(forwarded.replace("demo.html", "说明.md"), context)!;
  assert.equal(nestedFile.previewUrl, null);
  assert.match(nestedFile.downloadUrl, /__wand_file_action=download/);
  assert.equal(messageFileTarget("https://elsewhere.example" + relative.rawUrl, context), null);
  assert.ok(messageFileTarget("./docs/", context)?.previewUrl?.includes("mode=preview"));
  const directory = messageFileTarget("./docs/", { cwd: "/tmp/project" })!;
  assert.equal(directory.path, "/tmp/project/docs/");
  assert.ok(directory.downloadUrl.endsWith("?__wand_file_action=download"));
  assert.deepEqual(messageFileTarget(directory.previewUrl!), directory);
  for (const address of ["localhost:5173/app?tab=one#panel", "127.0.0.1:5173/app?tab=one#panel", "[::1]:5173/app?tab=one#panel"]) {
    assert.equal(messageFileTarget(address, context), null);
    const expected = localHttpPreviewHref(address)!;
    assert.ok(expected.endsWith("/5173/app?tab=one#panel"));
    const content = `[本地应用](${address})`;
    for (const rendered of [renderChatMarkdown(content, context), renderToStaticMarkup(createElement(MarkdownPreview, { content, fileContext: context }))]) {
      assert.ok(rendered.includes(expected), rendered);
      assert.doesNotMatch(rendered, /session-file/);
    }
  }
  assert.equal(localHttpPreviewHref("http://user:pass@localhost:5173/"), null);
  const legacy = renderChatMarkdown("[说明](docs/readme.md)", context);
  assert.match(legacy, /data-server-file-url="\/api\/session-file\/original\?path=docs%2Freadme.md"/);
  assert.match(legacy, /window\.__openFilePreview/);
});

test("forwarded roots resolve actual directory indexes and ordinary documents instead of guessing their kind", () => {
  for (const root of ["/tmp/site", "/tmp/site.with.dots", "/tmp/document.pdf"]) {
    const preview = localFilePreviewHref(root)! + "?mode=edit&literal=a%2Bb#panel";
    const target = messageFileTarget(preview)!;
    assert.equal(target.rawUrl, preview);
    assert.equal(target.previewUrl, null);
    assert.ok(target.downloadUrl.includes("__wand_file_action=download"));
    assert.ok(renderChatMarkdown(`[文件](${preview})`).includes("window.__openFilePreview"));
  }
  const source = localFilePreviewHref("/tmp/site.with.dots")! + "?mode=edit#panel";
  const html = resolvedMessageFileTarget("/tmp/site.with.dots/index#final.html", source)!;
  assert.equal(html.previewUrl, source);
  assert.equal(new URL(html.downloadUrl, "http://wand.invalid").searchParams.get("path"), "/tmp/site.with.dots/index#final.html");
  assert.equal(resolvedMessageFileTarget("/tmp/report.pdf", source)?.previewUrl, null);
});
