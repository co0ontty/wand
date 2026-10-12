import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { renderChatMarkdown } from "../src/web-ui/markdown.js";
import { messageFileTarget } from "../src/web-ui/message-file-target.js";
import { localFilePreviewHref, localPreviewController } from "../src/web-ui/react/local-preview/controller.js";
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
