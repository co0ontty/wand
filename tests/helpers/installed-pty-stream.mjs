import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPlushBrowser } from "./run-plush-avatar-browser-harness.mjs";

const mode=process.env.PTY_SHELL_MODE||"normal";
assert.ok(["normal","rollback","embed"].includes(mode));
const out=process.env.PTY_EVIDENCE_DIR||"output/architecture-stage2/pty-experience-20261021/installed-stream";
mkdirSync(out,{recursive:true});
const c=JSON.parse(readFileSync(join(process.env.HOME,".wand/acceptance-connection.json"),"utf8"));
const origin=new URL(c.serverURL).origin;
const decoded=Buffer.from(c.connectionCode.replace(/\s/g,""),"base64url").toString();
const login=await fetch(origin+"/api/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({appToken:decoded.slice(decoded.lastIndexOf("#")+1)})});
assert.equal(login.status,200);
const cookies=login.headers.getSetCookie();const headers={cookie:cookies.map(v=>v.split(";")[0]).join("; "),"content-type":"application/json"};
let id,browser;const report={installed:true,noModel:true,ownsSession:true,mode,cases:[]};
try{
 const created=await fetch(origin+"/api/sessions",{method:"POST",headers,body:JSON.stringify({kind:"pty",shell:true,cwd:tmpdir(),cols:100,rows:30})});
 if(!created.ok){report.blocker="Session creation denied: HTTP "+created.status;writeFileSync(join(out,"result.json"),JSON.stringify(report,null,2));throw Error(report.blocker);}
 id=(await created.json()).id;assert.ok(id);
 browser=await openPlushBrowser(1280,900,true);
 for(const raw of cookies){const pair=raw.split(";")[0],at=pair.indexOf("=");await browser.send("Network.setCookie",{name:pair.slice(0,at),value:pair.slice(at+1),url:origin,httpOnly:true});}
 await browser.send("Page.addScriptToEvaluateOnNewDocument",{source:`window.ptySockets=[];const WS=window.WebSocket;window.WebSocket=class extends WS{constructor(...args){super(...args);ptySockets.push(this)}};`});
 await browser.send("Page.navigate",{url:origin+"/?view=workspace&session="+encodeURIComponent(id)+(mode==="embed"?"&embed=terminal&nativeInput=1":mode==="rollback"?"&reactUi=0":"")});
 await browser.wait("!!window.__wandTerminal");await browser.settle();
 const input=async text=>{const r=await fetch(origin+"/api/sessions/"+id+"/input",{method:"POST",headers,body:JSON.stringify({input:text,view:"terminal",responseMode:"accepted",shortcutKey:text==='\r'?'enter_text':undefined})});assert.ok(r.ok,"own shell fixture input accepted: "+r.status)};
 // Only this script's new local shell receives input. ANSI redraws, never model inference.
 const command=`python3 -u -c 'import sys,time; [(sys.stdout.write("\\033[H\\033[2JFRAME %d 中文\\r\\n" % i),sys.stdout.flush(),time.sleep(.004)) for i in range(240)]; sys.stdout.write("\\033[H\\033[2J\\137WAND_PTY_STREAM_OK\\137\\r\\n"); sys.stdout.flush()'`;
 await input(command);await input("\r");
 await browser.wait(`(()=>{const t=__wandTerminal;return Array.from({length:t.rows},(_,i)=>t.buffer.active.getLine(t.buffer.active.baseY+i)?.translateToString(true)||'').some(s=>s.includes('_WAND_PTY_STREAM_OK_'))})()`);
 const before=await browser.evaluate(`(()=>{const t=__wandTerminal;return {cols:t.cols,rows:t.rows,markers:Array.from({length:t.rows},(_,i)=>t.buffer.active.getLine(t.buffer.active.baseY+i)?.translateToString(true)||'').filter(s=>s.includes('_WAND_PTY_STREAM_OK_')).length,terminals:document.querySelectorAll('.xterm').length}})()`);
 assert.equal(before.markers,1);assert.equal(before.terminals,1);report.cases.push({stage:"stream",...before});
 await browser.evaluate(`ptySockets.find(s=>s.readyState===1).send(JSON.stringify({type:'resync',sessionId:${JSON.stringify(id)}}))`);
 await browser.settle();
 await browser.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:false});
 await browser.settle();await browser.evaluate("new Promise(r=>setTimeout(r,300))");
 const narrow=await browser.evaluate(`(()=>{const t=__wandTerminal;return {cols:t.cols,rows:t.rows,markers:Array.from({length:t.rows},(_,i)=>t.buffer.active.getLine(t.buffer.active.baseY+i)?.translateToString(true)||'').filter(s=>s.includes('_WAND_PTY_STREAM_OK_')).length,terminals:document.querySelectorAll('.xterm').length,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
 assert.equal(narrow.markers,1);assert.equal(narrow.terminals,1);assert.equal(narrow.overflow,false);report.cases.push({stage:"resync+narrow",...narrow});
 await browser.screenshot(join(out,"fixture.png"));report.errors=browser.errors;assert.deepEqual(report.errors,[]);report.ok=true;
 writeFileSync(join(out,"result.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){report.error=String(error);writeFileSync(join(out,"result.json"),JSON.stringify(report,null,2));throw error;}
finally{await browser?.close();if(id){const removed=await fetch(origin+"/api/sessions/"+id,{method:"DELETE",headers});assert.ok(removed.ok,"only owned fixture session cleanup");}await fetch(origin+"/api/logout",{method:"POST",headers});}
