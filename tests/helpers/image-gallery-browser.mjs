import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { openPlushBrowser } from "./run-plush-avatar-browser-harness.mjs";

export async function runImageGalleryBrowser() {
  const output = "output/image-gallery"; mkdirSync(output, { recursive: true });
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';
import './tests/helpers/tool-timeline-browser-harness.ts';
import {WandUiProvider} from './src/web-ui/react/theme';
import {installReactUiStyles} from './src/web-ui/react/styles';
import {ImageViewerHost} from './src/web-ui/react/image-viewer/host';
import {imageViewerController} from './src/web-ui/react/image-viewer/controller';
import {setWandTheme} from './src/web-ui/react/theme-preference';
import {ChatMessage} from './src/web-ui/react/chat/message';
import {MarkdownPreview} from './src/web-ui/react/file-preview/markdown';
installReactUiStyles();
window.gallery=imageViewerController;
window.setGalleryTheme=setWandTheme;
window.galleryDocument=crypto.randomUUID();
createRoot(document.getElementById('overlay')).render(<WandUiProvider><ImageViewerHost/></WandUiProvider>);
createRoot(document.getElementById('react-message')).render(<WandUiProvider><ChatMessage content={<MarkdownPreview content={'![React第一张](/image-1.svg)\\n\\n![React第二张](/image-2.svg)'} wrap/>}/></WandUiProvider>);`;
  const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, format: "iife", write: false, define: { "process.env.NODE_ENV": '"production"' } });
  writeFileSync(`${output}/fixture.js`,bundle.outputFiles[0].text);
  const server = createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("Content-Type", "application/javascript; charset=utf-8"); res.end(bundle.outputFiles[0].text); return; }
    if (req.url === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(readFileSync("src/web-ui/content/styles.css")); return; }
    if (req.url === "/tailwind.css") { res.setHeader("Content-Type", "text/css"); res.end(readFileSync("src/web-ui/content/tailwind.css")); return; }
    if (req.url.startsWith("/image-") || req.url.startsWith("/api/file-raw")) {
      res.setHeader("Content-Type", "image/svg+xml");
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600"><rect width="1000" height="600" fill="#fcf5e8"/><path d="M100 100h800v400H100z" stroke="#b8562f" stroke-width="5" fill="none"/></svg>'); return;
    }
    if (req.url.startsWith("/api/")) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/style.css"><style>body{margin:0}#chat-output{display:flex;height:700px}.chat-messages{overflow:auto}#react-message{padding:12px}#react-message img{max-width:160px}</style></head><body><input id="draft" value="保留草稿"><div id="chat-output"></div><div id="react-message"></div><div id="overlay"></div><div id="overlay-root"><div class="wand-ui-portals" id="wand-react-ui-portals"></div></div><script src="/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let b; const evidence = { passed: false, modes: [], touchSource: "Chromium CDP synthesized touch input", errors: [] };
  try {
    b = await openPlushBrowser(); await b.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}` });
    await b.wait("!!window.gallery && !!window.toolTimelineHarness");
    const traceTouches = () => b.evaluate("window.galleryTouches=[];for(const type of ['touchstart','touchmove','touchend','touchcancel'])document.addEventListener(type,e=>{galleryTouches.push({type,target:e.target.tagName,className:e.target.className,touches:[...e.touches].map(p=>({x:p.clientX,y:p.clientY})),changed:[...e.changedTouches].map(p=>({x:p.clientX,y:p.clientY}))});galleryTouches=galleryTouches.slice(-25)},true)");
    await traceTouches();
    const close = async () => { await b.key("Escape"); await b.wait("!document.querySelector('.wand-image-viewer')"); };
    const current = async value => b.wait(`gallery.getSnapshot().current===${value}`);
    const swipe = async (dx, dy = 0, cancel = false) => {
      const point = await b.evaluate("(()=>{const r=document.querySelector('.wand-image-viewer img').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
      await b.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 0 }] });
      for (let step = 1; step <= 6; step++) await b.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x + dx * step / 6, y: point.y + dy * step / 6, id: 0 }] });
      await b.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
      await b.settle();
    };
    for (const [name, width, theme, reduced] of [["desktop",1280,"warm",false],["mobile",390,"warm",false],["narrow-dark-reduced",320,"graphite",true],["rollback",390,"warm",false]].filter(mode=>!process.env.WAND_IMAGE_GALLERY_MODE || mode[0]===process.env.WAND_IMAGE_GALLERY_MODE)) {
      evidence.currentMode=name;
      await b.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 640 });
      await b.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
      await b.evaluate(`setGalleryTheme(${JSON.stringify(theme)})`);
      if (name === "rollback") {
        // CDP stops delivering touch events after reusing this renderer across
        // pinch + navigation. A fresh profile verifies the actual rollback page.
        await b.close();b=await openPlushBrowser(width,900);
        await b.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/?reactUi=0` });
        await b.wait("!!window.gallery && !!window.toolTimelineHarness");
        await b.send("Emulation.setTouchEmulationEnabled", { enabled: true });
        await traceTouches();
      }
      await b.evaluate(`toolTimelineHarness.fresh([{role:'assistant',uuid:'gallery',content:[{type:'text',text:'![第一张](/image-1.svg)\\n\\n![第二张](/image-2.svg)\\n\\n![第三张](/image-1.svg)'}]},{role:'user',uuid:'other',content:[{type:'text',text:'另一条消息'}]}])`);
      await b.wait("document.querySelectorAll('.markdown-content img').length===3 && [...document.querySelectorAll('.markdown-content img')].every(n=>n.naturalWidth>0)");
      await b.click('.markdown-content img[alt="第二张"]'); await current(1);
      await b.wait("!!document.querySelector('.wand-image-viewer[role=dialog] img')");
      assert.equal(await b.evaluate("gallery.getSnapshot().items.length"),3);
      assert.equal(await b.evaluate("document.querySelector('.wand-image-viewer').getAttribute('aria-label')"),"第二张");
      assert.equal(await b.evaluate("!!document.querySelector('#wand-react-ui-portals .wand-image-viewer')"),true);
      await b.key("ArrowRight"); await current(2);
      assert.equal(await b.evaluate("document.querySelector('.ant-image-preview-switch-next').disabled"),true);
      await b.key("ArrowRight"); assert.equal(await b.evaluate("gallery.getSnapshot().current"),2);
      await b.click('.ant-image-preview-switch-prev'); await current(1);
      await swipe(-90); await current(2); await swipe(90); await current(1);
      await swipe(0,80); assert.equal(await b.evaluate("gallery.getSnapshot().current"),1,"vertical gesture never switches");
      await swipe(-20); assert.equal(await b.evaluate("gallery.getSnapshot().current"),1,"short gesture never switches");
      await swipe(-90,0,true); assert.equal(await b.evaluate("gallery.getSnapshot().current"),1,"cancel never switches");
      await b.click('.wand-image-viewer [aria-label=zoomIn]');
      await swipe(-90); assert.equal(await b.evaluate("gallery.getSnapshot().current"),1,"zoomed pan never switches");
      await b.click('.wand-image-viewer [aria-label=zoomOut]');
      // A pinch disqualifies the whole sequence, including when one finger is released first.
      const point = await b.evaluate("(()=>{const r=document.querySelector('.wand-image-viewer img').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
      await b.send("Input.dispatchTouchEvent", { type:"touchStart",touchPoints:[{x:point.x-40,y:point.y,id:0},{x:point.x+40,y:point.y,id:1}] });
      await b.send("Input.dispatchTouchEvent", { type:"touchMove",touchPoints:[{x:point.x-70,y:point.y,id:0},{x:point.x+70,y:point.y,id:1}] });
      await b.send("Input.dispatchTouchEvent", { type:"touchEnd",touchPoints:[] });
      assert.equal(await b.evaluate("gallery.getSnapshot().current"),1);
      assert.equal(await b.evaluate("visualViewport.scale"),1,"pinch zoom belongs to the image, not the page");
      await b.key("Tab"); assert.equal(await b.evaluate("!!document.activeElement.closest('.wand-image-viewer')"),true);
      await b.screenshot(`${output}/${name}.png`);
      const geometry = await b.evaluate("(()=>{const controls=[...document.querySelectorAll('.wand-image-viewer button')].map(n=>{const r=n.getBoundingClientRect();return{width:r.width,height:r.height,left:r.left,right:r.right}});return{controls,overflow:document.documentElement.scrollWidth>innerWidth}})()");
      assert.equal(geometry.overflow,false);
      assert.ok(geometry.controls.every(r=>r.width>=44 && r.height>=44 && r.left>=0 && r.right<=width),JSON.stringify(geometry));
      await close();
      assert.equal(await b.evaluate("document.activeElement.getAttribute('alt')"),"第二张","focus returns to thumbnail");
      assert.equal(await b.evaluate("document.querySelector('#draft').value"),"保留草稿");
      await b.evaluate("document.querySelector('.markdown-content img').focus()");await b.key("Enter");await current(0);await close();
      await b.evaluate("toolTimelineHarness.fresh([{role:'user',uuid:'attachments',content:[{type:'text',text:'[附件已上传，请查看以下文件:\\n/tmp/one.png\\n/tmp/two.png]\\n\\n附件正文'}]}])");
      await b.wait("document.querySelectorAll('.user-attachment-thumb').length===2 && [...document.querySelectorAll('.user-attachment-thumb')].every(n=>n.naturalWidth>0)");
      await b.click('.user-attachment-thumb:nth-of-type(1)');await current(0);
      assert.equal(await b.evaluate("gallery.getSnapshot().items.length"),2);await b.key("ArrowRight");await current(1);await close();
      // The canonical React Markdown used in IM shares grouping and the same host.
      await b.click('#react-message img[alt="React第二张"]');await current(1);
      assert.equal(await b.evaluate("gallery.getSnapshot().items.length"),2);await close();
      await b.evaluate("gallery.open('/image-1.svg','单图')");await b.wait("!!document.querySelector('.wand-image-viewer')");
      assert.equal(await b.evaluate("!!document.querySelector('.ant-image-preview-switch')"),false);await close();
      evidence.modes.push({name,width,geometry,passed:true});
    }
    assert.deepEqual(b.errors,[]);evidence.passed=true;
  } catch (error) {
    evidence.failure={message:error.message,diagnostic:await b?.evaluate("({snapshot:gallery.getSnapshot(),image:document.querySelector('.wand-image-viewer img')?.outerHTML,viewport:{scale:visualViewport.scale,width:visualViewport.width,height:visualViewport.height},touches:window.galleryTouches})").catch(()=>null)};
    throw error;
  } finally {
    evidence.errors=b?.errors??[];writeFileSync(`${output}/browser.json`,JSON.stringify(evidence,null,2));
    if(b)await b.close();await new Promise(resolve=>server.close(resolve));
  }
}
