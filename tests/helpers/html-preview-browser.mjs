import assert from "node:assert/strict";
import { build } from "esbuild";
import express from "express";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import { registerFileRoutes } from "../../src/server-file-routes.ts";
import { registerLocalPreviewRoutes } from "../../src/server-local-preview-routes.ts";
import { WandStorage } from "../../src/storage.ts";
import { openPlushBrowser } from "./run-plush-avatar-browser-harness.mjs";

let frameSequence = 0;
async function connectFrame(browser, encodedPath, selector) {
  let frameId;
  if (selector) {
    const { root } = await browser.send("DOM.getDocument");
    const { nodeId } = await browser.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { node } = await browser.send("DOM.describeNode", { nodeId });
    frameId = node.frameId;
  }
  // A sandboxed opaque-origin iframe is an OOPIF in modern Chromium. Inspect
  // its own target through CDP; do not weaken site isolation to make tests easy.
  for (let attempt = 0; attempt < 250; attempt++) {
    const { targetInfos } = await browser.send("Target.getTargets");
    const target = targetInfos.find(item => item.type === "iframe" && item.url.includes(encodedPath) && (!frameId || item.targetId === frameId));
    if (target) {
      const { sessionId } = await browser.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
      return { close: () => browser.send("Target.detachFromTarget", { sessionId }),
        async send(method, params) {
          const id = ++frameSequence;
          await browser.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) });
          for (let n = 0; n < 250; n++) {
            const event = browser.events.find(e => e.method === "Target.receivedMessageFromTarget" && e.params.sessionId === sessionId && JSON.parse(e.params.message).id === id);
            if (event) { const message = JSON.parse(event.params.message); assert.ok(!message.error, JSON.stringify(message.error)); return message.result; }
            await new Promise(resolve => setTimeout(resolve, 40));
          }
          throw new Error("Iframe CDP response missing: " + method);
        }
      };
    }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("Sandboxed artifact iframe target missing");
}

async function frameValue(frame, expression) {
  const result = await frame.send("Runtime.evaluate", { expression, returnByValue: true });
  assert.equal(result.exceptionDetails, undefined, "iframe inspection must not throw");
  return result.result.value;
}

async function waitFrame(frame, expression) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await frameValue(frame, expression)) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("Iframe condition missing: " + expression);
}

async function clickFrame(browser, frame, iframeSelector, selector) {
  await browser.evaluate("toolTimelineHarness.settle()");
  await browser.evaluate(`document.querySelector(${JSON.stringify(iframeSelector)}).scrollIntoView({block:'center'})`);
  const point = await frameValue(frame, `(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const outer = await browser.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(iframeSelector)}).getBoundingClientRect();return {x:r.x,y:r.y}})()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await browser.send("Input.dispatchMouseEvent", { type, x: outer.x + point.x, y: outer.y + point.y, button: "left", clickCount: 1 });
  }
}

async function verifyFormSafety(browser, frame, iframeSelector, surface) {
  await waitFrame(frame, "!!document.querySelector('#react-save')");
  await clickFrame(browser, frame, iframeSelector, "#react-save");
  await waitFrame(frame, "document.querySelector('#save-result').textContent==='已保存：1'");
  assert.equal(await frameValue(frame, "formViolations.length"), 0, "preventDefault handles a React submit without navigation");
  await clickFrame(browser, frame, iframeSelector, "#native-submit");
  await waitFrame(frame, "nativeSubmitEvents===1 && formViolations.some(v=>v.directive==='form-action'&&v.disposition==='enforce')");
  assert.equal(await frameValue(frame, "document.querySelector('#save-result').textContent"), "已保存：1", "blocked native submission leaves the demo mounted");
  assert.deepEqual(await frameValue(frame, "({parentBlocked,cookieBlocked})"), { parentBlocked: true, cookieBlocked: true });
  return { surface, reactSubmitWorks: true, nativeSubmitBlocked: true, opaqueOrigin: true };
}

export async function runHtmlPreviewBrowser() {
  const output = "output/html-artifact-preview"; mkdirSync(output, { recursive: true });
  const root = mkdtempSync(join(os.tmpdir(), "wand-html-browser-"));
  writeFileSync(join(root, "index.html"), `<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;background:#fcf5e8;margin:16px}button{padding:12px}form{margin-block:12px}</style><h1>可交互 HTML</h1><button id="increment">增加</button><output id="count">0</output><div id="react-form"></div><form id="native-form" action="native-submit" method="post"><input name="fixture" value="test-only" type="hidden"><button id="native-submit" type="submit">原生提交安全检查</button></form><script src="app.js"></script>`);
  const demoBundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';
let n=0;document.querySelector('#increment').onclick=()=>document.querySelector('#count').textContent=++n;
window.parentBlocked=false;window.cookieBlocked=false;try{parent.document.body}catch{window.parentBlocked=true}try{document.cookie}catch{window.cookieBlocked=true}
window.formViolations=[];window.nativeSubmitEvents=0;
document.addEventListener('securitypolicyviolation',event=>{if(event.effectiveDirective==='form-action')formViolations.push({directive:event.effectiveDirective,disposition:event.disposition})});
document.querySelector('#native-form').addEventListener('submit',()=>nativeSubmitEvents++);
function SaveForm(){const [saved,setSaved]=React.useState(0);return <form onSubmit={event=>{event.preventDefault();setSaved(value=>value+1)}}><button id="react-save" type="submit">保存</button><output id="save-result">{'已保存：'+saved}</output></form>}
createRoot(document.querySelector('#react-form')).render(<SaveForm/>);
parent.postMessage({htmlProbe:true,parentBlocked,cookieBlocked},'*');`, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, format: "iife", jsx: "automatic", write: false, define: { "process.env.NODE_ENV": '"production"' } });
  writeFileSync(join(root, "app.js"), demoBundle.outputFiles[0].text);
  writeFileSync(join(root, "large.html"), '<!doctype html><h1>大文件 HTML</h1>' + ' '.repeat(600_000));
  mkdirSync(join(root, "site.with.dots"));
  writeFileSync(join(root, "site.with.dots/index.html"), readFileSync(join(root, "large.html")));
  const storage = new WandStorage(join(root, "wand.db"));
  for (const id of ["timeline-fixture", "im-source", "group-source"]) storage.saveSession({ id, command: "pi", cwd: root, mode: "default", status: "exited", startedAt: new Date().toISOString(), endedAt: null, exitCode: 0, output: "", archived: false, archivedAt: null, claudeSessionId: null });
  const avatar = resolve("output/architecture-stage2/sculpted-cat-avatars/refinement/preview/preview.html");
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';
import './tests/helpers/tool-timeline-browser-harness.ts';
import {WandUiProvider} from './src/web-ui/react/theme';
import {installReactUiStyles} from './src/web-ui/react/styles';
import {LocalPreviewHost} from './src/web-ui/react/local-preview/host';
import {localPreviewController} from './src/web-ui/react/local-preview/controller';
import {FilePreviewHost} from './src/web-ui/react/file-preview/host';
import {filePreviewController} from './src/web-ui/react/file-preview/controller';
import {MarkdownPreview} from './src/web-ui/react/file-preview/markdown';
import {ConversationSessionReply} from './src/web-ui/react/conversations/session-preview';
import {ConversationMessages} from './src/web-ui/react/ai-teams/team-chat-view';
import {setWandTheme} from './src/web-ui/react/theme-preference';
installReactUiStyles();window.setHtmlTheme=setWandTheme;window.htmlProbes=[];
addEventListener('message',e=>{if(e.data?.htmlProbe)htmlProbes.push(e.data)});
window.openHtmlFile=path=>filePreviewController.open({path});
window.openHttpPreview=url=>localPreviewController.openUrl(url);
window.htmlPreviewSnapshot=()=>localPreviewController.getSnapshot();
window.renderHtmlCases=()=>createRoot(document.getElementById('react-cases')).render(<WandUiProvider>
<section id="im-case"><ConversationSessionReply active turn={{sessionLink:{sessionId:'im-source',title:'私聊工作'},sessionPreview:{status:'completed',text:'[私聊三维预览](index.html)'}}} onOpen={()=>{}}/></section>
<section id="group-case"><ConversationMessages turns={[{role:'assistant',createdAt:'2026-10-10T13:00:00Z',author:{id:'fixture',name:'测试员工',sessionId:'group-source'},content:[{type:'text',text:'[群聊三维预览](index.html)'}]}]} group ready active mentionNames={[]} employeeIds={{}}/></section>
<section id="file-markdown-case"><MarkdownPreview content={'[文件里的HTML](index.html)'} fileContext={{cwd:${JSON.stringify(root)}}}/></section>
</WandUiProvider>);
createRoot(document.getElementById('overlay')).render(<WandUiProvider><LocalPreviewHost/><FilePreviewHost/></WandUiProvider>);`;
  const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, format: "iife", jsx: "automatic", write: false, define: { "process.env.NODE_ENV": '"production"' } });
  const app = express();
  let nativeRequests = 0;
  app.use((req, res, next) => {
    if (req.path.endsWith("/native-submit")) { nativeRequests++; res.status(204).end(); return; }
    next();
  });
  const allowFixture = (_req, _res, next) => next();
  registerLocalPreviewRoutes(app, { requireAuth: allowFixture, requireFiles: allowFixture });
  app.get("/app.js", (_req, res) => res.type("js").send(bundle.outputFiles[0].text));
  app.get("/style.css", (_req, res) => res.type("css").send(readFileSync("src/web-ui/content/styles.css")));
  app.get("/tailwind.css", (_req, res) => res.type("css").send(readFileSync("src/web-ui/content/tailwind.css")));
  registerFileRoutes(app, { storage, defaultCwd: root });
  app.get("/", (_req, res) => res.type("html").send('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/tailwind.css"><style>body{margin:0}#chat-output{display:flex;height:700px}.chat-messages{overflow:auto}section{padding:12px;max-width:100%;min-width:0}</style></head><body><input id="draft" value="不能丢掉草稿"><div id="chat-output"></div><div id="react-cases"></div><div id="overlay"></div><div id="overlay-root"><div id="wand-react-ui-portals" class="wand-ui-portals"></div></div><script src="/app.js"></script></body></html>'));
  const server = createServer(app); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const upstreamApp = express();
  upstreamApp.get("/", (_req, res) => res.type("html").send(readFileSync(join(root, "index.html"))));
  upstreamApp.get("/app.js", (_req, res) => res.type("js").send(demoBundle.outputFiles[0].text));
  upstreamApp.get("/report.pdf", (_req, res) => res.type("pdf").send("%PDF-1.4\nfile fixture\n"));
  upstreamApp.all("/native-submit", (_req, res) => { nativeRequests++; res.status(204).end(); });
  const upstream = createServer(upstreamApp); await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  let b; const report = { ok: false, modes: [], formSafety: [], nativeRequests: 0, errors: [], productionAvatar: false };
  try {
    b = await openPlushBrowser();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await b.send("Page.navigate", { url: origin }); await b.wait("!!window.toolTimelineHarness && !!window.renderHtmlCases");
    await b.evaluate("renderHtmlCases()");
    for (const [name, width, theme, reduced] of [["desktop",1280,"warm",false],["mobile",390,"warm",false],["dark-narrow-reduced",320,"graphite",true],["native-shell",390,"warm",false],["rollback",390,"warm",false]]) {
      await b.send("Emulation.setDeviceMetricsOverride", { width, height: 950, deviceScaleFactor: 1, mobile: width < 640 });
      await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
      await b.evaluate(`setHtmlTheme(${JSON.stringify(theme)});document.documentElement.classList.toggle('is-wand-app',${name === "native-shell"});history.replaceState(null,'',${JSON.stringify(name === "rollback" ? "/?reactUi=0" : "/")})`);
      await b.evaluate(`toolTimelineHarness.fresh([{role:'assistant',uuid:'html-artifact',content:[{type:'text',text:'[运行预览](index.html)'}]}])`);
      await b.wait("!!document.querySelector('.chat-html-preview iframe')");
      for (const scope of [".chat-html-preview", "#im-case", "#group-case", "#file-markdown-case"]) {
        await b.evaluate(`document.querySelector(${JSON.stringify(scope)}).scrollIntoView({block:'center'})`);
        await b.wait(`!!document.querySelector(${JSON.stringify(scope + " iframe")})`);
        const frame = await b.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(scope + " iframe")});const r=n.getBoundingClientRect();return {sandbox:n.getAttribute('sandbox'),width:r.width,height:r.height,viewport:innerWidth}})()`);
        assert.equal(frame.sandbox,"allow-scripts allow-forms"); assert.ok(frame.width > 100 && frame.width <= width); assert.ok(frame.height >= 240);
      }
      await b.evaluate("document.querySelector('.chat-html-preview').scrollIntoView({block:'center'})");
      await b.screenshot(`${output}/${name}.png`);
      // Source frame interaction via real CDP input, not a parent-origin escape.
      await b.wait("htmlProbes.length>0");
      const frame = await connectFrame(b, Buffer.from(join(root, "index.html")).toString("base64url"), '.chat-html-preview iframe');
      const result = await frame.send("Runtime.evaluate", { expression: "(()=>{const r=document.querySelector('#increment').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()", returnByValue: true });
      // The first iframe belongs to the session; scroll back before using its coordinates.
      const rect = await b.evaluate("(()=>{const r=document.querySelector('.chat-html-preview iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()");
      await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x:rect.x+result.result.value.x,y:rect.y+result.result.value.y,button:"left",clickCount:1 });
      await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x:rect.x+result.result.value.x,y:rect.y+result.result.value.y,button:"left",clickCount:1 });
      const count = await frame.send("Runtime.evaluate", { expression:"document.querySelector('#count').textContent",returnByValue:true });
      if (name === "desktop") report.formSafety.push(await verifyFormSafety(b, frame, '.chat-html-preview iframe', "local-file"));
      await frame.close();
      assert.ok(Number(count.result.value)>0,"actual inline HTML button works");
      await b.click('.chat-html-preview .wand-inline-html-enlarge'); await b.wait("!!document.querySelector('.wand-local-preview-frame')");
      await b.key("Escape"); await b.wait("!document.querySelector('.wand-local-preview-frame')");
      assert.equal(await b.evaluate("document.querySelector('#draft').value"),"不能丢掉草稿");
      report.modes.push({name,width,inlineButtonWorks:true,previewAndEscape:true});
    }
    assert.ok(await b.evaluate("htmlProbes.length>=4 && htmlProbes.every(p=>p.parentBlocked&&p.cookieBlocked)"), "scripts cannot access the parent or cookie");
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 950, deviceScaleFactor: 1, mobile: false });
    const upstreamPort = upstream.address().port;
    await b.evaluate(`openHttpPreview(${JSON.stringify(`http://127.0.0.1:${upstreamPort}/`)})`);
    await b.wait("!!document.querySelector('.wand-local-preview-frame')");
    const proxyFrame = await connectFrame(b, `/api/local-preview/127.0.0.1/${upstreamPort}/`, '.wand-local-preview-frame');
    report.formSafety.push(await verifyFormSafety(b, proxyFrame, '.wand-local-preview-frame', "local-http"));
    await proxyFrame.close();
    // Focus is inside the isolated document after its form interaction; use the
    // host's visible close action rather than expecting cross-origin key events.
    await b.click('button[aria-label="关闭预览"]'); await b.wait("!document.querySelector('.wand-local-preview-frame')");
    await b.evaluate(`openHttpPreview(${JSON.stringify(`http://127.0.0.1:${upstreamPort}/report.pdf`)})`);
    await b.wait("document.querySelector('.wand-local-preview-content')?.textContent.includes('文件已就绪')");
    const pdfRoute = `/api/local-preview/127.0.0.1/${upstreamPort}/report.pdf`;
    assert.equal(await b.evaluate("document.querySelector('.wand-local-preview-content a[download]')?.getAttribute('href')"), pdfRoute);
    assert.equal(await b.evaluate(`fetch(${JSON.stringify(pdfRoute)}).then(r=>r.text())`), "%PDF-1.4\nfile fixture\n");
    report.nonHtmlDownload = true;
    await b.click('button[aria-label="关闭预览"]');
    report.nativeRequests = nativeRequests;
    assert.equal(nativeRequests, 0, "CSP blocks native form requests before they reach Wand or the upstream service");
    // A missing file is a visible, retryable failure. Late HEAD responses cannot resurrect the old iframe.
    await b.evaluate("toolTimelineHarness.fresh([{role:'assistant',uuid:'html-artifact',content:[{type:'text',text:'[缺失预览](missing.html)'}]}])");
    await b.wait("document.querySelector('.chat-html-preview')?.textContent.includes('不存在')");
    assert.equal(await b.evaluate("document.querySelectorAll('.chat-html-preview iframe').length"),0);
    await b.evaluate(`openHtmlFile(${JSON.stringify(join(root,"large.html"))})`);
    await b.wait("!!document.querySelector('.wand-file-preview-dialog iframe')");
    await b.key("Escape");
    const directoryRoute = `/api/local-file/${Buffer.from(join(root, "site.with.dots")).toString("base64url")}/?mode=edit#panel`;
    await b.evaluate(`openHtmlFile(${JSON.stringify(directoryRoute)})`);
    await b.wait("!!document.querySelector('.wand-file-preview-dialog iframe')");
    assert.equal(await b.evaluate("document.querySelector('.wand-file-preview-dialog iframe').getAttribute('src')"), directoryRoute);
    report.forwardedLargeDirectory = true;
    await b.key("Escape");
    // The user's actual 2MB self-contained WebGL avatar file, not an HTML mock.
    await b.evaluate(`toolTimelineHarness.fresh([{role:'assistant',uuid:'avatar-artifact',content:[{type:'text',text:${JSON.stringify('[实际头像预览](<' + avatar + '>)')}}]}])`);
    await b.wait("!!document.querySelector('.chat-html-preview iframe')");
    await b.evaluate("document.querySelector('.chat-html-preview').scrollIntoView({block:'center'})");
    await b.wait("document.querySelector('.chat-html-preview iframe').getBoundingClientRect().height>240");
    const avFrame = await connectFrame(b, Buffer.from(avatar).toString("base64url"));
    await waitFrame(avFrame, "document.readyState==='complete' && document.querySelectorAll('canvas').length>0");
    const avResult = await avFrame.send("Runtime.evaluate",{expression:"({canvas:document.querySelectorAll('canvas').length,body:document.body.innerText.slice(0,300)})",returnByValue:true});
    await avFrame.close();
    assert.ok(avResult.result.value.canvas>0); report.productionAvatar=avResult.result.value;
    await b.screenshot(`${output}/actual-avatar.png`);
    report.errors = b.errors; assert.equal(b.errors.length,0); report.ok=true;
  } catch (error) {
    report.errors = b?.errors || [];
    report.failure = { message: String(error), state: b ? await b.evaluate("({preview:htmlPreviewSnapshot(),dialogs:[...document.querySelectorAll('[role=dialog]')].map(n=>n.innerText),errors:[...document.querySelectorAll('[role=alert]')].map(n=>n.innerText)})").catch(() => null) : null };
    throw error;
  } finally {
    report.nativeRequests = nativeRequests;
    writeFileSync(`${output}/browser.json`,JSON.stringify(report,null,2));
    if(b){if(!report.ok)await b.screenshot(`${output}/failure.png`).catch(()=>{});await b.close();}
    await new Promise(resolve=>server.close(resolve)); await new Promise(resolve=>upstream.close(resolve)); storage.close(); rmSync(root,{recursive:true,force:true});
  }
  return report;
}
