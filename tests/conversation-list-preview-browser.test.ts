import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { build } from "esbuild";
import { retainedGroupChatFixture } from "./conversation-group-visibility-fixture.js";
import { conversationHarness } from "./helpers/conversation-harness.js";
import { registerConversationRoutes } from "../src/server-conversation-routes.js";

test("conversation sidebar displays DM body once while preserving group signatures", {
  skip: process.env.WAND_LIST_PREVIEW_BROWSER !== "1", timeout: 90_000,
}, async t => {
  // Isolated development verification: real storage/service/React, no model execution.
  const h = conversationHarness(t), dm = "dm_e_test_1";
  await h.service.prepare(dm, randomUUID());
  const group = await h.group();
  for (const id of [dm, group]) h.storage.appendConversationEvent(id, {
    role: "assistant", createdAt: new Date().toISOString(), author: { id: "e_test_1", name: "员工 1" },
    content: [{ type: "text", text: "我先检查对话筛选。" }],
  });
  const root = resolve(import.meta.dirname, ".."), temp = mkdtempSync(join(tmpdir(), "wand-preview-browser-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  await build({ plugins: [retainedGroupChatFixture], stdin: { resolveDir: root, loader: "tsx", contents: `
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import { WandUiProvider } from "./src/web-ui/react/theme";
    import { installReactUiStyles } from "./src/web-ui/react/styles";
    import { ConversationSidebarList } from "./src/web-ui/react/conversations/sidebar";
    installReactUiStyles();
    createRoot(document.getElementById("root")).render(<WandUiProvider><ConversationSidebarList compact={false} onNavigate={() => {}}/></WandUiProvider>);
  ` }, bundle: true, format: "iife", platform: "browser", jsx: "automatic", outfile: join(temp, "app.js"),
    logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } });
  const app = express(); app.use(express.json()); registerConversationRoutes(app, h.service);
  app.get("/api/sessions", (_req, res) => res.json([]));
  app.get("/api/tasks", (_req, res) => res.json({ groups: [] }));
  app.get("/api/silicon-employees", (_req, res) => res.json({ employees: h.storage.listSiliconEmployees() }));
  app.get("/api/config", (_req, res) => res.json({}));
  app.get("/app.js", (_req, res) => res.type("js").send(readFileSync(join(temp, "app.js"))));
  app.get("/styles.css", (_req, res) => res.type("css").send(readFileSync(join(root, "src/web-ui/content/styles.css"))));
  app.get("/", (_req, res) => res.type("html").send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root" style="width:288px;max-width:100%"></div><script src="/app.js"></script></body></html>'));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const { chromium } = await import(process.env.WAND_PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  for (const mode of ["desktop", "mobile", "native", "rollback"]) {
    const page = await browser.newPage({ viewport: { width: mode === "desktop" ? 1280 : 390, height: 900 } });
    await page.goto(`http://127.0.0.1:${address.port}/${mode === "rollback" ? "?reactUi=0" : ""}`);
    if (mode === "native") await page.evaluate(() => document.documentElement.classList.add("is-wand-app"));
    const row = page.locator(`[data-conversation-id="${dm}"]`);
    await row.waitFor();
    assert.equal(await row.locator(".conversation-row-title").textContent(), "员工 1", mode);
    assert.equal(await row.locator(".conversation-row-preview").textContent(), "我先检查对话筛选。", mode);
    assert.equal(await page.locator(`[data-conversation-id="${group}"] .conversation-row-preview`).textContent(), "员工 1：我先检查对话筛选。", mode);
    assert.equal(await row.locator(".conversation-row-open").isVisible(), true, mode);
    await page.close();
  }
});
