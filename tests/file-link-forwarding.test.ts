import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { registerFileRoutes } from "../src/server-file-routes.js";
import { WandStorage } from "../src/storage.js";
import { NonHtmlPreviewResponse, probeHtmlPreview } from "../src/web-ui/react/local-preview/repository.js";

test("file links preserve exact colon names, fall back for editor locations, and preserve HTML navigation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wand-forwarded-file-"));
  const storage = new WandStorage(path.join(root, "wand.db"));
  storage.saveSession({ id: "source", command: "pi", cwd: root, mode: "default", status: "exited", startedAt: new Date().toISOString(), endedAt: null,
    exitCode: 0, output: "", archived: false, archivedAt: null, claudeSessionId: null });
  await writeFile(path.join(root, "report:2025"), "exact filename");
  await writeFile(path.join(root, "report"), "wrong fallback");
  await writeFile(path.join(root, " literal name.txt "), "literal whitespace");
  await writeFile(path.join(root, "app.txt"), "editor file");
  await writeFile(path.join(root, "index.html"), "<h1>preview</h1>");
  await writeFile(path.join(root, "index.html:2025"), "<h1>exact HTML</h1>");
  await mkdir(path.join(root, "sub"));
  await writeFile(path.join(root, "sub/index.html"), "nested preview");
  await mkdir(path.join(root, "site.with.dots"));
  await writeFile(path.join(root, "site.with.dots/index.html"), "<h1>large preview</h1>" + " ".repeat(512 * 1024));
  await mkdir(path.join(root, "site:2025"));
  await writeFile(path.join(root, "site:2025/index.html"), "exact directory");
  await writeFile(path.join(root, "site"), "wrong directory fallback");
  const app = express();
  registerFileRoutes(app, { storage, defaultCwd: root });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const raw = (name: string) => `${origin}/api/file-raw?path=${encodeURIComponent(path.join(root, name))}`;
  try {
    assert.equal(await (await fetch(raw("report:2025"))).text(), "exact filename");
    assert.equal(await (await fetch(raw(" literal name.txt "))).text(), "literal whitespace");
    assert.equal(await (await fetch(raw("app.txt:12:3"))).text(), "editor file");
    const preview = await (await fetch(`${origin}/api/file-preview?path=${encodeURIComponent(path.join(root, "app.txt:12"))}`)).json();
    assert.equal(preview.path, path.join(root, "app.txt"));
    assert.equal(preview.content, "editor file");
    assert.equal(await (await fetch(`${origin}/api/session-file/source?path=report%3A2025`)).text(), "exact filename");
    const html = await fetch(`${origin}/api/session-file/source?path=index.html%3A12&mode=preview&search=%3Ftab%3Ddetails`, { redirect: "manual" });
    const filePrefix = `/api/local-file/${Buffer.from(path.join(root, "index.html")).toString("base64url")}/`;
    assert.equal(html.headers.get("location"), filePrefix + "?tab=details");
    assert.equal((await fetch(origin + html.headers.get("location"))).status, 200);
    assert.equal((await fetch(`${origin}/api/session-file/source?path=index.html&mode=preview&search=%3Ftab%3D1%0A`)).status, 400);
    const rootPrefix = `/api/local-file/${Buffer.from(root).toString("base64url")}`;
    assert.equal(await (await fetch(origin + rootPrefix + "/" + encodeURIComponent(" literal name.txt "))).text(), "literal whitespace");
    assert.equal((await fetch(origin + rootPrefix + "?tab=1", { redirect: "manual" })).headers.get("location"), rootPrefix + "/?tab=1");
    assert.equal((await fetch(origin + rootPrefix + "/sub?tab=1", { redirect: "manual" })).headers.get("location"), rootPrefix + "/sub/?tab=1");
    const fallbackRoot = `/api/local-file/${Buffer.from(path.join(root, "index.html:12")).toString("base64url")}/`;
    assert.equal(await (await fetch(origin + fallbackRoot)).text(), "<h1>preview</h1>");
    const exactDirectory = `/api/local-file/${Buffer.from(path.join(root, "site:2025")).toString("base64url")}/`;
    assert.equal(await (await fetch(origin + exactDirectory)).text(), "exact directory");
    const exactHtml = await fetch(`${origin}/api/session-file/source?path=index.html%3A2025&mode=preview`);
    assert.match(exactHtml.headers.get("content-type") || "", /text\/html/);
    assert.equal(await exactHtml.text(), "<h1>exact HTML</h1>");
    const metadata = await (await fetch(`${origin}/api/session-file/source?path=app.txt%3A12&mode=metadata`)).json();
    assert.equal(metadata.path, path.join(root, "app.txt"));
    assert.equal(metadata.content, "editor file");
    const nestedMetadata = await (await fetch(origin + rootPrefix + "/sub/index.html?__wand_file_action=metadata")).json();
    assert.equal(nestedMetadata.path, path.join(root, "sub/index.html"));
    const nestedDownload = await fetch(origin + rootPrefix + "/sub/index.html?__wand_file_action=download");
    assert.match(nestedDownload.headers.get("content-disposition") || "", /^attachment/);
    assert.equal(await nestedDownload.text(), "nested preview");
    const applicationMode = await fetch(origin + rootPrefix + "/sub/index.html?mode=download");
    assert.match(applicationMode.headers.get("content-disposition") || "", /^inline/);
    const relativeDirectory = await fetch(`${origin}/api/session-file/source?path=sub%2F&mode=preview`);
    assert.equal(await relativeDirectory.text(), "nested preview");
    const directoryDownload = await fetch(`${origin}/api/session-file/source?path=sub%2F&mode=download`);
    assert.match(directoryDownload.headers.get("content-disposition") || "", /^attachment/);
    assert.equal(await directoryDownload.text(), "nested preview");
    const dottedRoot = "/api/local-file/" + Buffer.from(path.join(root, "site.with.dots")).toString("base64url") + "/";
    const largeMetadata = await fetch(origin + dottedRoot + "?__wand_file_action=metadata");
    assert.equal(largeMetadata.status, 413);
    assert.equal((await largeMetadata.json()).path, path.join(root, "site.with.dots/index.html"));
    assert.equal((await fetch(`${origin}/api/session-file/source?path=..%2F&mode=preview`)).status, 403);
    for (const route of ["file-raw", "file-preview"]) {
      assert.equal((await fetch(`${origin}/api/${route}?path=~%2F.ssh%2Fid_rsa`)).status, 403);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    storage.close(); await rm(root, { recursive: true, force: true });
  }
});

test("preview readiness supports GET-only services and reports failed services without accepting error pages", async () => {
  const app = express();
  const methods: string[] = [];
  app.all("/get-only", (req, res) => {
    methods.push(req.method);
    if (req.method === "HEAD") res.sendStatus(405);
    else res.type("html").send("<button>demo</button>");
  });
  app.all("/offline", (_req, res) => res.status(502).json({ error: "offline" }));
  app.all("/denied", (_req, res) => res.status(403).end());
  app.all("/json", (_req, res) => res.json({ ok: true }));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await probeHtmlPreview(origin + "/get-only", new AbortController().signal);
    assert.deepEqual(methods, ["HEAD", "GET"]);
    await assert.rejects(probeHtmlPreview(origin + "/offline", new AbortController().signal), /本地服务未启动/);
    await assert.rejects(probeHtmlPreview(origin + "/denied", new AbortController().signal), /登录已失效/);
    await assert.rejects(probeHtmlPreview(origin + "/json", new AbortController().signal), NonHtmlPreviewResponse);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
