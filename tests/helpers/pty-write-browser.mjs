import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { openPlushBrowser } from "./run-plush-avatar-browser-harness.mjs";

const out = "output/architecture-stage2/pty-experience-20261021/write-browser";
mkdirSync(out, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "wand-pty-write-"));
const bundle = join(temp, "app.js");
await build({ stdin: { resolveDir: process.cwd(), loader: "ts", contents: `
import {queueTerminalWrite} from './src/web-ui/browser/terminal-write-queue';
window.runPtyWrite = async mode => {
 const terminal = new XTermLib.Terminal({cols:80,rows:24,allowProposedApi:true,scrollback:100,fontSize:14,cursorBlink:false});
 const host=document.getElementById('terminal');host.replaceChildren();terminal.open(host);
 const chunks=Array.from({length:400},(_,i)=>'\\x1b[H\\x1b[2KProgress '+i+' 中文\\r\\n\\x1b[2K'+('x'.repeat(i%60)));
 chunks.push('\\x1b[H\\x1b[2JFINAL — 400 frames\\r\\nNo duplicate rows.');
 let queue=Promise.resolve(),writes=0,acks=0,painted=0;const original=terminal.write.bind(terminal);
 terminal.write=(data,done)=>{writes++;original(data,done)};
 const start=performance.now();
 for(const data of chunks) {
  if(mode==='before')queue=queue.then(()=>new Promise(resolve=>terminal.write(data,()=>{acks++;painted++;resolve()})));
  else queue=queueTerminalWrite(terminal,data,queue,()=>true,()=>painted++,()=>acks++);
 }
 await queue;const elapsed=performance.now()-start;
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 const lines=Array.from({length:terminal.rows},(_,i)=>terminal.buffer.active.getLine(terminal.buffer.active.baseY+i)?.translateToString(true)||'');
 window.ptyTerminal=terminal;return {mode,elapsed,writes,acks,painted,chars:chunks.join('').length,lines};
};` }, bundle:true,format:"iife",platform:"browser",outfile:bundle });
const server=createServer((req,res)=>{
  if(req.url==="/app.js"){res.setHeader("content-type","text/javascript");res.end(readFileSync(bundle));}
  else if(req.url==="/xterm.js"){res.setHeader("content-type","text/javascript");res.end(readFileSync("src/web-ui/content/vendor/xterm/xterm.bundle.js"));}
  else if(req.url==="/xterm.css"){res.setHeader("content-type","text/css");res.end(readFileSync("src/web-ui/content/vendor/xterm/xterm.css"));}
  else res.end('<!doctype html><link rel="stylesheet" href="/xterm.css"><style>body{margin:0;background:#17120f;color:#f4eee6}#terminal{width:800px;height:540px}</style><div id="terminal"></div><script src="/xterm.js"></script><script src="/app.js"></script>');
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
let browser;
try {
 browser=await openPlushBrowser(900,600,true);
 await browser.send("Page.navigate",{url:`http://127.0.0.1:${server.address().port}/`});
 await browser.wait("typeof window.runPtyWrite==='function'");
 const results=[];
 for(let n=0;n<3;n++)for(const mode of ["before","after"]){
  const result=await browser.evaluate(`runPtyWrite(${JSON.stringify(mode)})`);
  assert.equal(result.acks,401);assert.equal(result.lines[0],"FINAL — 400 frames");assert.equal(result.lines[1],"No duplicate rows.");assert.ok(result.lines.slice(2).every(line=>line===""));
  if(mode==="after")assert.ok(result.writes<=2,"burst is parsed as bounded batches, not one timer per frame");
  results.push(result);
  if(n===2)await browser.screenshot(join(out,mode+".png"));
  await browser.evaluate("ptyTerminal.dispose()");
 }
 const median=mode=>results.filter(r=>r.mode===mode).map(r=>r.elapsed).sort((a,b)=>a-b)[1];
 const report={fixtureOnly:true,realChrome:true,realXterm:true,noModel:true,beforeMedianMs:median("before"),afterMedianMs:median("after"),results,errors:browser.errors};
 assert.deepEqual(browser.errors,[]);writeFileSync(join(out,"results.json"),JSON.stringify(report,null,2));console.log(JSON.stringify({beforeMedianMs:report.beforeMedianMs,afterMedianMs:report.afterMedianMs,beforeWrites:results[0].writes,afterWrites:results[1].writes,acks:401,errors:browser.errors}));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));rmSync(temp,{recursive:true,force:true});}
