// UI acceptance for this design preview. Uses the managed local Chrome, never a model.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const origin=process.env.COMPOSER_PREVIEW_ORIGIN || "http://127.0.0.1:8292";
const output=resolve(import.meta.dirname,"../../../output/design-previews/unified-composer/evidence");
mkdirSync(output,{recursive:true});
const port=process.env.PI_COMPUTER_USE_CDP_PORT;
const tabs=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const tab=tabs.find(t=>t.type==="page"&&t.url.startsWith(origin));
if(!tab) throw Error("Open the local composer preview in the managed browser first.");
const socket=new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((done,reject)=>{socket.addEventListener("open",done,{once:true});socket.addEventListener("error",reject,{once:true})});
let serial=0;const pending=new Map();const errors=[];
socket.addEventListener("message",event=>{const result=JSON.parse(event.data);if(result.method==="Runtime.exceptionThrown") errors.push(result.params.exceptionDetails.exception?.description||result.params.exceptionDetails.text);const request=pending.get(result.id);if(!request)return;pending.delete(result.id);clearTimeout(request.timeout);result.error?request.reject(Error(JSON.stringify(result.error))):request.resolve(result.result)});
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;const timeout=setTimeout(()=>{pending.delete(id);reject(Error(`Timeout ${method}`))},15000);pending.set(id,{resolve,reject,timeout});socket.send(JSON.stringify({id,method,params}))});
const evaluate=async expression=>{const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value};
const settle=()=>evaluate("document.fonts.ready.then(()=>new Promise(resolve=>{let n=0;function step(){if(++n===6)resolve();else requestAnimationFrame(step)}requestAnimationFrame(step)}))");
const click=async selector=>{const p=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled||!el.checkVisibility())throw Error('Missing visible control: '+${JSON.stringify(selector)});el.scrollIntoView({block:'nearest',behavior:'instant'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ["mousePressed","mouseReleased"])await send("Input.dispatchMouseEvent",{type,...p,button:"left",clickCount:1});await settle()};
const key=async (key,code,modifiers=0)=>{for(const type of ["keyDown","keyUp"]) await send("Input.dispatchKeyEvent",{type,key,code:key,windowsVirtualKeyCode:code,modifiers});await settle()};
const capture=async name=>{await settle();const clip=await evaluate("(()=>{const el=document.querySelector('.preview-composer');el.scrollIntoView({block:'end',behavior:'instant'});const r=el.getBoundingClientRect();return{x:Math.max(0,r.x-12),y:Math.max(0,r.y+scrollY-12),width:Math.min(innerWidth,r.width+24),height:r.height+24,scale:2}})()");const shot=await send("Page.captureScreenshot",{format:"png",clip,captureBeyondViewport:true,fromSurface:true});writeFileSync(join(output,name),Buffer.from(shot.data,"base64"))};
const geometry=()=>evaluate("(()=>{const r=document.querySelector('.conversation-action-row').getBoundingClientRect();const send=document.querySelector('.conversation-submit').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,row:r.height,send:{x:send.x,y:send.y,width:send.width,height:send.height},pills:[...document.querySelectorAll('.composer-work-trigger')].map(e=>({y:e.getBoundingClientRect().y,h:e.getBoundingClientRect().height,text:e.innerText})),thinking:document.querySelector('.conversation-thinking-select').textContent}})()");
const cases=[];
try{
 await send("Runtime.enable");await send("Page.enable");
 await send("Emulation.setDeviceMetricsOverride",{width:1200,height:900,deviceScaleFactor:1,mobile:false});
 await send("Page.reload");await settle();
 for(const width of [1200,720,480,390,320]){
  await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});await settle();
  await evaluate("composerPreview.setAgent({...composerPreview.state.agent,model:'long-provider/long-model-name-preview-2026-10-maximum-context',thinkingEffort:'claude:medium'})");await settle();
  const g=await geometry();assert.equal(g.overflow,false,`overflow at ${width}`);assert.equal(g.row,36,`single toolbar row at ${width}`);assert.equal(g.send.width,32);assert.equal(g.send.height,32);assert.equal(g.thinking,"中");assert.equal(new Set(g.pills.map(p=>p.y)).size,1,"capsules share a row");cases.push({width,...g});await capture(`width-${width}.png`);
 }
 await send("Emulation.setDeviceMetricsOverride",{width:1200,height:900,deviceScaleFactor:1,mobile:false});await settle();
 const start=await geometry();await click('.composer-work-trigger');const opened=await geometry();assert.deepEqual(opened.send,start.send,"opening capsule never moves send");await key("Escape",27);assert.equal(await evaluate("document.querySelector('.composer-work-trigger').getAttribute('aria-expanded')"),"false");
 await click("textarea");await send("Input.insertText",{text:"第一行\n第二行"});await settle();
 const pasteResult=await evaluate(`(()=>{const textarea=document.querySelector('textarea');window.previewInputNode=textarea;const data=new DataTransfer();data.items.add(new File([new Uint8Array([1,2,3])],'paste.png',{type:'image/png'}));const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});textarea.dispatchEvent(event);return event.defaultPrevented})()`);assert.equal(pasteResult,true);await settle();assert.equal(await evaluate("composerPreview.state.files"),1);
 const textPaste=await evaluate("(()=>{const data=new DataTransfer();data.setData('text/plain','普通文字');const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});document.querySelector('textarea').dispatchEvent(event);return event.defaultPrevented})()");assert.equal(textPaste,false);
 await click('[aria-label="展开编辑"]');assert.equal(await evaluate("document.querySelector('textarea')===window.previewInputNode"),true);assert.equal(await evaluate("document.querySelector('textarea').value"),"第一行\n第二行");await click('[aria-label="收起编辑"]');
 await click('.conversation-submit');assert.equal(await evaluate("composerPreview.state.phase"),"failed");assert.equal(await evaluate("composerPreview.state.files"),1);assert.equal(await evaluate("document.querySelector('textarea').value"),"第一行\n第二行");
 await capture("attachments-failure.png");
 await evaluate("composerPreview.setPhase('idle')");await settle();
 await click('[aria-label="本页模型"]');await click('[aria-label="搜索本页模型"]');await send("Input.insertText",{text:"long-model"});await settle();assert.equal(await evaluate("document.querySelector('[aria-label=搜索本页模型]')===document.activeElement"),true);await key("Escape",27);await settle();
 await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});await settle();await capture("reduced-motion.png");
 assert.deepEqual(errors,[]);writeFileSync(join(output,"result.json"),JSON.stringify({ok:true,origin,cases,checks:["single row","thinking compact","capsule row","capsule does not move send","Escape closes portal","image paste attaches once","text paste not consumed","same editor and draft on expansion","failure retains text and file","model search focus","reduced motion"],errors},null,2));console.log(JSON.stringify({ok:true,cases:cases.length,errors}));
}finally{socket.close();}
