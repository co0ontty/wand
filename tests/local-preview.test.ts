import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

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

  const chatRender = readFileSync(new URL("../src/web-ui/browser/chat-render.ts", import.meta.url), "utf8");
  assert.match(chatRender, /function autoLinkLocalHttp/);
  assert.match(chatRender, /result = autoLinkLocalHttp\(result\);/);
  assert.match(chatRender, /__openLocalPreview/);

  const terminal = readFileSync(new URL("../src/web-ui/browser/terminal.ts", import.meta.url), "utf8");
  assert.match(terminal, /registerLinkProvider/);
  assert.match(terminal, /openLocalPreviewFromLegacy/);
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

    const blocked = await fetch(`${proxyUrl}/api/local-preview/example.com/${targetPort}/`);
    assert.equal(blocked.status, 400);
  } finally {
    target.close();
    proxy.close();
  }
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
