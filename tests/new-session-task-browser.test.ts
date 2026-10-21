import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("one new-work page handles conversation, CLI terminal, shell, task binding and refused creation without default writes", {
  skip: process.env.WAND_NEW_SESSION_TASK_BROWSER !== "1", timeout: 300_000,
}, async t => {
  const source = `import React from 'react';import {createRoot} from 'react-dom/client';
    import {WandUiProvider} from './src/web-ui/react/theme';import {installReactUiStyles} from './src/web-ui/react/styles';
    import {NewSessionHost} from './src/web-ui/react/new-session/host';
    import {newSessionController,newSessionStore} from './src/web-ui/react/new-session/controller';
    import {installNewSessionLegacyAdapter} from './src/web-ui/browser/new-session-adapter';
    import {conversationDraftKey} from './src/web-ui/react/conversations/state';
    import {ComposerStore} from './src/web-ui/browser/composer';import {configureTeamChatComposerRuntime} from './src/web-ui/react/ai-teams/composer-bridge';
    const store=new ComposerStore({storage:()=>localStorage,isUnloading:()=>false,disposeAttachment:()=>{}});
    configureTeamChatComposerRuntime({read:id=>store.read(id),edit:(id,c)=>store.edit(id,c),subscribe:f=>store.subscribe(f),submit:(id,text,f)=>store.submit(id,text,f),transfer:(a,b,r)=>store.transfer(a,b,r)});
    installReactUiStyles();
    window.fixture={open:newSessionController.open,close:()=>newSessionController.close(),store,deliveries:[],draftKey:scope=>conversationDraftKey('new-work:'+scope,null)};
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
  const defaultConfig = { defaultProvider: "claude", defaultSessionKind: "pty", defaultMode: "default", defaultCwd: "/project" };
  let config = defaultConfig;
  // Captured public settings reproduce the installed companion's mixed-provider
  // candidate chain, not the old default-mode/single-agent happy-path fixture.
  const installed = JSON.parse(readFileSync(process.env.WAND_NEW_SESSION_CONFIG_FILE || "tests/fixtures/new-session/managed-companion.json", "utf8"));
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
      if (path === "/api/sessions" || path === "/api/ai-teams/fixture-team/runs") {
        if (refusal) { res.statusCode = typeof refusal === "number" ? refusal : 400; refusal = false; res.end(JSON.stringify({ error: "Fixture creation error" })); }
        else res.end(JSON.stringify(path === "/api/sessions" ? { id: "created-" + writes.length } : { run: { id: "team-run" }, taskId: "team-task" }));
        return;
      }
      res.statusCode = 400; res.end(JSON.stringify({ error: "Unexpected mutation " + path })); return;
    }
    const data = path === "/api/config" ? config
      : path.includes("silicon-employees") ? { employees }
      : path === "/api/ai-teams" ? [{ id: "fixture-team", name: "隔离测试团队", description: "", members: [] }]
      : path === "/api/workspaces" ? config === defaultConfig ? [] : [{ id: "regression-project", kind: "project", cwd: config.defaultCwd, name: "fixture" }]
      : path === "/api/models" ? { piModels: [{ id: "page-model", label: "Page Model" }] }
      : path === "/api/recent-paths" ? [{ path: "/other/project", name: "other" }]
      : path.startsWith("/api/tasks") ? []
      : path === "/api/path-suggestions" ? [] : [];
    res.end(JSON.stringify(data));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const out = process.env.WAND_NEW_SESSION_TASK_OUTPUT || "output/new-session-task-browser"; mkdirSync(out, { recursive: true });
  const b = await openBrowser(origin, 1280, 900); t.after(() => b.close());
  await b.wait("!!window.fixture");
  await b.evaluate("fixture.open({});true");
  await b.wait("document.querySelector('.new-work-person')?.textContent.includes('默认伙伴')");
  assert.equal(writes.length, 0, "opening never starts a process");
  assert.equal(await b.evaluate("document.querySelector('.new-work-submit-status') === null"), true, "idle validation does not add a status row or blank spacer");
  assert.equal(await b.evaluate("document.querySelector('.conversation-submit').disabled"), true, "removing the guidance row still rejects an empty structured draft");
  await b.click("textarea"); await b.key("Enter");
  assert.equal(writes.length, 0, "empty Enter never creates a resource");
  assert.match(await b.evaluate("document.querySelector('.conversation-submit').title"), /请输入工作内容/);
  await b.settle();
  assert.match(await b.evaluate("document.querySelector('.new-work-context h1').textContent"), /今天你想与[\s\S]*在[\s\S]*project[\s\S]*的[\s\S]*默认任务[\s\S]*中创造些什么？/);
  await b.click(".new-work-inline-avatar");
  await b.wait("!!document.querySelector('[aria-label=搜索执行对象]')");
  await b.key("Escape");
  await b.wait("!document.querySelector('[aria-label=搜索执行对象]') || !document.querySelector('[aria-label=搜索执行对象]').checkVisibility()");
  await b.click(".new-work-inline-directory");
  await b.wait("!!document.querySelector('[aria-label=新工作运行目录路径]')");
  await b.key("Escape");
  await b.wait("!document.querySelector('[aria-label=新工作运行目录路径]') || !document.querySelector('[aria-label=新工作运行目录路径]').checkVisibility()");
  const assertCenteredInvitation = async () => {
    const geometry = await b.evaluate(`(()=>{
      const context=document.querySelector('.new-work-context'), bounds=context.getBoundingClientRect();
      const children=[...context.children].map(child=>child.getBoundingClientRect());
      const top=Math.min(...children.map(r=>r.top)),bottom=Math.max(...children.map(r=>r.bottom));
      return {verticalError:Math.abs((top+bottom-bounds.top-bounds.bottom)/2),
        horizontalErrors:children.map(r=>Math.abs(r.x+r.width/2-bounds.x-bounds.width/2)),
        overlapsComposer:bottom>document.querySelector('.new-work-composer').getBoundingClientRect().top};
    })()`);
    assert.ok(geometry.verticalError < 2, `invitation group is vertically centered: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.horizontalErrors.every((error: number) => error < 2), "every invitation element is horizontally centered");
    assert.equal(geometry.overlapsComposer, false, "centering never overlaps the composer");
  };
  await assertCenteredInvitation();
  const layout = await b.evaluate(`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width}};return {bar:rect('.new-work-context-bar'),editor:rect('textarea'),submit:rect('.conversation-submit')}})()`);
  assert.ok(layout.bar.top > 650, "the composer is anchored near the bottom");
  assert.ok(Math.abs(layout.bar.bottom - layout.editor.top) < 24, "the metadata strip must join the editor, not float above it");
  assert.ok(layout.submit.bottom > layout.editor.bottom);
  await b.screenshot(out + "/new-work-idle.png");
  await b.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 420, deviceScaleFactor: 1, mobile: false });
  await b.settle();
  await assertCenteredInvitation();
  assert.ok(await b.evaluate("document.querySelector('.new-work-context').getBoundingClientRect().top >= document.querySelector('.new-work-heading').getBoundingClientRect().bottom"), "short windows keep the invitation below the heading");
  await b.screenshot(out + "/new-work-short-centered.png");
  await b.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await b.click('[aria-label="新工作设置"]');
  assert.equal(await b.evaluate("document.querySelector('[role=tab][aria-selected=true]').textContent"), "对话");
  await b.key("Escape");
  await b.wait("!document.querySelector('[role=tab]') || !document.querySelector('[role=tab]').checkVisibility()");
  await b.click(".new-work-person"); await b.wait("!!document.querySelector('[aria-label=搜索执行对象]')");
  await b.click("[aria-label=搜索执行对象]"); await b.send("Input.insertText", { text: "另一位" });
  await b.click('.wand-execution-subject-picker input[value="employee:e_other"]');
  await b.wait("document.querySelector('.new-work-person').textContent.includes('另一位员工')");
  assert.ok(await b.evaluate("!!document.querySelector('[aria-label=所属任务]')"), "ordinary new-work entry always exposes task binding");
  await b.evaluate("document.querySelector('[aria-label=所属任务]').click();true");
  assert.ok(await b.evaluate("document.querySelector('[aria-label=所属任务]').checkVisibility()"), "task selector remains available on the ordinary entry");
  await b.key("Escape");
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
  const beforeNewline = writes.length;
  await b.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
  await b.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
  assert.equal(writes.length, beforeNewline, "Shift+Enter does not start work");
  await b.screenshot(out + "/new-work-desktop.png");
  refusal = true;
  await b.key("Enter");
  await b.wait("!!document.querySelector('[role=alert]')");
  assert.ok(await b.evaluate("document.querySelector('textarea').value.includes('真实草稿')"));
  assert.equal(await b.evaluate("Math.round(document.querySelector('.conversation-submit').getBoundingClientRect().bottom)"), Math.round(layout.submit.bottom), "failure feedback cannot move the send slot");
  await b.click('.conversation-submit');
  await b.wait("!document.querySelector('[aria-label=新建工作]')");
  assert.equal(writes.length, 2);
  assert.equal(writes[1].path, "/api/sessions");
  assert.equal(writes[1].body.kind, "structured");
  assert.equal(writes[1].body.employeeId, "e_other"); assert.equal(writes[1].body.cwd, "/changed");
  assert.equal(writes[1].body.overrideCli, true); assert.equal(writes[1].body.engine, "sdk"); assert.equal(writes[1].body.model, "page-model");
  assert.match(await b.evaluate("receipt.text"), /真实草稿/);
  await b.evaluate("fixture.open({});true");
  await b.wait("document.querySelector('.new-work-person')?.textContent.includes('默认伙伴')");
  await b.click(".new-work-person"); await b.click("[aria-label=搜索执行对象]");
  await b.send("Input.insertText", { text: "Codex" });
  await b.click("textarea"); await b.send("Input.insertText", { text: "direct CLI fixture" });
  await b.click('[aria-label="本页执行工具"]');
  await b.click('[role=option][data-menu-id$="codex"]');
  await b.wait("document.querySelector('[aria-label=本页执行工具]').textContent.includes('Codex')");
  assert.equal(await b.evaluate("document.querySelector('[aria-label=确认新工作执行权限]') === null"), true, "high-permission execution needs no extra acknowledgement checkbox");
  assert.equal(await b.evaluate("document.querySelector('.conversation-submit').disabled"), false, "the send slot stays enabled once the draft is valid");
  await b.click('.conversation-submit'); await b.wait("!document.querySelector('[aria-label=新建工作]')");
  assert.equal(writes.at(-1)!.body.kind, "structured");
  assert.equal(writes.at(-1)!.body.mode, "full-access");
  assert.equal(writes.at(-1)!.body.provider, "codex");
  assert.equal(writes.at(-1)!.body.employeeId, "e_wand_default");
  assert.equal(writes.at(-1)!.body.overrideCli, true);
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
    const last = writes.at(-1)!; assert.equal(last.path, "/api/sessions"); assert.equal(last.body.kind, "pty"); assert.equal(last.body.cwd, "/terminal");
    assert.equal(last.body.cols, 100); assert.equal(last.body.rows, 30);
    if (kind === "shell") { assert.equal(last.body.kind, "pty"); assert.equal(last.body.shell, true); assert.equal(last.body.provider, undefined); }
    // 临时执行配置随打开实例丢弃：新开的终端用配置默认，不沿用上一页选过的 CLI。
    else { assert.equal(last.body.provider, "claude"); assert.equal(last.body.command, "claude"); assert.equal(last.body.thinkingEffort, "off"); }
  }
  await b.evaluate("fixture.open({workspaceTaskId:'t1',workspaceId:'ws',initialCwd:'/bound'});true");
  await b.wait("!!document.querySelector('.new-work-person')");
  assert.equal(await b.evaluate("document.querySelector('.new-work-directory').disabled"), true);
  await b.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await b.settle();
  await assertCenteredInvitation();
  await b.screenshot(out + "/new-work-narrow.png");
  assert.equal(await b.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  assert.equal(await b.evaluate("document.querySelector('.new-work-page').scrollWidth <= innerWidth"), true);
  await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await b.evaluate("localStorage.setItem('wand-theme','graphite');window.dispatchEvent(new StorageEvent('storage',{key:'wand-theme',newValue:'graphite'}));true");
  await b.settle();
  await assertCenteredInvitation();
  await b.screenshot(out + "/new-work-narrow-dark-reduced.png");
  await b.click('[aria-label="新工作设置"]');
  await b.screenshot(out + "/new-work-kind-settings.png");
  await b.click('[role=tab][data-state=inactive], [role=tab][aria-selected=false]');
  await b.wait("!document.querySelector('[role=tab]') || !document.querySelector('[role=tab]').checkVisibility()", "choosing a work kind closes its settings");
  await b.evaluate("fixture.close();true");
  // Reproduce TASK-124 with the installed configuration shape and an actual
  // localStorage restore into a new ComposerStore (full browser reload).
  config = installed.config;
  employees.splice(0, employees.length, installed.employee);
  await b.send("Page.reload");
  await b.wait("!!window.fixture");
  for (const bound of [false, true]) {
    const scope = bound ? "regression-bound-task" : "regression-project";
    const text = `TASK-124 isolated restored draft ${scope}`;
    await b.evaluate(`localStorage.setItem('wand-draft-'+fixture.draftKey(${JSON.stringify(scope)}),${JSON.stringify(text)});fixture.open(${JSON.stringify({ workspaceId: bound ? "regression-project" : scope, ...(bound ? { workspaceTaskId: scope } : {}) })});true`);
    await b.wait("document.querySelector('.new-work-person')?.textContent.includes('赛博虎妞')");
    assert.equal(await b.evaluate("document.querySelector('textarea').value"), text, "restore real persistent draft before any input event");
    assert.equal(await b.evaluate("document.querySelector('[aria-label=确认新工作执行权限]') === null"), true, "no separate permission acknowledgement is rendered");
    assert.equal(await b.evaluate("document.querySelector('.conversation-submit').disabled"), false, "a restored valid draft is ready to send immediately");
    const before = writes.length;
    if (bound) {
      // Direct-tool -> employee must discard the old manual override so the
      // label and submitted candidate still agree without any acknowledgement.
      await b.click('.new-work-person');
      await b.click('.wand-execution-subject-picker input[value="cli:qoder"]');
      assert.equal(await b.evaluate("document.querySelector('.conversation-submit').disabled"), false);
      await b.click('.new-work-person');
      await b.click('.wand-execution-subject-picker input[value="employee:e_wand_default"]');
      assert.match(await b.evaluate("document.querySelector('[aria-label=本页执行工具]').textContent"), /Pi/);
      assert.equal(await b.evaluate("document.querySelector('.conversation-submit').disabled"), false, "changing employee keeps the draft sendable");
    }
    await b.screenshot(out + (bound ? '/managed-bound-ready.png' : '/managed-restored-ready.png'));
    const slot = await b.evaluate("document.querySelector('.conversation-submit').getBoundingClientRect().bottom");
    await b.click("textarea"); await b.send("Input.insertText", { text: " + fresh input" });
    assert.equal(await b.evaluate("document.querySelector('.conversation-submit').disabled"), false, "editing restored text keeps the send slot enabled");
    refusal = 400;
    await b.click('.conversation-submit');
    await b.wait("!!document.querySelector('[role=alert]')");
    assert.equal(writes.length, before + 1);
    assert.equal(await b.evaluate(`localStorage.getItem('wand-draft-'+fixture.draftKey(${JSON.stringify(scope)}))`), text + " + fresh input", "explicit refusal retains persistent draft");
    assert.equal(await b.evaluate("document.querySelector('.conversation-submit').getBoundingClientRect().bottom"), slot, "permission/error feedback does not move the send slot");
    const beforeDeliveries = await b.evaluate("fixture.deliveries.length");
    await b.click("textarea"); await b.key("Enter");
    await b.wait("!document.querySelector('[aria-label=新建工作]')");
    assert.equal(writes.length, before + 2);
    assert.equal(await b.evaluate("fixture.deliveries.length"), beforeDeliveries + 1);
    assert.equal(writes.at(-1)!.body.employeeId, installed.employee.id);
    assert.equal(writes.at(-1)!.body.overrideCli, false, "candidate chain is not replaced by a manual override");
    assert.equal(writes.at(-1)!.body.model, undefined);
    if (bound) assert.equal(writes.at(-1)!.body.workspaceTaskId, scope);
    assert.equal(await b.evaluate(`localStorage.getItem('wand-draft-'+fixture.draftKey(${JSON.stringify(scope)}))`), null, "accepted draft is transferred only once");
  }
  await b.screenshot(out + '/managed-restored-handoff.png');
  await b.evaluate("fixture.open({workspaceId:'regression-project'});true");
  await b.wait("!!document.querySelector('.new-work-person')");
  await b.click('.new-work-person');
  await b.click('.wand-execution-subject-picker input[value="team:fixture-team"]');
  await b.wait("document.querySelector('.new-work-person')?.textContent.includes('隔离测试团队')");
  await b.click('textarea'); await b.send('Input.insertText', { text: 'isolated team unknown-delivery fixture, never a real run' });
  assert.equal(await b.evaluate("document.querySelector('[aria-label=确认新工作执行权限]') === null"), true, "team never asks for a local CLI acknowledgement");
  assert.equal(await b.evaluate("document.querySelector('.conversation-submit').disabled"), false);
  refusal = 503;
  const beforeTeam = writes.length;
  await b.click('.conversation-submit');
  await b.wait("document.querySelector('.new-work-submit-status').textContent.includes('创建结果未确认')");
  await b.wait("document.querySelector('.new-work-heading button').disabled === false");
  assert.equal(writes.length, beforeTeam + 1);
  assert.equal(writes.at(-1)!.path, '/api/ai-teams/fixture-team/runs');
  assert.match(await b.evaluate("document.querySelector('textarea').value"), /team unknown-delivery fixture/);
  assert.equal(await b.evaluate("fixture.store.read(fixture.draftKey('regression-project')).memoryOnly"), true);
  assert.equal(await b.evaluate("localStorage.getItem('wand-draft-'+fixture.draftKey('regression-project'))"), null, "unknown team note cannot become a durable sendable draft");
  await b.click('textarea'); await b.key('Enter');
  assert.equal(writes.length, beforeTeam + 1, "unknown team start cannot replay");
  await b.evaluate("fixture.close();fixture.open({workspaceId:'regression-project'});true");
  await b.wait("!!document.querySelector('.new-work-person')");
  assert.equal(await b.evaluate("document.querySelector('.conversation-submit').disabled"), true, "unknown team identity remains guarded after reopening");
  assert.equal(writes.length, beforeTeam + 1);
  await b.evaluate("fixture.close();true");
  config = defaultConfig;
  employees.splice(0, employees.length, { id: "e_wand_default", name: "默认伙伴", duty: "", agents });
  await b.send("Page.reload");
  await b.wait("!!window.fixture");
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
  await b.evaluate("fixture.open({});true");
  await b.wait("document.querySelector('[aria-label=新建工作]')?.textContent.includes('创建结果未确认')");
  assert.equal(await b.evaluate("document.querySelector('.conversation-submit').disabled"), true);
  assert.equal(writes.length, beforeUnknown + 1, "closing and reopening the same draft scope cannot retry an unknown creation");
  await b.click('.new-work-heading button');
  await b.wait("!document.querySelector('[aria-label=新建工作]')");
  assert.ok(writes.every(write => write.path !== "/api/settings/config"));
  assert.deepEqual(b.errors, []);
});
