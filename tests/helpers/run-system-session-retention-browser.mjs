// Isolated production editor interaction: never mutates installed employee settings or invokes models.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { build } from "esbuild";
import { openPlushBrowser } from "./run-plush-avatar-browser-harness.mjs";
const root = resolve(import.meta.dirname, "../.."), out = resolve(root, process.env.WAND_RETENTION_BROWSER_OUTPUT || "output/architecture-stage2/system-retention-browser");
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "wand-system-retention-browser-"));
await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
import * as React from 'react'; import {createRoot} from 'react-dom/client';
import {EmployeeCard} from './src/web-ui/react/agents/employee-card';
import {ObjectProfilePanel} from './src/web-ui/react/shell/object-profile-panel';
import {employeeUpdateInput} from './src/web-ui/react/agents/employee-repository';
import {WandUiProvider} from './src/web-ui/react/theme';
import {PortalContainerProvider} from './src/web-ui/react/ui';
import {installReactUiStyles} from './src/web-ui/react/styles';
installReactUiStyles();
window.saves=[];
const seed=(id)=>({id,name:id==='e_wand_ops'?'初二':'石一',systemKey:id==='e_wand_ops'?'wand-ops':'wand-decision-expert',duty:'系统调用',prompt:'fixture',avatar:'',tags:['系统用户'],agents:[{provider:'codex',kind:'structured',model:'default',mode:'full-access'}],systemSessionLimit:25,createdAt:'2026-10-18T00:00:00Z',updatedAt:'2026-10-18T00:00:00Z'});
function App(){const [employee,setEmployee]=React.useState(seed('e_wand_ops'));const [details,setDetails]=React.useState(false);const trigger=React.useRef(null);window.selectEmployee=id=>setEmployee(seed(id));window.openEmployeeDetails=()=>{setEmployee(seed('e_wand_ops'));setDetails(true)};return <><button ref={trigger}>员工详情</button>{details?<ObjectProfilePanel open employee={employee} triggerRef={trigger} onClose={()=>setDetails(false)}/>:<EmployeeCard key={employee.id} employee={employee} catalog={null} providerOptions={[{value:'codex',label:'Codex'}]} onSave={async patch=>{const body=employeeUpdateInput(employee,patch);window.saves.push(body);setEmployee({...employee,...body})}}/>}</>} 
createRoot(document.getElementById('root')).render(<PortalContainerProvider container={document.getElementById('portals')}><WandUiProvider><App/></WandUiProvider></PortalContainerProvider>);
` }, bundle: true, platform: "browser", format: "iife", outfile: join(tmp,"app.js"), define: {"process.env.NODE_ENV":'"production"'} });
const server = createServer((req,res) => {
  if(req.url.startsWith('/api/')) {res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.includes('/im')?{events:[],telegram:{enabled:false},dingtalk:{enabled:false}}:{entries:[],total:0,maxEntries:200}));return;}
  const files = {'/app.js':[join(tmp,'app.js'),'text/javascript'],'/styles.css':[join(root,'src/web-ui/content/styles.css'),'text/css']};
  if(files[req.url]){res.setHeader('content-type',files[req.url][1]);res.end(readFileSync(files[req.url][0]));return;}
  if(req.url!=='/'){res.writeHead(404);res.end();return;}
  res.setHeader('content-type','text/html');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>html,body{margin:0}#root{height:100dvh;overflow:hidden}#root>[data-employee-profile]{height:100%}</style><div id="root" data-wand-ui-root></div><div id="portals" data-wand-ui-root></div><script src="/app.js"></script>');
});
server.listen(0,'127.0.0.1'); await once(server,'listening');
const browser = await openPlushBrowser(1280,1000), e=browser.evaluate;
const cases=[];
const save=async()=>{await browser.wait("!document.querySelector('.wand-employee-save-submit').disabled");await browser.click('.wand-employee-save-submit');};
const fill=async(selector,text)=>{await browser.click(selector);await e(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.focus();n.select()})()`);await browser.send('Input.insertText',{text});await browser.key('Tab');await browser.settle();};
try {
 await browser.send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
 await browser.wait("!!document.querySelector('[data-employee-profile]')");
 for(const id of ['e_wand_ops','e_wand_decision_expert']) {
  await e(`window.selectEmployee(${JSON.stringify(id)})`);await browser.wait(`!!document.querySelector('[data-employee-id="${id}"]')`);
  const selector=`#employee-${id}-system-session-limit`;
  assert.equal(await e(`document.querySelector(${JSON.stringify(selector)}).closest('details')===null`),true,'retention is not hidden in advanced management');
  assert.equal(await e(`document.querySelector(${JSON.stringify(selector)}).closest('section').getAttribute('aria-label')`),'员工设置');
  await browser.wait(`!!document.querySelector(${JSON.stringify(selector)})`);
  assert.equal(await e(`document.querySelector(${JSON.stringify(selector)}).value`),'25');
  await fill(selector,'7');await save();
  await browser.wait('window.saves.at(-1)?.systemSessionLimit===7');
  await fill(selector,'0');await save();await browser.wait('window.saves.at(-1)?.systemSessionLimit===0');
  await browser.click(selector);await e(`document.querySelector(${JSON.stringify(selector)}).select()`);await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});await browser.key('Tab');await browser.wait("!document.querySelector('.wand-employee-save-submit').disabled");
  await save();await browser.wait('window.saves.at(-1)?.systemSessionLimit===null');
  await fill(selector,'9');await e(`[...document.querySelectorAll('button')].find(n=>n.textContent==='取消').click()`);await browser.settle();
  assert.equal(await e(`document.querySelector(${JSON.stringify(selector)}).value`),'');
  for(const width of [1280,390]){await browser.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await browser.settle();assert.equal(await e('document.documentElement.scrollWidth<=innerWidth'),true);await browser.screenshot(join(out,`${id}-${width}.png`));}
  cases.push({id,loaded:25,saved:[7,0,null],cancelRetainsUnlimited:true});
 }
 await browser.send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
 await e('window.openEmployeeDetails()');
 await browser.wait("!!document.querySelector('[aria-label=\"设置系统调用历史保留上限\"]')");
 assert.ok(await e("document.querySelector('.object-profile-body').textContent.includes('员工设置')"));
 assert.ok(await e("document.querySelector('.object-profile-body').textContent.includes('保留最新 25 条已结束记录')"));
 await e("Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))");
 await browser.screenshot(join(out,'details-before.png'));
 await e("document.querySelector('[aria-label=\"设置系统调用历史保留上限\"]').scrollIntoView({block:'center',inline:'center',behavior:'instant'})");
 await browser.settle();
 await browser.click('[aria-label="设置系统调用历史保留上限"]');
 await browser.wait("!!document.querySelector('#object-profile-panel [data-employee-profile]')");
 assert.equal(await e("document.querySelector('#object-profile-panel .wand-employee-system-session-limit').closest('details')===null"),true);
 assert.equal(await e("document.querySelector('#object-profile-panel #employee-e_wand_ops-system-session-limit').value"),'25');
 cases.push({detailSettingsEntry:true,summaryVisible:true,retentionWithoutExtraExpansion:true});
 await browser.screenshot(join(out,'details-settings.png'));
 writeFileSync(join(out,'report.json'),JSON.stringify({ok:true,fixtureOnly:true,modelCalls:0,cases,payloads:await e('window.saves')},null,2));
 console.log(JSON.stringify({ok:true,cases,report:join(out,'report.json')}));
} catch(error) {writeFileSync(join(out,'failure.json'),JSON.stringify({error:String(error),state:await e("({saves:window.saves,inputs:[...document.querySelectorAll('input')].map(n=>({id:n.id,value:n.value})),saveDisabled:document.querySelector('.wand-employee-save-submit')?.disabled,feedback:document.querySelector('.feedback')?.textContent})")},null,2));await browser.screenshot(join(out,'failure.png'));throw error;} finally {await browser.close();await new Promise(resolve=>server.close(resolve));rmSync(tmp,{recursive:true,force:true});}
