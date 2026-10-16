// Real paste events and production composer owners; no model or upload request.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("pasted images never intersect composer identity, runtime labels or editor", {
  skip: process.env.WAND_COMPOSER_PASTE_BROWSER !== "1", timeout: 180_000,
}, async () => {
  const root = resolve(import.meta.dirname, ".."), temp = mkdtempSync(join(tmpdir(), "wand-composer-paste-"));
  const output = resolve(root, "output/architecture-stage2/composer-paste-layout");
  mkdirSync(output, { recursive: true });
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import './tests/helpers/composer-panels-browser-harness';
    import {updateInteractiveControls} from './src/web-ui/browser/input';
    import {attachEventListeners} from './src/web-ui/browser/events';
    import {addPendingAttachment,renderAttachmentPreview} from './src/web-ui/browser/session-engine';
    window.pasteFixture={update:updateInteractiveControls,bind:attachEventListeners,add:addPendingAttachment,refresh:renderAttachmentPreview};
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://fixture.invalid").pathname;
    if (path.startsWith("/api/")) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(path === "/api/session-check" ? { authed: false } : {})); return; }
    const files: Record<string, string> = { "/app.js": join(temp, "app.js"), "/styles.css": join(root, "src/web-ui/content/styles.css"), "/tailwind.css": join(root, "src/web-ui/content/tailwind.css") };
    if (files[path]) { response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : "text/css"); response.end(readFileSync(files[path])); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><style>#panels-source-host{display:flex;flex-direction:column;height:100dvh;width:100%}#chat-output{flex:1;min-height:0}#app{height:0}</style></head><body><script src="/app.js"></script></body></html>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const browser = await openBrowser(`http://127.0.0.1:${address.port}/?reactUi=0`, 1280, 900);
  const cases: unknown[] = [];
  try {
    await browser.wait("!!window.composerPanels");
    await browser.evaluate("window.p=window.composerPanels;p.setup()");
    await browser.evaluate(`p.state.sessions[0].employeeId='paste-peer';p.state.sessions[0].employeeName='贴图测试伙伴';p.state.sessions[0].employeeAvatar='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><circle cx="36" cy="36" r="30" fill="gray"/></svg>');pasteFixture.bind();pasteFixture.update();window.original=document.getElementById('input-box');void 0`);
    for (const [name, width, height, native, reduced] of [["desktop", 1280, 900, false, false], ["phone", 390, 844, false, false], ["native-narrow", 320, 640, true, true]] as const) {
      await browser.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
      await browser.evaluate(`document.documentElement.classList.toggle('is-wand-app',${native});p.composer.edit(p.state.selectedId,{clear:true});p.composer.edit(p.state.selectedId,{text:'贴图前的文字'});pasteFixture.refresh();void 0`);
      if (await browser.evaluate("document.querySelector('.input-composer').dataset.composerExpanded==='false'")) await browser.click(".composer-compact-entry");
      else await browser.click("#input-box");
      await browser.wait("document.activeElement===original");
      for (const count of [1, 6]) {
        await browser.evaluate(`(()=>{for(let index=p.composer.read(p.state.selectedId).attachments.length;index<${count};index++){const canvas=document.createElement('canvas');canvas.width=index%2?640:32;canvas.height=index%2?32:640;canvas.getContext('2d').fillRect(0,0,canvas.width,canvas.height);const bytes=Uint8Array.from(atob(canvas.toDataURL().split(',')[1]),c=>c.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'paste-'+index+'.png',{type:'image/png'}));original.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));}if(${count}===6)pasteFixture.add(new File(['mixed'],'长文件名'.repeat(30)+'.txt',{type:'text/plain'}));})()`);
        await browser.wait(`document.querySelectorAll('.composer-attachment-list .ant-file-card-list-item').length===${count === 6 ? 7 : 1}`);
        await browser.wait("[...document.querySelectorAll('.composer-attachment-list img')].every(i=>i.complete&&i.naturalWidth>0)");
        await browser.settle();
        const geometry = await browser.evaluate(`(()=>{const list=document.querySelector('.composer-attachment-list'),l=list.getBoundingClientRect(),i=original.getBoundingClientRect();const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1;const chrome=[...document.querySelectorAll('.composer-floating-avatar,.composer-usage-line,.composer-inline-config')].filter(n=>n.checkVisibility());return{collisions:chrome.filter(n=>overlap(n.getBoundingClientRect(),l)).map(n=>n.className),listAboveInput:l.bottom<=i.top+1,overflow:document.documentElement.scrollWidth>innerWidth,focus:document.activeElement===original,node:original===document.getElementById('input-box'),draft:original.value,sendVisible:document.getElementById('send-input-button').getBoundingClientRect().bottom<=innerHeight,scrollBounded:list.clientHeight<=Math.min(168,innerHeight*.16)+1,imageSizes:[...list.querySelectorAll('.ant-file-card-image')].map(n=>({width:n.offsetWidth,height:n.offsetHeight}))}})()`);
        writeFileSync(join(output, `${name}-${count}.json`), JSON.stringify(geometry, null, 2));
        await browser.screenshot(join(output, `${name}-${count}.png`));
        assert.deepEqual(geometry.collisions, [], "identity and runtime chrome must stay above the pasted attachment region");
        assert.equal(geometry.listAboveInput, true); assert.equal(geometry.overflow, false);
        assert.equal(geometry.focus, true); assert.equal(geometry.node, true); assert.equal(geometry.draft, "贴图前的文字");
        assert.equal(geometry.sendVisible, true); assert.equal(geometry.scrollBounded, true);
        assert.ok(geometry.imageSizes.every((s: { width: number; height: number }) => s.width === 64 && s.height === 60));
        cases.push({ name, count, geometry });
      }
      await browser.key("Escape");
      await browser.wait("document.querySelector('.input-composer').dataset.composerExpanded==='false'");
      assert.equal(await browser.evaluate("document.querySelector('.composer-attachment-list').checkVisibility()"), false);
      assert.equal(await browser.evaluate("p.composer.read(p.state.selectedId).attachments.length"), 7);
      await browser.click(".composer-compact-entry");
      await browser.wait("document.activeElement===original");
      await browser.evaluate("document.querySelector('.ant-file-card-list-remove').focus();void 0");
      await browser.key("Enter");
      await browser.wait("document.querySelectorAll('.ant-file-card-list-item').length===6");
      await browser.settle();
      assert.equal(await browser.evaluate(`(()=>{const list=document.querySelector('.composer-attachment-list').getBoundingClientRect();return [...document.querySelectorAll('.composer-floating-avatar,.composer-usage-line,.composer-inline-config')].every(n=>{const r=n.getBoundingClientRect();return Math.min(r.right,list.right)<=Math.max(r.left,list.left)+1||Math.min(r.bottom,list.bottom)<=Math.max(r.top,list.top)+1})})()`), true, "removal must not move identity into the remaining attachments");
      await browser.evaluate("while(p.composer.read(p.state.selectedId).attachments.length)p.composer.edit(p.state.selectedId,{removeAttachment:0});pasteFixture.refresh();void 0");
      await browser.wait("!document.querySelector('.composer-attachment-list')");
      assert.equal(await browser.evaluate("original.value"), "贴图前的文字");
    }
    assert.deepEqual(browser.errors, []);
    writeFileSync(join(output, "browser.json"), JSON.stringify({ cases, errors: browser.errors }, null, 2));
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    rmSync(temp, { recursive: true, force: true });
  }
});
