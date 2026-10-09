import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import express from "express";
import { conversationHarness } from "./helpers/conversation-harness.js";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

/** Source component + isolated real SQLite/API fixture; never installed-service acceptance. */
test("home coalesces notifications with a trailing read and preserves task drafts across readonly project retry", {
  skip: process.env.WAND_CONVERSATIONS_BROWSER !== "1", timeout: 120_000,
}, async t => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-home-refresh-"));
  const output = join(root, "output/web-ux-implementation-20261009/home-refresh-browser"); mkdirSync(output, { recursive: true });
  const h = conversationHarness(t), id = await h.group({ employeeIds: ["e_test_1", "e_test_2"] });
  h.storage.saveSiliconEmployee({ ...h.storage.getSiliconEmployee("e_test_1")!, id: "e_wand_default", name: "默认伙伴（明确替身）" });
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import { ConversationHome } from "./src/web-ui/react/conversations/home";
    import { conversationUi } from "./src/web-ui/react/conversations/state";
    import { notifyAiTeamRunChanged } from "./src/web-ui/react/ai-teams/repository";
    import { ComposerStore } from "./src/web-ui/browser/composer";
    import { configureTeamChatComposerRuntime } from "./src/web-ui/react/ai-teams/composer-bridge";
    import { installReactUiStyles } from "./src/web-ui/react/styles";
    import { WandUiProvider } from "./src/web-ui/react/theme";
    import { PortalContainerProvider } from "./src/web-ui/react/ui";
    import "./src/web-ui/react/ai-teams/chunk-entry";
    installReactUiStyles();
    const composer=new ComposerStore({storage:()=>localStorage,isUnloading:()=>false,disposeAttachment:()=>{}});
    configureTeamChatComposerRuntime({read:id=>composer.read(id),edit:(id,c)=>composer.edit(id,c),subscribe:f=>composer.subscribe(f),submit:(id,text,f)=>composer.submit(id,text,f),transfer:(a,b,r)=>composer.transfer(a,b,r)});
    const initialDirectoryCase=new URLSearchParams(location.search).has('initial-directory');
    if(!initialDirectoryCase)conversationUi.select(${JSON.stringify(id)});
    globalThis.homeFixture={state:()=>conversationUi.getSnapshot(),notify:()=>{for(let n=0;n<20;n++)notifyAiTeamRunChanged({runId:'fixture',taskId:'fixture'});}};
    function App(){const[visible,setVisible]=React.useState(!initialDirectoryCase);return <><div style={{position:'fixed',bottom:0,left:0,zIndex:30000}}>
      <button id="fixture-directory" onClick={()=>{conversationUi.directory(true);setVisible(true);}}>目录测试入口</button>
      <button id="fixture-visibility" onClick={()=>setVisible(v=>!v)}>可见性测试入口</button></div>
      <ConversationHome visible={visible} sidebarOpen={false} onOpenSession={()=>{}}/></>}
    createRoot(document.getElementById('root')).render(<PortalContainerProvider container={document.getElementById('portals')}><WandUiProvider><App/></WandUiProvider></PortalContainerProvider>);
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } });
  let version = 1, detailRequests = 0, active = 0, maxActive = 0;
  let releaseFirst: (() => void) | null = null, projectFailure = true, projectRequests = 0, writes = 0;
  let holdEmployees = true;
  const releaseEmployees: Array<() => void> = [];
  const app = express();
  app.use((req, _res, next) => { if (req.method !== "GET") writes++; next(); });
  app.get(`/api/conversations/${id}`, async (_req, res) => {
    const snapshot = { ...h.service.detail(id), title: `详情版本${version}` };
    detailRequests++; maxActive = Math.max(maxActive, ++active);
    if (detailRequests === 1) await new Promise<void>(done => { releaseFirst = done; });
    active--; res.json(snapshot);
  });
  app.get("/api/workspaces", (_req, res) => { projectRequests++; projectFailure ? res.status(503).json({ error: "工作项目读取失败（503 测试替身），请重试。" }) : res.json(h.storage.listWorkspaces()); });
  app.get("/api/conversations/dm_e_wand_default", (_req, res) => res.json(h.service.detail("dm_e_wand_default")));
  app.get("/api/silicon-employees", async (_req, res) => {
    if (holdEmployees) await new Promise<void>(done => { releaseEmployees.push(done); });
    res.json({ employees: h.storage.listSiliconEmployees({ includeArchived: true }) });
  });
  app.get("/api/ai-teams", (_req, res) => res.json(h.storage.listAiTeams()));
  app.get("/api/*", (_req, res) => res.json({}));
  app.get("/app.js", (_req, res) => res.type("js").send(readFileSync(join(temp, "app.js"))));
  for (const file of ["styles.css", "tailwind.css"]) app.get(`/${file}`, (_req, res) => res.type("css").send(readFileSync(join(root, "src/web-ui/content", file))));
  app.get("*", (req, res) => {
    if (req.path.includes("aiTeamsChunkSrc")) { res.type("js").send("/* Production chunk components are bundled into this source-only fixture. */"); return; }
    res.type("html").send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><div id="overlay-root"><div id="portals" class="wand-ui-portals"></div></div><script src="/app.js"></script></body></html>');
  });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  let browser: Awaited<ReturnType<typeof openBrowser>> | null = null;
  const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
  const results: Record<string, unknown> = {};
  try {
    browser = await openBrowser("about:blank", 1280, 900);
    await browser.send("Page.navigate", { url: `http://127.0.0.1:${address.port}/?initial-directory` });
    await browser.wait("document.querySelector('.conversation-root')?.hidden===true", "hidden initial home with no receiver");
    for (let n = 0; n < 150 && !releaseEmployees.length; n++) await pause(40);
    assert.ok(releaseEmployees.length, "employee resource read is held");
    assert.equal(await browser.evaluate("homeFixture.state().selectedId"), "");
    await browser.click("#fixture-directory");
    await browser.wait("document.querySelector('.conversation-directory-surface')?.dataset.active==='true'", "initial directory explicitly opened");
    await browser.click('[aria-label="搜索通讯录"]');
    await browser.send("Input.insertText", { text: "员工" });
    holdEmployees = false; releaseEmployees.splice(0).forEach(done => done());
    await browser.wait("document.querySelectorAll('.conversation-contact-row').length>0", "late employee resource displayed");
    await browser.settle();
    assert.equal(await browser.evaluate("homeFixture.state().directory"), true, "late default employee does not close explicitly opened directory");
    assert.equal(await browser.evaluate("homeFixture.state().selectedId"), "", "default receiver waits for leaving directory");
    assert.equal(await browser.evaluate("document.querySelector('[aria-label=\"搜索通讯录\"]').value"), "员工", "late resource preserves the typed directory query");
    await browser.click('.conversation-directory-header button');
    await browser.wait("document.querySelector('.conversation-heading-context')?.textContent.includes('默认伙伴')", "return normally selects the default partner");
    assert.equal(await browser.evaluate("homeFixture.state().directory"), false);
    assert.equal(await browser.evaluate("homeFixture.state().selectedId"), "dm_e_wand_default");
    results.initialDirectory = { lateResourceKeepsDirectory: true, queryPreserved: true, returnSelectsDefaultPartner: true };
    await browser.send("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
    for (let n = 0; n < 150 && !releaseFirst; n++) await pause(40);
    assert.ok(releaseFirst, "first detail read is held");
    version = 2; await browser.evaluate("homeFixture.notify()");
    assert.equal(detailRequests, 1, "notifications do not start concurrent detail reads");
    releaseFirst();
    await browser.wait("document.querySelector('.conversation-heading-title')?.textContent==='详情版本2'", "trailing fresh detail");
    assert.equal(maxActive, 1); assert.equal(detailRequests, 2, "burst is one trailing fresh read");
    results.trailingRead = { requests: detailRequests, maxActive };

    // The directory and hidden home must stop detail polling and WS-triggered reads.
    await browser.click("#fixture-directory");
    const beforeDirectory = detailRequests;
    await browser.evaluate("homeFixture.notify()"); await pause(3300);
    assert.equal(detailRequests, beforeDirectory, "directory pauses detail notifications and polling");
    await browser.click('.conversation-directory-header button');
    await browser.wait("document.querySelector('.conversation-chat-surface')?.dataset.active==='true'", "return from directory");
    await browser.settle();
    assert.ok(detailRequests > beforeDirectory, "returning refreshes detail");
    await browser.click("#fixture-visibility");
    const beforeHidden = detailRequests;
    await browser.evaluate("homeFixture.notify()"); await pause(3300);
    assert.equal(detailRequests, beforeHidden, "hidden home pauses detail notifications and polling");
    await browser.click("#fixture-visibility"); await browser.settle();
    results.paused = { directory: true, hidden: true };

    // Opening by the group title must return focus to that same title.
    await browser.click('.conversation-heading-title');
    await browser.wait("document.querySelector('#conversation-members-panel')?.dataset.open==='true'", "group members from title");
    assert.equal(await browser.evaluate("document.querySelector('.conversation-heading-title').getAttribute('aria-expanded')"), "true");
    await browser.key("Escape");
    assert.equal(await browser.evaluate("document.activeElement===document.querySelector('.conversation-heading-title')"), true);
    results.membersTitleFocus = true;

    await browser.click('.conversation-sender textarea');
    await browser.send("Input.insertText", { text: "待保留任务草稿" });
    await browser.click('[aria-label="更多聊天操作"]');
    await browser.evaluate("Array.from(document.querySelectorAll('#conversation-task-panel button')).find(n=>n.textContent==='派新任务').id='fixture-dispatch';true");
    await browser.click('#fixture-dispatch');
    await browser.wait("document.querySelector('#conversation-task-panel').textContent.includes('503 测试替身')", "readonly project error");
    assert.equal(await browser.evaluate("document.querySelector('.conversation-sender textarea').value"), "待保留任务草稿");
    assert.equal(await browser.evaluate("document.querySelector('[aria-label=\"工作项目\"]').disabled"), true);
    projectFailure = false;
    await browser.click('#conversation-task-panel .ant-alert button');
    await browser.wait("!document.querySelector('#conversation-task-panel .ant-alert')", "project retry success");
    assert.equal(await browser.evaluate("document.querySelector('.conversation-sender textarea').value"), "待保留任务草稿");
    assert.equal(await browser.evaluate("document.querySelector('[aria-label=\"任务 title\"]').value"), "待保留任务草稿");
    assert.equal(await browser.evaluate("document.querySelector('[aria-label=\"工作项目\"]').disabled"), false);
    assert.equal(projectRequests, 2); assert.equal(writes, 0); assert.equal(h.sent.length, 0); assert.equal(h.executions.length, 0);
    assert.deepEqual(browser.errors, []);
    results.projects = { requests: projectRequests, draftPreserved: true, writes, executionCount: h.executions.length };
    writeFileSync(join(output, "result.json"), JSON.stringify({ passed: true, scope: "source components + isolated SQLite/HTTP + actual Chrome; not installed-service acceptance", ...results }, null, 2));
  } catch (cause) {
    writeFileSync(join(output, "result.json"), JSON.stringify({ passed: false, ...results, error: String(cause), pageErrors: browser?.errors }, null, 2));
    throw cause;
  } finally { releaseFirst?.(); releaseEmployees.splice(0).forEach(done => done()); await browser?.close(); server.close(); rmSync(temp, { recursive: true, force: true }); }
});
