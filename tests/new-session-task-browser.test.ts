import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("one new-work page handles conversation, CLI terminal, shell, task binding and refused creation without default writes", {
  skip: process.env.WAND_NEW_SESSION_TASK_BROWSER !== "1", timeout: 180_000,
}, async t => {
  const source = `import React from 'react';import {createRoot} from 'react-dom/client';
    import {WandUiProvider} from './src/web-ui/react/theme';import {installReactUiStyles} from './src/web-ui/react/styles';
    import {NewSessionHost} from './src/web-ui/react/new-session/host';
    import {newSessionController,newSessionStore} from './src/web-ui/react/new-session/controller';
    import {installNewSessionLegacyAdapter} from './src/web-ui/browser/new-session-adapter';
    import {ComposerStore} from './src/web-ui/browser/composer';import {configureTeamChatComposerRuntime} from './src/web-ui/react/ai-teams/composer-bridge';
    const store=new ComposerStore({storage:()=>localStorage,isUnloading:()=>false,disposeAttachment:()=>{}});
    configureTeamChatComposerRuntime({read:id=>store.read(id),edit:(id,c)=>store.edit(id,c),subscribe:f=>store.subscribe(f),submit:(id,text,f)=>store.submit(id,text,f),transfer:(a,b,r)=>store.transfer(a,b,r)});
    installReactUiStyles();
    window.fixture={open:newSessionController.open,close:()=>newSessionController.close(),store,deliveries:[]};
    installNewSessionLegacyAdapter();
    function Fixture(){const open=React.useSyncExternalStore(newSessionStore.subscribe,newSessionStore.getSnapshot).open;
      return <><NewSessionHost/>{!open&&window.fixture.selectedId?<section aria-label="Fixture accepted conversation"><h1>会话已创建 · 模拟首轮仍在执行</h1><p>{window.fixture.selectedId}</p><p>{window.receipt?.text}</p></section>:null}</>}
    createRoot(document.getElementById('root')).render(<WandUiProvider><Fixture/></WandUiProvider>);`;
  // Run the production handoff adapter, not a replacement completeCreate. Only
  // its legacy shell/transport dependencies are fixtures; composer and Host are real.
  const shellFixture = `
    export const state={chatThinking:'off'};
    export const writeStoredBoolean=()=>{},focusInputBox=()=>{},dismissDrawerIfOverlay=()=>{},
      restoreComposerStateForSession=()=>{},updateDrawerState=()=>{},initTerminal=()=>{},
      saveWorkingDir=()=>{},ensureTerminalLibrary=async()=>{},ensureTerminalReady=async()=>{},
      closeReactOverlays=()=>{},notifyTasksChanged=()=>{};
    export const getEffectiveCwd=()=>'/project',getChatModelForProvider=()=>'',
      setChatModelForProvider=()=>{throw Error('No default writes')},withTerminalDimensions=()=>({cols:100,rows:30});
    export const clearDraftValueForSession=id=>window.fixture.store.edit(id,{clear:true});
    export const loadSessions=async()=>{};
    export const selectSession=id=>{state.selectedId=id;window.fixture.selectedId=id};
    export const conversationUi={suspend(){}},taskDetailStore={reload:async()=>{}},
      workspaceContextStore={getSnapshot:()=>({})},workspacesStore={getRuntime:()=>null},
      reconcileTaskWindowLayout=()=>null,layoutSessionIds=()=>[];
    export function sendInputFromBox(){
      const id=state.selectedId,store=window.fixture.store;
      window.receipt={text:store.read(id).text};
      return store.submit(id,store.read(id).text,payload=>{
        window.fixture.deliveries.push({id,text:payload.text});
        if(!window.fixture.holdDelivery)return Promise.resolve();
        return new Promise((resolve,reject)=>{window.fixture.resolveDelivery=resolve;window.fixture.rejectDelivery=()=>reject(Object.assign(Error('network failure'),{httpStatus:503}))});
      }).catch(()=>{window.fixture.deliveryFailed=id});
    }`;
  const built = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "new-work-shell-fixture", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (!args.importer.endsWith("/browser/new-session-adapter.ts")) return;
        if (args.path === "../react") return { path: process.cwd() + "/src/web-ui/react/new-session/controller.ts" };
        if (args.path === "../react/ai-teams/composer-bridge") return;
        return { path: "shell-fixture", namespace: "new-work-shell" };
      });
      builder.onLoad({ filter: /.*/, namespace: "new-work-shell" }, () => ({ contents: shellFixture, loader: "js" }));
    } }],
  });
  const agents = [{ provider: "pi", engine: "sdk", model: "employee-model", thinkingEffort: "off", mode: "default", kind: "structured" }];
  const employees = [{ id: "e_wand_default", name: "默认伙伴", duty: "", agents }, { id: "e_other", name: "另一位员工", duty: "", agents }];
  const writes: Array<{ path: string; body: any }> = [];
  let refusal: boolean | number = false;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    if (path === "/bundle.js") { res.setHeader("content-type", "text/javascript"); res.end(built.outputFiles[0].text); return; }
    if (/ChunkSrc|\.js$/.test(path)) { res.setHeader("content-type", "text/javascript"); res.end(""); return; }
    if (path === "/style.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync("src/web-ui/content/styles.css")); return; }
    if (!path.startsWith("/api/")) { res.setHeader("content-type", "text/html;charset=utf-8"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>html,body,#root{height:100%;margin:0;position:relative}</style><div id="root"></div><script src="/bundle.js"></script>'); return; }
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      let text = ""; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text || "{}"); writes.push({ path, body });
      if (path === "/api/structured-sessions" || path === "/api/commands") {
        if (refusal) { res.statusCode = typeof refusal === "number" ? refusal : 400; refusal = false; res.end(JSON.stringify({ error: "Fixture creation error" })); }
        else res.end(JSON.stringify({ id: "created-" + writes.length }));
        return;
      }
      res.statusCode = 400; res.end(JSON.stringify({ error: "Unexpected mutation " + path })); return;
    }
    const data = path === "/api/config" ? { defaultProvider: "claude", defaultSessionKind: "pty", defaultMode: "default", defaultCwd: "/project" }
      : path.includes("silicon-employees") ? { employees }
      : path === "/api/models" ? { piModels: [{ id: "page-model", label: "Page Model" }] }
      : path === "/api/recent-paths" ? [{ path: "/other/project", name: "other" }]
      : path === "/api/path-suggestions" ? [] : [];
    res.end(JSON.stringify(data));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const out = "output/new-session-reference-20261017/web"; mkdirSync(out, { recursive: true });
  const b = await openBrowser(origin, 1280, 900); t.after(() => b.close());
  await b.wait("!!window.fixture");
  await b.evaluate("fixture.open({});true");
  await b.wait("document.querySelector('.new-work-person')?.textContent.includes('默认伙伴')");
  assert.equal(writes.length, 0, "opening never starts a process");
  await b.settle();
  assert.match(await b.evaluate("document.querySelector('.new-work-context h1').textContent"), /project/);
  const layout = await b.evaluate(`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width}};return {hero:rect('.new-work-context h1'),bar:rect('.new-work-context-bar'),editor:rect('textarea'),submit:rect('.conversation-submit')}})()`);
  assert.ok(layout.hero.top < 180, "the invitation sits near the top, not vertically centered");
  assert.ok(layout.bar.top > 650, "the composer is anchored near the bottom");
  assert.ok(Math.abs(layout.bar.bottom - layout.editor.top) < 24, "the metadata strip must join the editor, not float above it");
  assert.ok(layout.submit.bottom > layout.editor.bottom);
  await b.screenshot(out + "/new-work-idle.png");
  await b.click('[aria-label="新工作设置"]');
  assert.equal(await b.evaluate("document.querySelector('[role=tab][aria-selected=true]').textContent"), "对话");
  await b.key("Escape");
  await b.wait("!document.querySelector('[role=tab]') || !document.querySelector('[role=tab]').checkVisibility()");
  await b.click(".new-work-person"); await b.wait("!!document.querySelector('[aria-label=搜索执行对象]')");
  await b.click("[aria-label=搜索执行对象]"); await b.send("Input.insertText", { text: "另一位" });
  await b.click('.wand-execution-subject-picker input[value="employee:e_other"]');
  await b.wait("document.querySelector('.new-work-person').textContent.includes('另一位员工')");
  await b.click(".new-work-directory");
  await b.click("[aria-label=新工作运行目录路径]");
  await b.evaluate("document.querySelector('[aria-label=新工作运行目录路径]').select();true");
  await b.send("Input.insertText", { text: "/changed" }); await b.key("Enter");
  await b.wait("document.querySelector('.new-work-directory').title==='/changed'");
  await b.click('[aria-label="本页模型"]'); await b.click('[aria-label="搜索本页模型"]');
  assert.ok(await b.evaluate("document.querySelector('[aria-label=新建工作]').checkVisibility()"), "searching the portalled model picker keeps creation open");
  await b.send("Input.insertText", { text: "Page Model" });
  await b.click('[role=option][data-menu-id$="page-model"]');
  await b.click("textarea"); await b.wait("document.activeElement===document.querySelector('textarea')");
  await b.send("Input.insertText", { text: "新工作的真实草稿（隔离测试）" });
  await b.screenshot(out + "/new-work-desktop.png");
  refusal = true;
  await b.click('.conversation-submit');
  await b.wait("!!document.querySelector('[role=alert]')");
  assert.ok(await b.evaluate("document.querySelector('textarea').value.includes('真实草稿')"));
  assert.equal(await b.evaluate("Math.round(document.querySelector('.conversation-submit').getBoundingClientRect().bottom)"), Math.round(layout.submit.bottom), "failure feedback cannot move the send slot");
  await b.click('.conversation-submit');
  await b.wait("!document.querySelector('[aria-label=新建工作]')");
  assert.equal(writes.length, 2);
  assert.equal(writes[1].path, "/api/structured-sessions");
  assert.equal(writes[1].body.employeeId, "e_other"); assert.equal(writes[1].body.cwd, "/changed");
  assert.equal(writes[1].body.overrideCli, true); assert.equal(writes[1].body.engine, "sdk"); assert.equal(writes[1].body.model, "page-model");
  assert.match(await b.evaluate("receipt.text"), /真实草稿/);
  await b.evaluate("fixture.open({});true");
  await b.wait("document.querySelector('.new-work-person')?.textContent.includes('默认伙伴')");
  await b.click(".new-work-person"); await b.click("[aria-label=搜索执行对象]");
  await b.send("Input.insertText", { text: "Codex" });
  await b.click('.wand-execution-subject-picker input[value="cli:codex"]');
  await b.wait("document.querySelector('[aria-label=本页执行工具]').textContent.includes('Codex')");
  await b.click("textarea"); await b.send("Input.insertText", { text: "direct CLI fixture" });
  await b.click('.conversation-submit'); await b.wait("!document.querySelector('[aria-label=新建工作]')");
  assert.equal(writes.at(-1)!.body.provider, "codex");
  assert.equal(writes.at(-1)!.body.employeeId, undefined);
  // A Qoder first-turn POST can remain pending for the entire execution. The
  // accepted page must leave now, with exactly one transfer/submission.
  await b.evaluate("fixture.open({});fixture.holdDelivery=true;true");
  await b.wait("document.querySelector('.new-work-person')?.textContent.includes('默认伙伴')");
  await b.click(".new-work-person"); await b.click("[aria-label=搜索执行对象]");
  await b.send("Input.insertText", { text: "Qoder" });
  await b.click('.wand-execution-subject-picker input[value="cli:qoder"]');
  await b.click("textarea"); await b.send("Input.insertText", { text: "Qoder delayed-turn fixture, not a real CLI call" });
  const createsBefore = writes.length;
  await b.click('.conversation-submit');
  await b.wait("!document.querySelector('[aria-label=新建工作]') && !!fixture.rejectDelivery", "accepted Qoder creation leaves the page while first-turn delivery is still pending");
  assert.equal(writes.length, createsBefore + 1);
  assert.equal(writes.at(-1)!.body.provider, "qoder");
  assert.equal(writes.at(-1)!.body.employeeId, undefined);
  assert.equal(writes.at(-1)!.body.model, "default", "preserve the server-default sentinel, not a concrete model override");
  const captured = await b.evaluate("fixture.deliveries.at(-1)");
  assert.match(captured.text, /Qoder delayed-turn/);
  assert.equal(await b.evaluate("fixture.store.read(fixture.selectedId).text"), "", "submission belongs to the destination composer");
  await b.screenshot(out + "/qoder-pending-handoff.png");
  await b.evaluate("fixture.open({});true");
  await b.wait("!!document.querySelector('.new-work-person')");
  await b.click("textarea"); await b.send("Input.insertText", { text: "next draft must survive the old delivery" });
  await b.evaluate("fixture.rejectDelivery();true");
  await b.wait("!!fixture.deliveryFailed");
  assert.equal(await b.evaluate("document.querySelector('textarea').value"), "next draft must survive the old delivery");
  assert.equal(await b.evaluate(`fixture.store.read(${JSON.stringify(captured.id)}).memoryOnly`), true);
  assert.equal(await b.evaluate(`localStorage.getItem('wand-draft-'+${JSON.stringify(captured.id)})`), null, "unknown delivery never restores a persistent draft");
  assert.equal(await b.evaluate("fixture.deliveries.filter(d=>d.text.includes('Qoder delayed-turn')).length"), 1);
  assert.equal(writes.length, createsBefore + 1, "late failure must not create or resend");
  await b.evaluate("fixture.holdDelivery=false;fixture.close();true");
  for (const kind of ["pty", "shell"]) {
    await b.evaluate(`fixture.open({initialKind:${JSON.stringify(kind)},initialCwd:'/terminal'});true`);
    await b.wait("!!document.querySelector('.new-work-directory')");
    if (kind === "shell") assert.equal(await b.evaluate("document.querySelectorAll('.conversation-runtime-summary').length"), 0);
    await b.click('.conversation-submit'); await b.wait("!document.querySelector('[aria-label=新建工作]')");
    const last = writes.at(-1)!; assert.equal(last.path, "/api/commands"); assert.equal(last.body.cwd, "/terminal");
    assert.equal(last.body.cols, 100); assert.equal(last.body.rows, 30);
    if (kind === "shell") { assert.equal(last.body.shell, true); assert.equal(last.body.provider, undefined); }
    // 临时执行配置随打开实例丢弃：新开的终端用配置默认，不沿用上一页选过的 CLI。
    else { assert.equal(last.body.provider, "claude"); assert.equal(last.body.command, "claude"); assert.equal(last.body.thinkingEffort, "off"); }
  }
  await b.evaluate("fixture.open({workspaceTaskId:'t1',workspaceId:'ws',initialCwd:'/bound'});true");
  await b.wait("!!document.querySelector('.new-work-person')");
  assert.equal(await b.evaluate("document.querySelector('.new-work-directory').disabled"), true);
  await b.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await b.settle(); await b.screenshot(out + "/new-work-narrow.png");
  assert.equal(await b.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  assert.equal(await b.evaluate("document.querySelector('.new-work-page').scrollWidth <= innerWidth"), true);
  await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await b.evaluate("localStorage.setItem('wand-theme','graphite');window.dispatchEvent(new StorageEvent('storage',{key:'wand-theme',newValue:'graphite'}));true");
  await b.screenshot(out + "/new-work-narrow-dark-reduced.png");
  await b.click('[aria-label="新工作设置"]');
  await b.screenshot(out + "/new-work-kind-settings.png");
  await b.click('[role=tab][data-state=inactive], [role=tab][aria-selected=false]');
  await b.wait("!document.querySelector('[role=tab]') || !document.querySelector('[role=tab]').checkVisibility()", "choosing a work kind closes its settings");
  await b.evaluate("fixture.close();true");
  // An unconfirmed creation is not the same as an accepted session: keep its
  // captured draft and prohibit repeated creation, but allow leaving to review.
  await b.evaluate("fixture.open({});true");
  await b.wait("!!document.querySelector('.new-work-person')");
  await b.click("textarea"); await b.send("Input.insertText", { text: "unknown creation fixture" });
  refusal = 503;
  const beforeUnknown = writes.length;
  await b.click('.conversation-submit');
  await b.wait("document.querySelector('[aria-label=新建工作]')?.textContent.includes('创建结果未确认')");
  assert.equal(await b.evaluate("document.querySelector('.conversation-submit').disabled"), true);
  assert.equal(await b.evaluate("document.querySelector('textarea').value"), "unknown creation fixture");
  await b.evaluate("document.querySelector('.conversation-submit').click();true");
  assert.equal(writes.length, beforeUnknown + 1);
  await b.click('.new-work-heading button');
  await b.wait("!document.querySelector('[aria-label=新建工作]')");
  assert.ok(writes.every(write => write.path !== "/api/settings/config"));
  assert.deepEqual(b.errors, []);
});
