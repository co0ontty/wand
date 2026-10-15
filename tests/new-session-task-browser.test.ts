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
    import {newSessionController,configureNewSessionRuntime} from './src/web-ui/react/new-session/controller';
    import {ComposerStore} from './src/web-ui/browser/composer';import {configureTeamChatComposerRuntime} from './src/web-ui/react/ai-teams/composer-bridge';
    const store=new ComposerStore({storage:()=>localStorage,isUnloading:()=>false,disposeAttachment:()=>{}});
    configureTeamChatComposerRuntime({read:id=>store.read(id),edit:(id,c)=>store.edit(id,c),subscribe:f=>store.subscribe(f),submit:(id,text,f)=>store.submit(id,text,f),transfer:(a,b,r)=>store.transfer(a,b,r)});
    installReactUiStyles();configureNewSessionRuntime({onOpen(){},onClose(){},getContext:()=>({effectiveCwd:'/project'}),rememberModel(){throw Error('No default writes')},prepareCreate:async kind=>kind==='structured'?{}:{cols:100,rows:30},completeCreate:async(request,created,capture)=>{store.retain(new Set([created.id]));window.receipt={request,created,text:capture?store.read(capture.key).text:''};if(capture&&!store.transfer(capture.key,created.id,capture.revision))throw Error('transfer failed')}});
    window.fixture={open:newSessionController.open,close:()=>newSessionController.close(),store};
    createRoot(document.getElementById('root')).render(<WandUiProvider><NewSessionHost/></WandUiProvider>);`;
  const built = await build({ stdin: { contents: source, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  const agents = [{ provider: "pi", engine: "sdk", model: "employee-model", thinkingEffort: "off", mode: "default", kind: "structured" }];
  const employees = [{ id: "e_wand_default", name: "默认伙伴", duty: "", agents }, { id: "e_other", name: "另一位员工", duty: "", agents }];
  const writes: Array<{ path: string; body: any }> = [];
  let refusal = false;
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
        if (refusal) { refusal = false; res.statusCode = 400; res.end(JSON.stringify({ error: "明确拒绝，输入保留" })); }
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
  const out = "output/architecture-stage2/conversation-execution-preference"; mkdirSync(out, { recursive: true });
  const b = await openBrowser(origin, 1280, 900); t.after(() => b.close());
  await b.wait("!!window.fixture");
  await b.evaluate("fixture.open({});true");
  await b.wait("document.querySelector('.new-work-person')?.textContent.includes('默认伙伴')");
  assert.equal(writes.length, 0, "opening never starts a process");
  assert.equal(await b.evaluate("document.querySelector('[role=tab][aria-selected=true]').textContent"), "对话");
  await b.click(".new-work-person"); await b.wait("!!document.querySelector('[aria-label=搜索执行对象]')");
  await b.click("[aria-label=搜索执行对象]"); await b.send("Input.insertText", { text: "另一位" });
  await b.click('.wand-execution-subject-picker input[value="employee:e_other"]');
  await b.wait("document.querySelector('.new-work-person').textContent.includes('另一位员工')");
  await b.click(".new-work-directory");
  await b.click("[aria-label=新工作运行目录路径]");
  await b.evaluate("document.querySelector('[aria-label=新工作运行目录路径]').select();true");
  await b.send("Input.insertText", { text: "/changed" }); await b.key("Enter");
  await b.wait("document.querySelector('.new-work-directory').textContent.includes('/changed')");
  await b.click('[aria-label="本页模型"]'); await b.click('[aria-label="搜索本页模型"]');
  await b.send("Input.insertText", { text: "Page Model" });
  await b.click('[role=option][data-menu-id$="page-model"]');
  await b.click(".composer-compact-entry"); await b.wait("document.activeElement===document.querySelector('textarea')");
  await b.send("Input.insertText", { text: "新工作的真实草稿（隔离测试）" });
  await b.screenshot(out + "/new-work-desktop.png");
  refusal = true;
  await b.click('.conversation-submit');
  await b.wait("!!document.querySelector('[role=alert]')");
  assert.ok(await b.evaluate("document.querySelector('textarea').value.includes('真实草稿')"));
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
  await b.click(".composer-compact-entry"); await b.send("Input.insertText", { text: "direct CLI fixture" });
  await b.click('.conversation-submit'); await b.wait("!document.querySelector('[aria-label=新建工作]')");
  assert.equal(writes.at(-1)!.body.provider, "codex");
  assert.equal(writes.at(-1)!.body.employeeId, undefined);
  for (const kind of ["pty", "shell"]) {
    await b.evaluate(`fixture.open({initialKind:${JSON.stringify(kind)},initialCwd:'/terminal'});true`);
    await b.wait("!!document.querySelector('.new-work-directory')");
    if (kind === "shell") assert.equal(await b.evaluate("document.querySelectorAll('.conversation-runtime-summary').length"), 0);
    await b.click('.conversation-submit'); await b.wait("!document.querySelector('[aria-label=新建工作]')");
    const last = writes.at(-1)!; assert.equal(last.path, "/api/commands"); assert.equal(last.body.cwd, "/terminal");
    assert.equal(last.body.cols, 100); assert.equal(last.body.rows, 30);
    if (kind === "shell") { assert.equal(last.body.shell, true); assert.equal(last.body.provider, undefined); }
    else { assert.equal(last.body.provider, "codex"); assert.equal(last.body.command, "codex"); assert.equal(last.body.thinkingEffort, "off"); }
  }
  await b.evaluate("fixture.open({workspaceTaskId:'t1',workspaceId:'ws',initialCwd:'/bound'});true");
  await b.wait("!!document.querySelector('.new-work-person')");
  assert.equal(await b.evaluate("document.querySelector('.new-work-directory').disabled"), true);
  await b.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await b.settle(); await b.screenshot(out + "/new-work-narrow.png");
  assert.equal(await b.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await b.evaluate("fixture.close();true");
  assert.ok(writes.every(write => write.path !== "/api/settings/config"));
  assert.deepEqual(b.errors, []);
});
