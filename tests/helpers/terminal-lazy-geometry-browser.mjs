import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { build } from "esbuild";
import { openBrowser } from "./sidebar-ux-browser.mjs";

const built = await build({ stdin: { loader: "ts", resolveDir: process.cwd(), contents: `
import{state}from'./src/web-ui/browser/state.ts';
import{ensureTerminalReady,withTerminalDimensions}from'./src/web-ui/browser/session-engine.ts';
import{fitTerminalToContainer}from'./src/web-ui/browser/terminal-fit.ts';
import{initTerminal}from'./src/web-ui/browser/terminal.ts';
import{teardownTerminal}from'./src/web-ui/browser/viewport.ts';
state.sessions=[{id:'structured-before-create',sessionKind:'structured',status:'idle',output:''}];
state.selectedId='structured-before-create';state.currentView='chat';state.config={};
window.geometryFixture={state,initTerminal,configure(kind){teardownTerminal();state.sessions=kind==='structured'?[{id:'structured-before-create',sessionKind:'structured',status:'idle',output:''}]:[];state.selectedId=kind==='structured'?'structured-before-create':null;
document.querySelector('#output').style.display='none';document.querySelector('#chat-output').style.display=kind==='structured'?'flex':'none';document.querySelector('#blank-chat').style.display=kind==='blank'?'flex':'none';document.querySelector('.input-panel').style.display=kind==='structured'?'flex':'none'},
async prepare(){await ensureTerminalReady();return withTerminalDimensions({shell:true})},
show(){document.querySelector('#chat-output').style.display='none';document.querySelector('#blank-chat').style.display='none';document.querySelector('.input-panel').style.display='flex';const node=document.querySelector('#output');node.classList.remove('hidden');node.style.display='flex';node.style.visibility='visible';
fitTerminalToContainer(state.terminal,state.terminalFitAddon);return{cols:state.terminal.cols,rows:state.terminal.rows}},
stats(){return{cols:state.terminal?.cols,rows:state.terminal?.rows,display:getComputedStyle(document.querySelector('#output')).display,visibility:getComputedStyle(document.querySelector('#output')).visibility,chatDisplay:getComputedStyle(document.querySelector('#chat-output')).display,blankDisplay:getComputedStyle(document.querySelector('#blank-chat')).display,composerDisplay:getComputedStyle(document.querySelector('.input-panel')).display}}};
` }, bundle: true, format: "iife", write: false, define: { "process.env.NODE_ENV": '"production"' } });
const server = createServer((req, res) => {
  if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(built.outputFiles[0].text); return; }
  if (req.url === "/xterm.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync("src/web-ui/content/vendor/xterm/xterm.bundle.js")); return; }
  if (req.url === "/xterm.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync("src/web-ui/content/vendor/xterm/xterm.css")); return; }
  if (req.url === "/style.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync("src/web-ui/content/styles.css")); return; }
  if (req.url.startsWith("/api/")) { res.writeHead(404); res.end(); return; }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="wand-xterm-script" content="/xterm.js"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/xterm.css"><style>html,body{margin:0;height:100%}.main-content{display:flex;flex-direction:column;height:100%;position:relative}.header{height:52px;flex:none}.composer{height:120px;flex:none}#output,#chat-output,#blank-chat{position:relative;flex:1;min-height:0;overflow:hidden}#chat-output{display:flex}</style></head><body><main class="main-content"><div class="header">已有对话保持可见</div><div id="output" class="hidden" style="display:none"></div><div id="chat-output">已有对话内容</div><div id="blank-chat" style="display:none">首次空白页面</div><div class="input-panel composer">输入区</div></main><script src="/app.js"></script></body></html>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await openBrowser(`http://127.0.0.1:${server.address().port}`, 390, 900);
  await browser.wait("!!window.geometryFixture");
  const cases = [];
  for (const kind of ["structured", "blank"]) {
    await browser.evaluate(`geometryFixture.configure(${JSON.stringify(kind)})`);
    const initial = await browser.evaluate("geometryFixture.stats()");
    const posted = await browser.evaluate("geometryFixture.prepare()");
    await browser.settle(); const prepared = await browser.evaluate("geometryFixture.stats()");
    await browser.evaluate("geometryFixture.show()");
    await browser.settle(); const actual = await browser.evaluate("geometryFixture.show()");
    for (const field of ["display", "visibility", "chatDisplay", "blankDisplay", "composerDisplay"]) assert.equal(prepared[field], initial[field], `measurement restores ${field}`);
    assert.deepEqual(posted, { shell: true, ...actual }, "first POST dimensions match the first displayed terminal");
    cases.push({ kind, initial, posted, prepared, actual, dimensionsMatch: true, layoutStylesRestored: true });
  }
  await browser.evaluate("geometryFixture.configure('blank');window.originalOpen=XTermLib.Terminal.prototype.open;XTermLib.Terminal.prototype.open=function(){throw new Error('fixture open failure')}");
  const failureBefore = await browser.evaluate("geometryFixture.stats()");
  await browser.evaluate("geometryFixture.prepare()");
  const failureAfter = await browser.evaluate("geometryFixture.stats()");
  await browser.evaluate("XTermLib.Terminal.prototype.open=window.originalOpen");
  for (const field of ["display", "visibility", "chatDisplay", "blankDisplay", "composerDisplay"]) assert.equal(failureAfter[field], failureBefore[field], `failure restores ${field}`);
  assert.equal(await browser.evaluate("geometryFixture.state.terminalInitializing"), false);
  console.log(JSON.stringify({ cases, failureRestoresLayout: true }));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
