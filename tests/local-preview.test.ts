import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { renderChatMarkdown } from "../src/web-ui/markdown.js";
import { parseLocalPreviewTarget, registerLocalPreviewRoutes } from "../src/server-local-preview-routes.js";
import { localFilePreviewHref, localHttpPreviewHref, localPreviewController } from "../src/web-ui/react/local-preview/controller.js";
import { openLocalPreviewFromLegacy } from "../src/web-ui/browser/local-preview-adapter.js";
import { registerFileRoutes } from "../src/server-file-routes.js";
import { WandStorage } from "../src/storage.js";

function fileRoot(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

const noAuth = (_req: unknown, _res: unknown, next: () => void) => next();

async function listen(app: express.Express): Promise<Server> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

test("local preview helpers turn message links into one-click previews", () => {
  assert.equal(
    localHttpPreviewHref("http://localhost:3000/docs?tab=run"),
    "/api/local-preview/127.0.0.1/3000/docs?tab=run",
  );
  assert.equal(localHttpPreviewHref("http://localhost/"), "/api/local-preview/127.0.0.1/80/");
  assert.equal(localHttpPreviewHref("https://localhost:3000/"), null);
  assert.equal(localHttpPreviewHref("http://example.com:3000/"), null);
  assert.equal(
    localFilePreviewHref("/tmp/demo/index.html"),
    `/api/local-file/${Buffer.from("/tmp/demo/index.html", "utf8").toString("base64url")}/`,
  );
  assert.equal(localFilePreviewHref("relative/index.html"), null);

  assert.ok(openLocalPreviewFromLegacy("http://127.0.0.1:4173/app/"));
  assert.equal(
    localPreviewController.getSnapshot().previewUrl,
    "/api/local-preview/127.0.0.1/4173/app/",
  );
  assert.ok(openLocalPreviewFromLegacy("/tmp/demo/index.html"));
  assert.match(localPreviewController.getSnapshot().previewUrl ?? "", /^\/api\/local-file\//);
  localPreviewController.close();

  const links = renderChatMarkdown("http://localhost:3000/docs?tab=run\n\n[Demo](/tmp/demo/index.html)");
  assert.match(links, /class="local-preview-link"/);
  assert.match(links, /href="\/api\/local-preview\/127\.0\.0\.1\/3000\/docs\?tab=run"/);
  assert.match(links, /data-local-preview-url="\/tmp\/demo\/index.html"/);
  assert.match(links, /__openLocalPreview/);

  const terminal = readFileSync(new URL("../src/web-ui/browser/terminal.ts", import.meta.url), "utf8");
  assert.match(terminal, /registerLinkProvider/);
  assert.match(terminal, /openLocalPreviewFromLegacy/);
  // xterm 的公开 IBuffer 上只有 active/normal/alternate，行内容要从
  // term.buffer.active 上取。写成 term.buffer.getLine 会让 provideLinks 每行抛
  // TypeError，终端里的本地链接全部失效。
  assert.match(terminal, /term\.buffer\.active\.getLine\(lineNumber\)/);
  assert.doesNotMatch(terminal, /term\.buffer\.getLine\(/);
});

test("local preview targets are limited to loopback HTTP ports", () => {
  assert.deepEqual(parseLocalPreviewTarget("localhost", "3000", "/api/x?a=1"), {
    hostname: "127.0.0.1",
    port: 3000,
    path: "/api/x?a=1",
  });
  assert.equal(parseLocalPreviewTarget("127.0.0.1", "0", "/"), null);
  assert.equal(parseLocalPreviewTarget("example.com", "3000", "/"), null);
  assert.equal(parseLocalPreviewTarget("169.254.169.254", "80", "/"), null);
});

test("local preview controller normalizes ports and local site roots", () => {
  localPreviewController.show("3000");
  localPreviewController.setMode("url");
  localPreviewController.setValue("3000");
  localPreviewController.submit();
  assert.equal(localPreviewController.getSnapshot().previewUrl, "/api/local-preview/127.0.0.1/3000/");

  localPreviewController.setValue("localhost:5173/app/");
  localPreviewController.submit();
  assert.equal(
    localPreviewController.getSnapshot().previewUrl,
    "/api/local-preview/127.0.0.1/5173/app/",
  );

  localPreviewController.setMode("file");
  localPreviewController.setValue("/tmp/site/index.html");
  localPreviewController.submit();
  const fileSnapshot = localPreviewController.getSnapshot();
  assert.match(fileSnapshot.previewUrl ?? "", /^\/api\/local-file\/[A-Za-z0-9_-]+\/$/);
  localPreviewController.close();
  assert.equal(localPreviewController.getSnapshot().open, false);
});

test("local preview proxies requests and rewrites same-host redirects", async () => {
  const targetApp = express();
  targetApp.use(express.raw({ type: "*/*", limit: "1mb" }));
  targetApp.get("/hello", (_req, res) => {
    res.setHeader("Set-Cookie", "target=hidden");
    res.setHeader("X-Frame-Options", "DENY");
    res.type("text/html").send("<p>hello</p>");
  });
  targetApp.post("/echo", (req, res) => {
    res.type("text/plain").send(`${req.headers["x-wand-probe"]}:${req.body as Buffer}`);
  });
  targetApp.get("/redirect", (_req, res) => res.redirect("/hello"));
  targetApp.get("/absolute", (req, res) => res.redirect(`http://localhost:${req.socket.localPort}/hello?tab=1#section`));
  targetApp.get("/relative", (_req, res) => res.redirect("hello?tab=2#section"));
  targetApp.get("/external", (_req, res) => res.redirect("//example.com/hello"));
  const target = await listen(targetApp);
  const targetPort = (target.address() as AddressInfo).port;

  const proxyApp = express();
  proxyApp.use(express.json());
  registerLocalPreviewRoutes(proxyApp, { requireAuth: noAuth as never, requireFiles: noAuth as never });
  const proxy = await listen(proxyApp);
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

  try {
    const first = await fetch(`${proxyUrl}/api/local-preview/localhost/${targetPort}/hello?value=1`, {
      headers: { Cookie: "wand_session=secret" },
    });
    assert.equal(first.status, 200);
    assert.equal(await first.text(), "<p>hello</p>");
    assert.equal(first.headers.get("set-cookie"), null);
    assert.equal(first.headers.get("x-frame-options"), null);
    assert.match(first.headers.get("content-security-policy") || "", /sandbox allow-scripts allow-forms/);
    assert.match(first.headers.get("content-security-policy") || "", /form-action 'none'/);

    const posted = await fetch(`${proxyUrl}/api/local-preview/127.0.0.1/${targetPort}/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Wand-Probe": "yes" },
      body: "streamed body",
    });
    assert.equal(posted.status, 200);
    assert.equal(await posted.text(), "yes:streamed body");

    const redirected = await fetch(
      `${proxyUrl}/api/local-preview/localhost/${targetPort}/redirect`,
      { redirect: "manual" },
    );
    assert.equal(redirected.status, 302);
    assert.equal(
      redirected.headers.get("location"),
      `/api/local-preview/127.0.0.1/${targetPort}/hello`,
    );
    for (const [route, expected] of [["absolute", `/api/local-preview/127.0.0.1/${targetPort}/hello?tab=1#section`],
      ["relative", `/api/local-preview/127.0.0.1/${targetPort}/hello?tab=2#section`], ["external", "//example.com/hello"]]) {
      const response = await fetch(`${proxyUrl}/api/local-preview/localhost/${targetPort}/${route}`, { redirect: "manual" });
      assert.equal(response.headers.get("location"), expected);
    }
    const directory = await fetch(`${proxyUrl}/api/local-preview/localhost/${targetPort}?tab=1`, { redirect: "manual" });
    assert.equal(directory.headers.get("location"), `/api/local-preview/localhost/${targetPort}/?tab=1`);

    const blocked = await fetch(`${proxyUrl}/api/local-preview/example.com/${targetPort}/`);
    assert.equal(blocked.status, 400);
  } finally {
    target.close();
    proxy.close();
  }
});

test("cancelling a preview request closes its waiting upstream connection", { timeout: 5000 }, async () => {
  let received!: () => void;
  const upstreamReceived = new Promise<void>(resolve => { received = resolve; });
  let disconnected!: () => void;
  const upstreamDisconnected = new Promise<void>(resolve => { disconnected = resolve; });
  const targetApp = express();
  targetApp.use((req, _res) => { req.socket.once("close", disconnected); received(); });
  const target = await listen(targetApp);
  const app = express();
  registerLocalPreviewRoutes(app, { requireAuth: noAuth as never, requireFiles: noAuth as never });
  const proxy = await listen(app);
  const abort = new AbortController();
  try {
    const waiting = fetch(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/api/local-preview/127.0.0.1/${(target.address() as AddressInfo).port}/`, { method: "HEAD", signal: abort.signal }).catch(() => null);
    await upstreamReceived;
    abort.abort();
    await waiting;
    await upstreamDisconnected;
  } finally { abort.abort(); target.closeAllConnections(); proxy.closeAllConnections(); target.close(); proxy.close(); }
});

test("local file endpoint serves HTML and sibling assets without traversal", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-local-preview-file-"));
  const site = path.join(root, "site");
  mkdirSync(site, { recursive: true });
  writeFileSync(path.join(site, "index.html"), '<html><link rel="stylesheet" href="style.css"></html>');
  writeFileSync(path.join(site, "style.css"), "body{color:red}");

  const app = express();
  registerFileRoutes(app, { storage: new WandStorage(path.join(root, "wand.db")), defaultCwd: root });
  const server = await listen(app);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const html = await fetch(`${baseUrl}/api/local-file/${fileRoot(site)}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await html.text(), '<html><link rel="stylesheet" href="style.css"></html>');

    const asset = await fetch(
      `${baseUrl}/api/local-file/${fileRoot(site)}/style.css`,
    );
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /text\/css/);

    const traversal = await fetch(
      `${baseUrl}/api/local-file/${fileRoot(site)}/${encodeURIComponent("../wand.db")}`,
    );
    assert.equal(traversal.status, 403);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
