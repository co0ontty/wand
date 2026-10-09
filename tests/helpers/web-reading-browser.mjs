import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { build } from "esbuild";
import { openBrowser } from "./sidebar-ux-browser.mjs";

const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDOsAAAAASUVORK5CYII=";
const entry = `import React from 'react';import{createRoot}from'react-dom/client';
import './tests/helpers/tool-timeline-browser-harness.ts';
import{WandUiProvider}from'./src/web-ui/react/theme.tsx';
import{Typography,Input}from'antd';
import{ShellTopbar}from'./src/web-ui/react/shell/shell-topbar.tsx';
import{UiStoreProvider}from'./src/web-ui/react/shell/ui-store-react.tsx';
import{MemoryUiAdapter}from'./src/web-ui/react/shell/ui-store.ts';
import{ImageViewerHost}from'./src/web-ui/react/image-viewer/host.tsx';
import{imageViewerController}from'./src/web-ui/react/image-viewer/controller.ts';
const selected={id:'timeline-fixture',source:'wand',provider:'pi',engine:'sdk',kind:'structured',title:'阅读完整工具结果并继续这项工作',description:'已有会话',cwd:'/workspace/projects/wand',status:'idle',statusLabel:'空闲',active:true,selected:true,resumable:true,permissionBlocked:false,inFlight:false,turnActive:false,titleGenerating:false};
let snapshot={auth:{phase:'authenticated'},viewport:{mobile:false,online:true,embedTerminal:false,nativeInput:false},capabilities:{backToNative:false,switchServer:false},layout:{sessionsDrawerOpen:false,sidebarPinned:true,sidebarCollapsed:false,sidebarDrawer:false,sidebarAnchored:true,sessionsBackdropVisible:false,filePanelOpen:false,filePanelBackdropVisible:false,topbarMoreOpen:false,currentView:'chat'},selected,sidebar:{interactiveCount:1,totalCount:1,manageMode:false,selectedCount:0,groups:[]},topbar:{title:selected.title,description:selected.description,statusLabel:'空闲',statusTone:'idle',cwd:selected.cwd,currentTask:'',titleGenerating:false,git:null},legacyVisibility:{terminal:false,chat:true,blank:false,composer:true}};
const store=new MemoryUiAdapter(snapshot);const dispatch=store.dispatch.bind(store);
store.dispatch=action=>{dispatch(action);if(action.type==='topbar.menu.toggle'){snapshot={...snapshot,layout:{...snapshot.layout,topbarMoreOpen:!snapshot.layout.topbarMoreOpen}};store.setSnapshot(snapshot)}};
window.readingFixture={store,imageViewerController};
createRoot(document.getElementById('topbar')).render(<WandUiProvider><UiStoreProvider store={store}><ShellTopbar/><ImageViewerHost/>
<div id="color-probes" aria-hidden="true" style={{position:'fixed',left:-9999,top:0}}>
{['var(--bg-primary)','var(--bg-surface)','var(--bg-secondary)','var(--accent-muted)','#ebe0d3','color-mix(in srgb,var(--accent) 13%,var(--bg-surface))','#f2f3f7'].map((background,i)=><div key={background} data-probe={i} style={{background,padding:8}}><Typography.Text type="secondary">次要文字</Typography.Text><span className="alias-probe" style={{color:'var(--text-secondary)'}}>正文说明</span></div>)}
<Input className="placeholder-probe" placeholder="输入下一项工作"/>
<div className="terminal-probe" style={{background:'var(--bg-terminal)',color:'var(--text-inverse)'}}>终端独立前景</div>
</div></UiStoreProvider></WandUiProvider>);`;
const built = await build({ stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd() },
  bundle: true, format: "iife", write: false, define: { "process.env.NODE_ENV": '"production"' } });
let detailRequests = 0;
const server = createServer((req, res) => {
  if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(built.outputFiles[0].text); return; }
  if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(readFileSync("src/web-ui/content/styles.css")); return; }
  if (req.url.startsWith("/api/sessions/timeline-fixture/tool-content/")) {
    detailRequests++; res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ input: { target: "页面" }, content: [{ type: "text", text: "截图已返回" },
      { type: "image", data: pixel, mimeType: "image/png" }], resultAvailable: true, pending: false })); return;
  }
  if (req.url.startsWith("/api/")) { res.writeHead(404); res.end(); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>body{margin:0;background:var(--bg-primary);color:var(--text-primary)}#chat-output{height:600px;display:flex}.chat-messages{overflow-y:auto}</style></head><body><div id="topbar"></div><div id="chat-output"></div><button id="outside">外部</button><script src="/app.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
const report = { ok: false, cases: [], requests: 0, errors: [] };
try {
  browser = await openBrowser(`http://127.0.0.1:${server.address().port}`, 1440, 900);
  await browser.wait("!!window.toolTimelineHarness && !!document.querySelector('#topbar-more-button')");
  await browser.evaluate("window.h=window.toolTimelineHarness");
  for (const [width, reduce] of [[1440, false], [390, true]]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 640 });
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: width < 640 });
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }, { name: "prefers-color-scheme", value: reduce ? "dark" : "light" }] });
    await browser.settle();
    const contrast = await browser.evaluate(`(()=>{
      const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');
      const l=rgb=>rgb.slice(0,3).reduce((n,v,i)=>{v/=255;return n+(v<=.04045?v/12.92:((v+.055)/1.055)**2.4)*[.2126,.7152,.0722][i]},0);
      const pair=(fg,bg)=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=getComputedStyle(document.body).backgroundColor;ctx.fillRect(0,0,1,1);ctx.fillStyle=bg;ctx.fillRect(0,0,1,1);const b=[...ctx.getImageData(0,0,1,1).data];ctx.fillStyle=fg;ctx.fillRect(0,0,1,1);const f=[...ctx.getImageData(0,0,1,1).data];return{foreground:fg,background:bg,ratio:(Math.max(l(b),l(f))+.05)/(Math.min(l(b),l(f))+.05)}};
      const colors=[...document.querySelectorAll('[data-probe]')].flatMap(n=>[...n.querySelectorAll('span')].map(t=>({probe:n.dataset.probe,...pair(getComputedStyle(t).color,getComputedStyle(n).backgroundColor)})));
      const input=document.querySelector('.placeholder-probe');colors.push({probe:'placeholder',...pair(getComputedStyle(input,'::placeholder').color,getComputedStyle(input).backgroundColor)});
      const term=document.querySelector('.terminal-probe');colors.push({probe:'terminal-inverse',...pair(getComputedStyle(term).color,getComputedStyle(term).backgroundColor)});
      return colors;
    })()`);
    assert.ok(contrast.every(pair => pair.ratio >= 4.5), JSON.stringify(contrast));
    const chrome = await browser.evaluate(`(()=>{const title=document.querySelector('.topbar-session-title'),cwd=document.querySelector('#topbar-cwd');return {title:title.textContent,tool:document.querySelector('.topbar-provider').textContent,cwd:cwd.textContent,full:cwd.getAttribute('aria-label'),overflow:document.documentElement.scrollWidth>innerWidth+1,file:!!document.querySelector('#topbar-file-button'),preview:!!document.querySelector('#topbar-local-preview-button')}})()`);
    assert.equal(chrome.tool, "Wand Agent"); assert.equal(chrome.cwd, "wand"); assert.match(chrome.full, /\/workspace\/projects\/wand/);
    assert.ok(chrome.file && chrome.preview); assert.equal(chrome.overflow, false);
    await browser.click("#topbar-more-button");
    await browser.wait("!!document.querySelector('#topbar-more-menu')");
    assert.equal(await browser.evaluate("!!document.querySelector('[data-chat-width-mode=column]')"), width >= 1280);
    if (width >= 1280) {
      await browser.click("[data-chat-width-mode=column]");
      assert.equal(await browser.evaluate("document.documentElement.dataset.chatWidth"), "column");
      await browser.click("#topbar-more-button"); await browser.wait("!!document.querySelector('[data-chat-width-mode=full]')");
      await browser.click("[data-chat-width-mode=full]");
      assert.equal(await browser.evaluate("document.documentElement.dataset.chatWidth"), "full");
    } else await browser.key("Escape");
    await browser.evaluate(`h.fresh([{role:'assistant',uuid:'usage-${width}',createdAt:'2026-10-09T02:00:00Z',completedAt:'2026-10-09T02:00:04Z',content:[{type:'text',text:'这是一条已完成的回复，正文与执行证据仍然可读。'}],usage:{inputTokens:2400,outputTokens:600,cacheReadInputTokens:1200,totalCostUsd:0.01}}])`);
    await browser.wait("!!document.querySelector('.turn-usage-disclosure')");
    assert.equal(await browser.evaluate("document.querySelector('.turn-usage-disclosure .ant-collapse-header').getAttribute('aria-expanded')"), "false");
    await browser.click(".turn-usage-disclosure .ant-collapse-header");
    await browser.wait("document.querySelector('.turn-usage-summary')?.textContent.includes('2.4k')");
    await browser.evaluate("h.publish(h.turns());h.settle()");
    assert.equal(await browser.evaluate("document.querySelector('.turn-usage-disclosure .ant-collapse-header').getAttribute('aria-expanded')"), "true", "stream patches preserve the user's usage choice");
    await browser.evaluate("h.fresh(h.turns())");
    assert.equal(await browser.evaluate("document.querySelector('.turn-usage-disclosure .ant-collapse-header').getAttribute('aria-expanded')"), "true", "reopening the same transcript restores the usage preference");
    if (process.env.WAND_READING_OUTPUT) {
      mkdirSync(process.env.WAND_READING_OUTPUT, { recursive: true });
      await browser.screenshot(`${process.env.WAND_READING_OUTPUT}/reading-usage-${width}.png`);
    }
    await browser.click(".turn-usage-disclosure .ant-collapse-header");
    await browser.evaluate("h.publish(h.turns());h.settle()");
    assert.equal(await browser.evaluate("document.querySelector('.turn-usage-disclosure .ant-collapse-header').getAttribute('aria-expanded')"), "false");
    const before = detailRequests;
    await browser.evaluate(`h.fresh([{role:'assistant',uuid:'image-${width}',content:[{type:'tool_use',id:'shot',name:'screenshot',input:{},activity:{kind:'other',label:'页面截图'}},{type:'tool_result',tool_use_id:'shot',preview:'{"type":"image","data":"iVBORw0KGgoAAAAAAAA...',content:[{type:'image',data:${JSON.stringify(pixel)},mimeType:'image/png'}]}]}])`);
    await browser.click("button.chat-process-summary");
    assert.equal(detailRequests, before, "summary does not prefetch image data");
    assert.equal(await browser.evaluate("document.querySelector('.chat-call-result').textContent"), "图片结果 · 展开查看");
    assert.equal(await browser.evaluate("document.body.innerText.includes('iVBORw0KGgo')"), false);
    await browser.click("button.chat-call-button");
    await browser.wait("document.querySelector('.inline-tool-image')?.dataset.imageState === 'ready'");
    assert.equal(detailRequests, before + 1);
    await browser.evaluate("document.querySelector('img.inline-tool-image-thumb').focus()");
    await browser.key("Enter");
    await browser.wait("!!document.querySelector('[data-testid=image-viewer-dialog]')");
    assert.equal(await browser.evaluate("window.readingFixture.imageViewerController.getSnapshot().src.startsWith('data:image/png;base64,')"), true);
    await browser.key("Escape");
    await browser.wait("!window.readingFixture.imageViewerController.isOpen()");
    assert.equal(await browser.evaluate("document.activeElement === document.querySelector('img.inline-tool-image-thumb')"), true, "closing the viewer restores the thumbnail focus");
    assert.equal(await browser.evaluate("document.documentElement.scrollWidth>innerWidth+1"), false);
    const touch = await browser.evaluate("(()=>{const button=document.querySelector('#topbar-file-button');return{coarse:matchMedia('(pointer:coarse)').matches,height:button.getBoundingClientRect().height,width:button.getBoundingClientRect().width}})()");
    if (touch.coarse) assert.ok(touch.height >= 44 && touch.width >= 44);
    if (process.env.WAND_READING_OUTPUT) {
      mkdirSync(process.env.WAND_READING_OUTPUT, { recursive: true });
      await browser.screenshot(`${process.env.WAND_READING_OUTPUT}/reading-${width}.png`);
    }
    report.cases.push({ width, reduce, colorScheme: reduce ? "dark" : "light", contrast, compactTitle: true, widthMenu: true, usagePreference: true, imageKeyboardViewer: true, lazyDetail: true, touch });
  }
  report.requests = detailRequests; report.errors = browser.errors; assert.equal(report.errors.length, 0);
  report.ok = true; console.log(JSON.stringify(report));
} catch (error) {
  if (browser) console.error(await browser.evaluate("({menu:document.querySelector('#topbar-more-button')?.outerHTML,popup:document.querySelector('#topbar-more-menu')?.outerHTML,actions:window.readingFixture?.store.actionLog,errors:window.readingFixture?.imageViewerController.getSnapshot()})"));
  throw error;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
