// Actual fixed cat meshes, matching fallback and composer sizes. No AI or employee writes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { openPlushBrowser, recordMotion } from "./run-plush-avatar-browser-harness.mjs";
const root = resolve(import.meta.dirname, "../.."), output = resolve(process.env.WAND_CAT_JAW_OUTPUT || "output/avatar-cat-jaw/after");
const before = process.env.WAND_CAT_JAW_BEFORE === "1";
mkdirSync(output,{recursive:true}); const temp=mkdtempSync(join(tmpdir(),"wand-cat-jaw-"));
await build({stdin:{resolveDir:root,loader:"tsx",contents:`
import * as React from 'react';import {createRoot} from 'react-dom/client';
import {PlushAvatar} from './src/web-ui/react/avatars/plush-avatar';
import {ComposerIdentity} from './src/web-ui/react/composer-sender/identity';
import {resolveEmployeeAvatar} from './src/plush-avatar';
import {WandUiProvider} from './src/web-ui/react/theme';
const cats=[{id:'e_wand_default',systemKey:'wand-default',name:'赛博虎妞',avatar:'plush-cat:v1:silver'},
{id:'e_wand_ops',systemKey:'wand-ops',name:'勤劳的初二',avatar:'plush-cat:v1:orange'}];
function Preview(){const [action,setAction]=React.useState('idle');React.useEffect(()=>{window.catJaw={set:setAction,cycle(){setAction('idle');setTimeout(()=>setAction('reading'),600);setTimeout(()=>setAction('writing'),4200);setTimeout(()=>setAction('idle'),7900)}}},[]);
return <WandUiProvider><main><h1>虎妞与初二 · 下颌与下巴检查</h1><p>${before ? '优化前' : '优化后'} · 真实三维头像与实际输入框尺寸</p><div className='cats'>{cats.map(cat=><section key={cat.id} data-cat={cat.id}><h2>{cat.name}</h2><div className='large'><PlushAvatar config={resolveEmployeeAvatar(cat)} size={260} interactive fileActivity={action}/></div><div className='composer'><ComposerIdentity employee={cat} fileActivity={action}/><span>继续输入你的消息…</span></div></section>)}</div><p>{action==='reading'?'翻书检查':action==='writing'?'写字检查':'待机 · 正面与侧面轮廓'}</p></main></WandUiProvider>}
createRoot(document.getElementById('root')).render(<Preview/>);`},bundle:true,format:"iife",target:"es2022",jsx:"automatic",outfile:join(temp,"app.js")});
await build({entryPoints:[join(root,"src/web-ui/react/avatars/renderer.ts")],bundle:true,format:"iife",target:"es2022",outfile:join(temp,"runtime.js")});
const server=createServer((req,res)=>{const path=new URL(req.url,"http://127.0.0.1").pathname;const file=path==="/app.js"?"app.js":path==="/assets/plush-avatar.js"?"runtime.js":null;
if(file){res.setHeader("Content-Type","text/javascript");res.end(readFileSync(join(temp,file)));return;}
res.setHeader("Content-Type","text/html;charset=utf-8");res.end(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#faf8f5;color:#29241f;font:15px -apple-system,'PingFang SC',sans-serif}main{max-width:800px;margin:24px auto;padding:0 20px;text-align:center}h1{font-size:23px}h2{font-size:17px}.cats{display:flex;gap:24px}.cats section{flex:1;min-width:0;padding:10px 20px;border:1px solid #ebe5dd;border-radius:12px;background:#fffdfa}.large{display:grid;place-items:center;height:280px}.composer{position:relative;height:100px;border-top:1px solid #ebe5dd;margin-top:10px;text-align:left}.composer-floating-avatar{position:absolute;left:0;top:12px}.composer>span:last-child{position:absolute;left:80px;top:34px;color:#6b5e54;font-size:13px}@media(max-width:600px){.cats{flex-direction:column}main{margin-top:16px}.large{height:280px}}</style><body><div id="root"></div><script>window.__wandBrowserRuntime={configPath:'',aiTeamsChunkSrc:'',plushAvatarChunkSrc:'/assets/plush-avatar.js'}</script><script src="/app.js"></script></body></html>`)});
server.listen(0,"127.0.0.1");await once(server,"listening");const origin=`http://127.0.0.1:${server.address().port}`;
const report={before,modelCalls:0,cases:[]};
const b=await openPlushBrowser(1000,680,false,"reduce");
try{
 await b.send("Page.navigate",{url:origin});await b.wait("document.querySelectorAll('[data-renderer=webgl]').length===4");
 await b.screenshot(join(output,"front.png"));
 const bounds=await b.evaluate("[...document.querySelectorAll('canvas')].map(c=>{const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let bottom=0;for(let x=0;x<c.width;x++)if(p[((c.height-1)*c.width+x)*4+3]>20)bottom++;return{size:c.width,bottom}})");
 assert.ok(bounds.every(b=>b.bottom===0),"no bottom crop at 260px or actual 72px");report.cases.push({bounds});
 const view=async side=>{await b.evaluate(`(()=>{const e=window.__wandPlushRuntime;e.camera.position.set(${side?'3.7,0.45,4':'0.12,0.14,5'});e.camera.lookAt(0,0.05,0);e.frames.clear();for(const r of e.registrations)r.dirty=true;e.schedule()})()`);await b.settle();await new Promise(r=>setTimeout(r,350));};
 await view(true);await b.screenshot(join(output,"side.png"));await view(false);
 if(!before){
  for(const action of ['reading','writing']){await b.evaluate(`catJaw.set('${action}');true`);await b.settle();await new Promise(r=>setTimeout(r,350));await b.screenshot(join(output,action+'.png'));}
  await b.evaluate("catJaw.set('idle');true");await b.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await b.evaluate("catJaw.cycle();true");report.motion=await recordMotion(b,"cat-chin-motion",9200);
  await b.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await b.settle();
  await b.send('Emulation.setDeviceMetricsOverride',{width:390,height:1300,deviceScaleFactor:1,mobile:false});await b.settle();
  assert.equal(await b.evaluate("document.documentElement.scrollWidth<=innerWidth"),true);await b.screenshot(join(output,"front-390.png"));
 }
 assert.deepEqual(b.errors,[]);report.cases.push({realWebgl:true,reduced:true,errors:0});
}finally{await b.close();}
const f=await openPlushBrowser(1000,680,true,'reduce');
try{await f.send('Page.navigate',{url:origin});await f.wait("document.querySelectorAll('[data-renderer=fallback]').length===4");await f.screenshot(join(output,'fallback.png'));assert.deepEqual(f.errors,[]);report.cases.push({fallback:true});}
finally{await f.close();await new Promise(r=>server.close(r));rmSync(temp,{recursive:true,force:true});}
report.ok=true;writeFileSync(join(output,'browser-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
