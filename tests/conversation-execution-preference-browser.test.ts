import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { build } from "esbuild";
import test from "node:test";
import { registerConversationRoutes } from "../src/server-conversation-routes.js";
import { conversationHarness } from "./helpers/conversation-harness.js";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("conversation tool/model/thinking selectors retain page choice, send it, and never edit employee defaults", {
  skip: process.env.WAND_EXECUTION_PREFERENCE_BROWSER !== "1", timeout: 120_000,
}, async t => {
  const root = resolve(import.meta.dirname, "..");
  const evidence = resolve(root, "output/architecture-stage2/conversation-execution-preference"); mkdirSync(evidence, { recursive: true });
  const h = conversationHarness(t);
  const saved = h.storage.getSiliconEmployee("e_test_1")!;
  const bundled = await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {WandUiProvider} from './src/web-ui/react/theme';
    import {PortalContainerProvider} from './src/web-ui/react/ui';
    import {installReactUiStyles} from './src/web-ui/react/styles';
    import {ConversationHome} from './src/web-ui/react/conversations/home';
    import {conversationUi} from './src/web-ui/react/conversations/state';
    import {ComposerStore} from './src/web-ui/browser/composer';
    import {configureTeamChatComposerRuntime} from './src/web-ui/react/ai-teams/composer-bridge';
    import './src/web-ui/react/ai-teams/chunk-entry';
    installReactUiStyles();
    const store=new ComposerStore({storage:()=>localStorage,isUnloading:()=>false,disposeAttachment:()=>{}});
    configureTeamChatComposerRuntime({read:id=>store.read(id),edit:(id,c)=>store.edit(id,c),subscribe:f=>store.subscribe(f),submit:(id,text,f)=>store.submit(id,text,f),transfer:(a,b,r)=>store.transfer(a,b,r)});
    conversationUi.select('dm_e_test_1'); globalThis.fixture={ui:conversationUi};
    createRoot(document.getElementById('root')).render(<WandUiProvider><PortalContainerProvider container={document.getElementById('portals')}><ConversationHome visible sidebarOpen={false} onOpenSession={()=>{}}/></PortalContainerProvider></WandUiProvider>);
  `, loader: "tsx", resolveDir: root }, bundle: true, format: "iife", write: false, define: { "process.env.NODE_ENV": '"production"' } });
  const app = express(); app.use(express.json());
  const bodies: any[] = [];
  app.use((req, res, next) => {
    if (req.method !== "GET") {
      assert.match(req.path, /^\/api\/conversations\/dm_e_test_[12]\/messages$/);
      bodies.push(req.body);
    }
    next();
  });
  registerConversationRoutes(app, h.service);
  app.get("/api/silicon-employees", (_req, res) => res.json({ employees: h.storage.listSiliconEmployees() }));
  app.get("/api/config", (_req, res) => res.json({ defaultCwd: h.cwd }));
  app.get("/api/ai-teams", (_req, res) => res.json([]));
  app.get(/ChunkSrc|\.js$/, (req, res, next) => req.path === "/app.js" ? next() : res.type("js").send(""));
  app.get("/api/models", (_req, res) => res.json({ piModels: [{ id: "page-model", label: "Page Model", reasoningEfforts: [{ effort: "high" }] }], defaultPiModel: "server-default", thinkingEfforts: { pi: [{ effort: "high" }] } }));
  app.get("/api/sessions/:id", (req, res) => res.json(h.sessions.get(req.params.id) ?? {}));
  app.get(/^\/api\//, (_req, res) => res.json({}));
  app.get("/app.js", (_req, res) => res.type("js").send(bundled.outputFiles[0]!.text));
  app.get("/styles.css", (_req, res) => res.type("css").send(readFileSync(resolve(root, "src/web-ui/content/styles.css"), "utf8")));
  app.get(/.*/, (_req, res) => res.type("html").send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><div id="root"></div><div id="portals"></div><script src="/app.js"></script>'));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const browser = await openBrowser(`http://127.0.0.1:${address.port}`, 1280, 900); t.after(() => browser.close());
  const { click, evaluate, wait, key } = browser;
  try { await wait('document.querySelector("[aria-label=本页执行工具]")?.textContent.includes("Wand Agent")'); }
  catch (error) { console.log(await evaluate('({text:document.body.innerText.slice(0,2500),html:document.querySelector(".conversation-runtime-summary")?.outerHTML})'), browser.errors); throw error; }
  await click('[aria-label="本页执行工具"]');
  await wait('!!document.querySelector("[role=option][data-menu-id$=pi]")');
  await click('[role="option"][data-menu-id$="pi"]');
  await wait('document.querySelector("[aria-label=本页执行工具]")?.textContent.includes("Pi")');
  await click('[aria-label="本页模型"]');
  await click('[aria-label="搜索本页模型"]');
  await browser.send("Input.insertText", { text: "Page Model" });
  assert.equal(await evaluate('document.querySelector("[aria-label=本页模型]").getAttribute("aria-expanded")'), "true");
  await click('[role="option"][data-menu-id$="page-model"]');
  await click('[aria-label="本页思考深度"]');
  await click('[role="option"][data-menu-id$="deep"]');
  for (const peer of ["dm_e_test_1", "dm_e_test_2"]) {
    await evaluate(`fixture.ui.select(${JSON.stringify(peer)});true`);
    await wait(`document.querySelector('.conversation-heading-title')?.textContent.includes(${JSON.stringify(peer.endsWith("1") ? "员工 1" : "员工 2")})`);
    await wait('document.querySelector("[aria-label=本页模型]")?.textContent.includes("page-model")');
    await wait('document.querySelector(".conversation-sender textarea")?.readOnly === false');
    await click(".composer-compact-entry");
    await wait('document.activeElement === document.querySelector(".conversation-sender textarea")');
    await browser.send("Input.insertText", { text: "isolated test work" });
    await wait('document.querySelector(".conversation-sender textarea").value.includes("isolated test work")');
    await key("Enter");
    await wait('!document.querySelector(".conversation-sender textarea").value');
    await wait('document.querySelector("[aria-label=本页模型]")?.disabled === false');
  }
  if (bodies.length !== 2) console.log(await evaluate('({text:document.body.innerText.slice(-2400),active:document.activeElement?.outerHTML})'), browser.errors);
  assert.equal(bodies.length, 2);
  for (const body of bodies) assert.deepEqual(body.executionPreference, { provider: "pi", engine: "cli", model: "page-model", thinkingEffort: "deep" });
  assert.deepEqual(h.storage.getSiliconEmployee(saved.id), saved);
  // Real pointer dismissal paths, including the portal search box and keyboard return.
  await click('[aria-label="本页模型"]'); await click('[aria-label="搜索本页模型"]'); await key("Escape");
  assert.equal(await evaluate('document.querySelector("[aria-label=本页模型]").getAttribute("aria-expanded")'), "false");
  await click('[aria-label="本页执行工具"]'); await click(".conversation-heading");
  await wait('document.querySelector("[aria-label=本页执行工具]").getAttribute("aria-expanded")==="false"');
  await browser.screenshot(resolve(evidence, "desktop.png"));
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await browser.settle();
  const geometry = await evaluate(`(()=>{const wrap=document.querySelector('.conversation-input-wrap').getBoundingClientRect();return [...document.querySelectorAll('.conversation-runtime-select')].map(n=>{const r=n.getBoundingClientRect();return {width:r.width,left:r.left,right:r.right,wrapRight:wrap.right}})})()`);
  assert.ok(geometry.every((r: any) => r.width > 20 && r.left >= 0 && r.right <= r.wrapRight + 1));
  await browser.screenshot(resolve(evidence, "narrow.png"));
  await browser.send("Page.reload");
  await wait('document.querySelector("[aria-label=本页执行工具]")?.textContent.includes("Wand Agent")');
  assert.deepEqual(h.storage.getSiliconEmployee(saved.id), saved);
  assert.deepEqual(browser.errors, []);
});
