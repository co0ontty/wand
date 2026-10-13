import assert from "node:assert/strict";
import { build } from "esbuild";
import express from "express";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import { registerFileRoutes } from "../../src/server-file-routes.ts";
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

export async function runHtmlPreviewBrowser() {
  const output = "output/html-artifact-preview"; mkdirSync(output, { recursive: true });
  const root = mkdtempSync(join(os.tmpdir(), "wand-html-browser-"));
  writeFileSync(join(root, "index.html"), `<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui;background:#fcf5e8;margin:16px}button{padding:12px}</style><h1>可交互 HTML</h1><button id="increment">增加</button><output id="count">0</output><script src="app.js"></script>`);
  writeFileSync(join(root, "app.js"), `let n=0;document.querySelector('#increment').onclick=()=>document.querySelector('#count').textContent=++n;let parentBlocked=false,cookieBlocked=false;try{parent.document.body}catch{parentBlocked=true}try{document.cookie}catch{cookieBlocked=true}parent.postMessage({htmlProbe:true,parentBlocked,cookieBlocked},'*');`);
  writeFileSync(join(root, "large.html"), '<!doctype html><h1>大文件 HTML</h1>' + ' '.repeat(600_000));
  const storage = new WandStorage(join(root, "wand.db"));
  for (const id of ["timeline-fixture", "im-source", "group-source"]) storage.saveSession({ id, command: "pi", cwd: root, mode: "default", status: "exited", startedAt: new Date().toISOString(), output: "" });
  const avatar = resolve("output/architecture-stage2/sculpted-cat-avatars/refinement/preview/preview.html");
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';
import './tests/helpers/tool-timeline-browser-harness.ts';
import {WandUiProvider} from './src/web-ui/react/theme';
import {installReactUiStyles} from './src/web-ui/react/styles';
import {LocalPreviewHost} from './src/web-ui/react/local-preview/host';
import {FilePreviewHost} from './src/web-ui/react/file-preview/host';
import {filePreviewController} from './src/web-ui/react/file-preview/controller';
import {MarkdownPreview} from './src/web-ui/react/file-preview/markdown';
import {ConversationSessionReply} from './src/web-ui/react/conversations/session-preview';
import {ConversationMessages} from './src/web-ui/react/ai-teams/team-chat-view';
import {setWandTheme} from './src/web-ui/react/theme-preference';
installReactUiStyles();window.setHtmlTheme=setWandTheme;window.htmlProbes=[];
addEventListener('message',e=>{if(e.data?.htmlProbe)htmlProbes.push(e.data)});
window.openHtmlFile=path=>filePreviewController.open({path});
window.renderHtmlCases=()=>createRoot(document.getElementById('react-cases')).render(<WandUiProvider>
<section id="im-case"><ConversationSessionReply active turn={{sessionLink:{sessionId:'im-source',title:'私聊工作'},sessionPreview:{status:'completed',text:'[私聊三维预览](index.html)'}}} onOpen={()=>{}}/></section>
<section id="group-case"><ConversationMessages turns={[{role:'assistant',createdAt:'2026-10-10T13:00:00Z',author:{id:'fixture',name:'测试员工',sessionId:'group-source'},content:[{type:'text',text:'[群聊三维预览](index.html)'}]}]} group ready active mentionNames={[]} employeeIds={{}}/></section>
<section id="file-markdown-case"><MarkdownPreview content={'[文件里的HTML](index.html)'} fileContext={{cwd:${JSON.stringify(root)}}}/></section>
</WandUiProvider>);
createRoot(document.getElementById('overlay')).render(<WandUiProvider><LocalPreviewHost/><FilePreviewHost/></WandUiProvider>);`;
  const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, format: "iife", write: false, define: { "process.env.NODE_ENV": '"production"' } });
  const app = express();
  app.get("/app.js", (_req, res) => res.type("js").send(bundle.outputFiles[0].text));
  app.get("/style.css", (_req, res) => res.type("css").send(readFileSync("src/web-ui/content/styles.css")));
  app.get("/tailwind.css", (_req, res) => res.type("css").send(readFileSync("src/web-ui/content/tailwind.css")));
  registerFileRoutes(app, { storage, defaultCwd: root });
  app.get("/", (_req, res) => res.type("html").send('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/tailwind.css"><style>body{margin:0}#chat-output{display:flex;height:700px}.chat-messages{overflow:auto}section{padding:12px;max-width:100%;min-width:0}</style></head><body><input id="draft" value="不能丢掉草稿"><div id="chat-output"></div><div id="react-cases"></div><div id="overlay"></div><div id="overlay-root"><div id="wand-react-ui-portals" class="wand-ui-portals"></div></div><script src="/app.js"></script></body></html>'));
  const server = createServer(app); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let b; const report = { ok: false, modes: [], errors: [], productionAvatar: false };
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
        assert.equal(frame.sandbox,"allow-scripts"); assert.ok(frame.width > 100 && frame.width <= width); assert.ok(frame.height >= 240);
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
      await frame.close();
      assert.ok(Number(count.result.value)>0,"actual inline HTML button works");
      await b.click('.chat-html-preview .wand-inline-html-enlarge'); await b.wait("!!document.querySelector('.wand-local-preview-frame')");
      await b.key("Escape"); await b.wait("!document.querySelector('.wand-local-preview-frame')");
      assert.equal(await b.evaluate("document.querySelector('#draft').value"),"不能丢掉草稿");
      report.modes.push({name,width,inlineButtonWorks:true,previewAndEscape:true});
    }
    assert.ok(await b.evaluate("htmlProbes.length>=4 && htmlProbes.every(p=>p.parentBlocked&&p.cookieBlocked)"), "scripts cannot access the parent or cookie");
    // A missing file is a visible, retryable failure. Late HEAD responses cannot resurrect the old iframe.
    await b.evaluate("toolTimelineHarness.fresh([{role:'assistant',uuid:'html-artifact',content:[{type:'text',text:'[缺失预览](missing.html)'}]}])");
    await b.wait("document.querySelector('.chat-html-preview')?.textContent.includes('文件不存在')");
    assert.equal(await b.evaluate("document.querySelectorAll('.chat-html-preview iframe').length"),0);
    await b.evaluate(`openHtmlFile(${JSON.stringify(join(root,"large.html"))})`);
    await b.wait("!!document.querySelector('.wand-file-preview-dialog iframe')");
    await b.key("Escape");
    // The user's actual 2MB self-contained WebGL avatar file, not an HTML mock.
    await b.evaluate(`toolTimelineHarness.fresh([{role:'assistant',uuid:'avatar-artifact',content:[{type:'text',text:${JSON.stringify('[实际头像预览](<' + avatar + '>)')}}]}])`);
    await b.wait("!!document.querySelector('.chat-html-preview iframe')");
    await b.evaluate("document.querySelector('.chat-html-preview').scrollIntoView({block:'center'})");
    await b.wait("document.querySelector('.chat-html-preview iframe').getBoundingClientRect().height>240");
    const avFrame = await connectFrame(b, Buffer.from(avatar).toString("base64url"));
    const avResult = await avFrame.send("Runtime.evaluate",{expression:"({canvas:document.querySelectorAll('canvas').length,body:document.body.innerText.slice(0,300)})",returnByValue:true});
    await avFrame.close();
    assert.ok(avResult.result.value.canvas>0); report.productionAvatar=avResult.result.value;
    await b.screenshot(`${output}/actual-avatar.png`);
    report.errors = b.errors; assert.equal(b.errors.length,0); report.ok=true;
  } finally {
    writeFileSync(`${output}/browser.json`,JSON.stringify(report,null,2));
    if(b){if(!report.ok)await b.screenshot(`${output}/failure.png`).catch(()=>{});await b.close();}
    await new Promise(resolve=>server.close(resolve)); storage.close(); rmSync(root,{recursive:true,force:true});
  }
  return report;
}
