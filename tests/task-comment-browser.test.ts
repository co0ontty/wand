import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openPlushBrowser } from "./helpers/run-plush-avatar-browser-harness.mjs";
import express from "express";
import { defaultConfig } from "../src/config.js";
import { WandStorage } from "../src/storage.js";
import { StructuredSessionManager } from "../src/structured-session-manager.js";
import { SessionRegistry } from "../src/session-registry.js";
import { registerTaskCommentRoutes } from "../src/task-comment-dispatch.js";

test("comment @ dispatch browser: picker, replies, live links, late receipt, ordinary text and narrow layout", { timeout: 180_000, skip: process.env.WAND_COMMENT_BROWSER !== "1" }, async () => {
  const root = resolve(import.meta.dirname, ".."), temp = mkdtempSync(join(tmpdir(), "wand-comments-"));
  const output = join(root, "output/architecture-stage2/comment-dispatch-20261018/browser"); mkdirSync(output, { recursive: true });
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import React from "react";import {createRoot} from "react-dom/client";
    import {WandUiProvider} from "./src/web-ui/react/theme";
    import {installReactUiStyles} from "./src/web-ui/react/styles";
    import {TaskComments} from "./src/web-ui/react/issues/task-comments";
    import {taskBoardRepository} from "./src/web-ui/react/issues/task-board-repository";
    import {PortalContainerProvider} from "./src/web-ui/react/ui";
    import {HttpResponseError} from "./src/web-ui/react/http-adapter";
    installReactUiStyles();window.qa={requests:[],comments:[],opened:[],delay:false,reject:false,reads:[],deferReads:false};
    const interval=window.setInterval.bind(window);window.setInterval=(fn,ms,...args)=>{if(ms===5000){qa.poll=fn;return 0;}return interval(fn,ms,...args)};
    Object.assign(taskBoardRepository,{comments:async()=>{if(qa.deferReads)return new Promise(resolve=>qa.reads.push(resolve));return qa.comments},postComment:async(id,input)=>{
      qa.requests.push(input);if(qa.reject)throw new HttpResponseError("明确拒绝测试",400);
      if(qa.delay)await new Promise(resolve=>qa.release=resolve);
      const comment={id:"comment-"+qa.requests.length,taskId:id,body:input.body,sourceCommentId:input.sourceCommentId,authorName:"用户",createdAt:"2026-10-18T01:00:00Z",dispatch:input.employeeId?{employeeId:input.employeeId,employeeName:input.employeeId==="stable-a"?"赛博虎妞":"瑞辰",state:"accepted",status:"running",sessionId:"exact-session-"+qa.requests.length}:null};
      qa.comments=[...qa.comments,comment];return {comment,replayed:false};
    }});
    createRoot(document.getElementById("root")).render(<PortalContainerProvider container={document.getElementById("portals")}><WandUiProvider><main style={{maxWidth:760,margin:"auto",padding:12}}><TaskComments taskId="fixture-task" updatedAt="now" employees={[{id:"stable-a",name:"赛博虎妞"},{id:"stable-b",name:"瑞辰"},...Array.from({length:6},(_,i)=>({id:"other-"+i,name:"其他员工"+i}))]} onOpenSession={id=>qa.opened.push(id)}/></main></WandUiProvider></PortalContainerProvider>);
  ` }, bundle: true, format: "iife", platform: "browser", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => { if(req.url==="/app.js"){res.setHeader("content-type","text/javascript");res.end(readFileSync(join(temp,"app.js")));} else res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><div id="overlay-root"><div id="portals" class="wand-ui-portals"></div></div><script src="/app.js"></script></body></html>'); });
  server.listen(0,"127.0.0.1"); await once(server,"listening"); const address=server.address();assert.ok(address&&typeof address==="object");
  const browser=await openPlushBrowser(); const {evaluate,wait,send}=browser;
  const click = async (selector: string) => { await browser.settle(); await browser.click(selector); await browser.settle(); };
  const type = async (value: string) => { await click('[aria-label="任务评论输入"]'); await send("Input.insertText", {text:value}); };
  try {
    await send("Page.navigate", {url:`http://127.0.0.1:${address.port}`}); await wait("!!document.querySelector('[aria-label=任务评论输入]')");
    assert.equal(await evaluate("document.querySelectorAll('.ant-empty').length"), 0, "empty comments keep the composer adjacent instead of inserting a duplicate empty illustration");
    const initialBox = await evaluate("document.querySelector('[data-comment-submit-phase]').getBoundingClientRect().toJSON()");
    await type("literal @name"); await click('[data-comment-submit-phase]'); await wait("qa.requests.length===1 && qa.comments.length===1");
    assert.equal(await evaluate("qa.requests[0].employeeId"),null,"text alone never dispatches");
    await type("@虎妞"); await wait("document.querySelectorAll('[role=option]').length===1");
    assert.ok(await evaluate("!!document.querySelector('[aria-label=任务评论输入]')"),"mention menu keeps the composer mounted");
    await click('[role=option]');await type("only this round");
    await evaluate("qa.delay=true");await click('[data-comment-submit-phase]');await wait("qa.requests.length===2");
    await type(" new draft");await evaluate("qa.release();qa.delay=false");await wait("qa.comments.length===2");
    assert.equal(await evaluate("document.querySelector('[aria-label=任务评论输入]').value"),"@赛博虎妞 only this round new draft");
    await wait("document.body.innerText.includes('执行中')");await browser.clickText("查看执行");assert.equal(await evaluate("qa.opened[0]"),"exact-session-2");
    await browser.clickText("回复并 @");
    await wait("document.querySelector('[aria-label=任务评论输入]').value.endsWith('@') && document.querySelector('[aria-label=任务评论输入]').getAttribute('aria-expanded')==='true'");
    await evaluate("(()=>{const n=document.querySelector('[aria-label=任务评论输入]');n.focus();n.setSelectionRange(n.value.length,n.value.length)})()");
    await send("Input.insertText",{text:"瑞辰"});await wait("document.querySelectorAll('[role=option]').length===1");await click('[role=option]');
    await click('[data-comment-submit-phase]');await wait("qa.requests.length===3 && qa.comments.length===3");
    assert.equal(await evaluate("qa.requests[2].sourceCommentId"),"comment-1");assert.equal(await evaluate("qa.requests[2].employeeId"),"stable-b");
    await wait("document.querySelector('[aria-label=任务评论输入]').value===''");
    await type("failed stays");await evaluate("qa.reject=true");await click('[data-comment-submit-phase]');await wait("document.body.innerText.includes('明确拒绝测试')");
    assert.equal(await evaluate("document.querySelector('[aria-label=任务评论输入]').value"),"failed stays");

    assert.equal(await evaluate("document.querySelector('[data-comment-submit-phase]').getAttribute('data-comment-submit-phase')"),"failed");
    const failedBox = await evaluate("document.querySelector('[data-comment-submit-phase]').getBoundingClientRect().toJSON()");
    assert.equal(failedBox.width, initialBox.width);assert.equal(failedBox.height, initialBox.height);
    await evaluate("qa.deferReads=true;qa.poll();qa.poll()");await wait("qa.reads.length===2");
    await evaluate("qa.reads[1](qa.comments.map(c=>c.dispatch?{...c,dispatch:{...c.dispatch,status:'stopped'}}:c))");await wait("document.body.innerText.includes('已停止')");
    await evaluate("qa.reads[0](qa.comments)");await browser.settle();
    assert.equal(await evaluate("document.querySelectorAll('[aria-label=评论执行状态]')[0].textContent.includes('已停止')"),true,"slow old poll cannot roll stopped back to running");
    await evaluate("qa.deferReads=false;qa.poll()");await wait("document.body.innerText.includes('执行中')");
    await browser.screenshot(join(output,"desktop.png"));
    await send("Emulation.setDeviceMetricsOverride",{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await evaluate("Object.assign(document.querySelector('main').style,{maxWidth:'960px',paddingTop:'650px',position:'absolute',inset:'0',overflow:'auto',boxSizing:'border-box'});qa.comments=qa.comments.map((c,i)=>i===1?{...c,body:'长评论与本轮指令 '.repeat(100)}:c);qa.poll()");await browser.settle();
    await evaluate(`(()=>{const n=document.querySelector('[aria-label="任务评论输入"]');document.querySelector('main').scrollTop+=n.getBoundingClientRect().y-860;document.querySelectorAll('.ant-list-item')[1].querySelector('button').dataset.bottomReply='original'})()`);
    const pointer = async(selector:string) => {const p=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ["mousePressed","mouseReleased"])await send("Input.dispatchMouseEvent",{type,...p,button:"left",clickCount:1});await browser.settle();};
    await pointer('[data-bottom-reply="original"]');
    await wait("document.querySelector('[aria-label=任务评论输入]').getAttribute('aria-expanded')==='true'");
    await wait("!!document.querySelector('[role=listbox]')");
    await wait("!document.getAnimations().some(a=>a.playState==='running'&&Number.isFinite(a.effect?.getComputedTiming().endTime))");
    const beforeSearch = await evaluate(`(()=>{const t=document.querySelector('[aria-label="任务评论输入"]'),p=document.querySelector('[role=listbox]');return{trigger:t.getBoundingClientRect().toJSON(),popup:p.getBoundingClientRect().toJSON()}})()`);
    assert.ok(beforeSearch.popup.bottom <= beforeSearch.trigger.top + 2,"bottom-edge mention opens upward");
    await evaluate("(()=>{const n=document.querySelector('[aria-label=任务评论输入]');n.focus();n.setSelectionRange(n.value.length,n.value.length)})()");
    await send("Input.insertText",{text:"瑞辰"});await browser.settle();
    await evaluate(`qa.optionNode=document.querySelector('[role=option][title="@瑞辰"]');qa.poll()`);await browser.settle();
    assert.equal(await evaluate(`qa.optionNode===document.querySelector('[role=option][title="@瑞辰"]')`),true,"poll preserves open option DOM instance");
    assert.equal(await evaluate("(()=>{const n=qa.optionNode,r=n.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('[role=option]')===n})()"),true,"comment body cannot intercept option center");
    await pointer('[role=option][title="@瑞辰"]');
    await wait("document.querySelector('[aria-label=任务评论输入]').value.includes('@瑞辰')");
    assert.equal(await evaluate("qa.requests.length"),4,"selection-only probe must not dispatch");
    await browser.screenshot(join(output,"reply-bottom.png"));

    await send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:false});
    await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
    await evaluate("(()=>{const n=document.querySelector('[aria-label=任务评论输入]');n.focus();n.setSelectionRange(n.value.length,n.value.length)})()");
    await send("Input.insertText",{text:"@"});await wait("!!document.querySelector('[role=listbox]')");await browser.key("Escape");
    await wait("!document.querySelector('[role=listbox]')");
    assert.ok(await evaluate("document.documentElement.scrollWidth <= innerWidth"),"narrow screen has no horizontal overflow");
    await browser.screenshot(join(output,"narrow.png"));
  } catch(error) { console.log(await evaluate("document.body.innerText"));await browser.screenshot(join(output,"failure.png"));throw error; }
  finally { await browser.close();await new Promise<void>(done=>{server.close(()=>done());server.closeAllConnections();}); }
});

test("actual HTTP 201 unknown survives browser reload, new text and returning to the old instruction without another send", { timeout: 120_000, skip: process.env.WAND_COMMENT_BROWSER !== "1" }, async () => {
  const root = resolve(import.meta.dirname, ".."), temp = mkdtempSync(join(tmpdir(), "wand-comment-unknown-browser-"));
  const storage = new WandStorage(join(temp, "wand.db"));
  const config = { ...defaultConfig(), defaultCwd: temp };
  const manager = new StructuredSessionManager(storage, config);
  const sessions = new SessionRegistry({ getOwned: () => null, getOwnedSlim: () => null } as never, manager, storage);
  const employee = { id: "e_unknown_browser", name: "离线员工", duty: "fixture", prompt: "offline fixture only", avatar: "cat:0", tags: [],
    agents: [{ provider: "claude", model: "fixture", mode: "default", kind: "structured", thinkingEffort: "off" }], createdAt: "2026-10-18", updatedAt: "2026-10-18" };
  storage.saveSiliconEmployee(employee as never);
  const task = storage.createWandTask({ title: "isolated unknown delivery", description: "not auto-injected" });
  let sends = 0, uncertain = true;
  manager.sendMessage = (() => { sends++; if (uncertain) throw Error("offline fixture delivery unknown"); return Promise.resolve(); }) as never;
  const requests: string[] = [];
  const responses: number[] = [];
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    if (req.method === "POST" && req.path.endsWith("/comments")) { requests.push(req.body.requestId); res.on("finish", () => responses.push(res.statusCode)); }
    next();
  });
  registerTaskCommentRoutes(app, { storage, config, structured: manager, sessions });
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import React from "react";import {createRoot} from "react-dom/client";
    import {TaskComments} from "./src/web-ui/react/issues/task-comments";
    import {WandUiProvider} from "./src/web-ui/react/theme";
    import {PortalContainerProvider} from "./src/web-ui/react/ui";
    import {installReactUiStyles} from "./src/web-ui/react/styles";
    installReactUiStyles();createRoot(document.getElementById("root")).render(
      <PortalContainerProvider container={document.getElementById("portals")}><WandUiProvider>
        <TaskComments taskId={${JSON.stringify(task.id)}} updatedAt="fixture" employees={[{id:"e_unknown_browser",name:"离线员工"}]}/>
      </WandUiProvider></PortalContainerProvider>);
  ` }, bundle: true, format: "iife", platform: "browser", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  app.get("/app.js", (_req, res) => res.type("js").send(readFileSync(join(temp, "app.js"))));
  app.get("/", (_req, res) => res.send('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root" style="max-width:900px;margin:auto"></div><div id="overlay-root"><div id="portals" class="wand-ui-portals"></div></div><script src="/app.js"></script></body></html>'));
  const server = createServer(app); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const browser = await openPlushBrowser();
  const reload = async () => {
    await browser.evaluate("window.oldCommentPage=true"); await browser.send("Page.reload", {});
    await browser.wait("!window.oldCommentPage && !!document.querySelector('[aria-label=任务评论输入]')");
  };
  const submit = async (body: string) => {
    await browser.wait("!!document.querySelector('[aria-label=任务评论输入]') && document.querySelector('[aria-label=任务评论]')?.getAttribute('aria-busy')==='false'");
    await browser.click('[aria-label="任务评论输入"]');
    await browser.send("Input.insertText", { text: "@" });
    await browser.wait(`!!document.querySelector('[role=option][title="@离线员工"]')`);
    await browser.click('[role=option][title="@离线员工"]');
    await browser.wait("document.querySelector('[aria-label=任务评论输入]').value.includes('@离线员工')");
    await browser.send("Input.insertText", { text: body });
    await browser.click("[data-comment-submit-phase]");
  };
  try {
    await browser.send("Page.navigate", { url: `http://127.0.0.1:${address.port}` });
    await submit("original unknown instruction");
    await browser.wait("!!document.querySelector('[data-comment-submit-phase=unknown]')");
    assert.deepEqual(responses, [201]); assert.equal(sends, 1);
    const original = storage.listWandTaskComments(task.id)[0]!;
    assert.equal(original.dispatch?.state, "unknown");
    await reload();
    await submit("original unknown instruction");
    await browser.wait("!!document.querySelector('[data-comment-submit-phase=unknown]')");
    assert.deepEqual(responses, [201, 200]); assert.equal(requests[1], requests[0]);
    assert.equal(sends, 1); assert.equal(storage.listWandTaskComments(task.id).length, 1);
    uncertain = false;
    await submit("separate new instruction");
    await browser.wait("!!document.querySelector('[data-comment-submit-phase=saved]')");
    assert.equal(sends, 2); assert.notEqual(requests[2], requests[0]);
    await reload();
    await submit("original unknown instruction");
    await browser.wait("!!document.querySelector('[data-comment-submit-phase=unknown]')");
    assert.equal(requests[3], requests[0]); assert.equal(sends, 2);
    assert.equal(storage.listWandTaskComments(task.id).length, 2);
    assert.equal(storage.listWandTaskComments(task.id)[0]!.id, original.id);
    await browser.screenshot(join(root, "output/architecture-stage2/comment-dispatch-20261018/browser/unknown201-refresh.png"));
  } finally {
    await browser.close(); await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
    manager.dispose(); storage.close(); rmSync(temp, { recursive: true, force: true });
  }
});
