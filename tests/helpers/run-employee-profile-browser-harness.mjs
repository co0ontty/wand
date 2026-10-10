// Production employee page/drawer/fields against loopback-only fixtures. Never invokes a model or installed-service mutation.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { openPlushBrowser } from "./run-plush-avatar-browser-harness.mjs";

const root = resolve(import.meta.dirname, "../.."), output = join(root,"output/employee-profile-browser");
mkdirSync(output,{recursive:true});
const temp = mkdtempSync(join(tmpdir(),"wand-employee-profile-"));
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause,ms));
const photo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZxZsAAAAASUVORK5CYII=";
const agent = model => ({kind:"structured",provider:"codex",model,thinkingEffort:"off"});
const person = (id,name,avatar="",extra={}) => ({id,name,avatar,duty:"验证职责",prompt:"验证角色",tags:["研发"],agents:[agent("m1"),agent("m2")],createdAt:"2026-10-10T00:00:00Z",updatedAt:"2026-10-10T00:00:00Z",...extra});
const seeds = [person("emp-custom","普通员工","plush:v1:heart:coral:none:none"),
  person("e_wand_default","固定银猫","plush-cat:v1:silver",{systemKey:"wand-default",tags:["默认用户"]}),
  person("e_wand_ops","固定橘猫","plush-cat:v1:orange",{systemKey:"wand-ops",tags:["系统用户"]}),
  person("emp-source","源员工",photo),person("emp-archived","归档员工","",{archivedAt:"2026-10-09T00:00:00Z"})];
let employees = structuredClone(seeds);
let createRelease = null, deferCreate = false;
const requests=[],cases=[],errors=[], result={fixtureOnly:true,productionOwners:["EmployeeListPage","EmployeeCard","EmployeeAvatarWorkspace","ObjectProfilePanel","CandidatesListEditor"],modelCalls:0,requests,cases,errors};
await build({stdin:{resolveDir:root,loader:"tsx",contents:`
  import * as React from 'react';import {createRoot} from 'react-dom/client';
  import {EmployeeListPage} from './src/web-ui/react/agents/employee-list-page';
  import {EmployeeCard} from './src/web-ui/react/agents/employee-card';
  import {siliconEmployeesRepository,invalidateEmployeeList} from './src/web-ui/react/agents/employee-repository';
  import {ObjectProfilePanel} from './src/web-ui/react/shell/object-profile-panel';
  import {WandUiProvider} from './src/web-ui/react/theme';import {setWandTheme} from './src/web-ui/react/theme-preference';
  import {PortalContainerProvider,WandDialog} from './src/web-ui/react/ui';import {overlayStore} from './src/web-ui/react/overlay-controller';
  import {normalizeIssueModelCatalog,ISSUE_AGENT_PROVIDERS} from './src/web-ui/react/issues/task-board-agent';
  import {installReactUiStyles} from './src/web-ui/react/styles';
  installReactUiStyles();const catalog=normalizeIssueModelCatalog({codexModels:[{id:'m1',label:'模型一'},{id:'m2',label:'模型二'},{id:'m3',label:'模型三'}]});
  const providers=ISSUE_AGENT_PROVIDERS.map(({value,label})=>({value,label}));
  const controls={saves:0,cancels:0,setTheme:setWandTheme};window.employeeProfileFixture=controls;
  function DialogOwner(){const entry=React.useSyncExternalStore(overlayStore.subscribe,overlayStore.getSnapshot,overlayStore.getSnapshot).activeDialog;
    return entry&&<WandDialog open key={entry.id} {...entry.options} onAction={(action,inputValue)=>overlayStore.completeDialog(entry.id,{dismissed:false,action,inputValue})} onDismiss={()=>overlayStore.completeDialog(entry.id,{dismissed:true})}/>;}
  function App(){const [mode,setMode]=React.useState('directory'),[employee,setEmployee]=React.useState(null),[sequence,setSequence]=React.useState(0),[open,setOpen]=React.useState(false),[width,setWidth]=React.useState(innerWidth);const trigger=React.useRef(null);
    React.useEffect(()=>{const resize=()=>setWidth(innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize)},[]);
    controls.mode=setMode;controls.editor=async(id)=>{setEmployee(await siliconEmployeesRepository.get(id));setSequence(n=>n+1);setMode('editor')};
    controls.drawer=async(id)=>{setEmployee(await siliconEmployeesRepository.get(id));setSequence(n=>n+1);setMode('drawer');setOpen(true)};
    controls.directory=()=>{invalidateEmployeeList();setSequence(n=>n+1);setMode('directory')};
    return <><div className='fixture-toolbar'><span>Wand 员工页 · 本地隔离验证</span><button id='profile-trigger' ref={trigger} onClick={()=>setOpen(true)}>资料入口</button></div>
      <div id='fixture-stage'>{mode==='directory'?<EmployeeListPage key={sequence} catalog={catalog} providerOptions={providers}/>:mode==='editor'&&employee?<EmployeeCard key={employee.id+sequence} employee={employee} editorOnly catalog={catalog} providerOptions={providers} onCancel={()=>{controls.cancels++}} onSave={async patch=>{controls.saves++;setEmployee(await siliconEmployeesRepository.update(employee.id,patch))}}/>:null}</div>
      <ObjectProfilePanel open={open} employee={employee} mobile={width<=760} triggerRef={trigger} onClose={()=>setOpen(false)}/><DialogOwner/></>;
  }
  const portal=document.getElementById('wand-react-ui-portals');
  createRoot(document.getElementById('root')).render(<PortalContainerProvider container={portal}><WandUiProvider><App/></WandUiProvider></PortalContainerProvider>);
`},bundle:true,format:"iife",platform:"browser",jsx:"automatic",outfile:join(temp,"app.js"),define:{"process.env.NODE_ENV":'"production"'}});
await build({entryPoints:[join(root,"src/web-ui/react/avatars/renderer.ts")],bundle:true,format:"iife",platform:"browser",minify:true,outfile:join(temp,"plush-avatar.js")});
writeFileSync(join(temp,"app.js"),readFileSync(join(temp,"app.js"),"utf8").replaceAll("${plushAvatarChunkSrc}","/plush-avatar.js"));
const server=createServer(async(request,response)=>{
  const url=new URL(request.url,"http://fixture.invalid"),path=url.pathname;
  const send=(value,status=200)=>{response.writeHead(status,{"Content-Type":"application/json"});response.end(JSON.stringify(value))};
  if(path.startsWith("/api/")){
    let raw="";for await(const chunk of request)raw+=chunk;const body=raw?JSON.parse(raw):null;requests.push({path,method:request.method,...(body?{body}:{})});
    if(/draft|structured-sessions|\/commands|optimize/.test(path)){result.modelCalls++;return send({error:"No model execution in fixtures"},403)}
    if(path==="/api/silicon-employees"){
      if(request.method==="POST"){if(deferCreate)await new Promise(resolveCreate=>{createRelease=resolveCreate});const created=person("emp-created","", "",body);employees.push(created);return send(created,201)}
      return send({employees:url.searchParams.has("includeArchived")?employees:employees.filter(e=>!e.archivedAt)});
    }
    const matched=path.match(/^\/api\/silicon-employees\/([^/]+)(?:\/(archive|unarchive))?$/);
    if(matched){const at=employees.findIndex(e=>e.id===matched[1]);if(at<0)return send({error:"missing"},404);
      if(request.method==="PUT"){employees[at]={...employees[at],...body};return send(employees[at])}
      if(request.method==="DELETE"){employees.splice(at,1);return send({ok:true})}
      if(matched[2]==="archive"){employees[at]={...employees[at],archivedAt:new Date().toISOString()};return send({ok:true})}
      if(matched[2]==="unarchive"){delete employees[at].archivedAt;return send({ok:true})}return send(employees[at]);
    }
    if(path==="/api/models")return send({codexModels:[{id:"m1",label:"模型一"},{id:"m2",label:"模型二"},{id:"m3",label:"模型三"}]});
    return send(path==="/api/session-check"?{authed:false}:{});
  }
  const files={"/app.js":[join(temp,"app.js"),"text/javascript"],"/plush-avatar.js":[join(temp,"plush-avatar.js"),"text/javascript"],"/styles.css":[join(root,"src/web-ui/content/styles.css"),"text/css"],"/tailwind.css":[join(root,"src/web-ui/content/tailwind.css"),"text/css"]};
  if(files[path]){response.writeHead(200,{"Content-Type":files[path][1]});return response.end(readFileSync(files[path][0]))}
  response.setHeader("Content-Type","text/html;charset=utf-8");response.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/tailwind.css"><style>html,body{margin:0}.fixture-toolbar{height:38px;display:flex;align-items:center;gap:16px;padding:0 16px;font-size:12px;border-bottom:1px solid var(--border)}#fixture-stage{height:calc(100dvh - 38px);overflow:hidden}#fixture-stage>[data-employee-profile]{height:100%}</style><body><div id="root" data-wand-ui-root></div><div id="wand-react-ui-portals" data-wand-ui-root></div><script src="/app.js"></script></body></html>');
});
server.listen(0,"127.0.0.1");await once(server,"listening");const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await openPlushBrowser(1440,1000),e=browser.evaluate;
// Ant motion and responsive drawers can briefly move an otherwise mounted target.
// Dispatch only when two real hit tests agree, so a click cannot silently hit its old position.
browser.click=async selector=>{
  const probe=()=>e(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)return null;n.scrollIntoView({block:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return r.width>0&&r.height>0&&(n===hit||n.contains(hit)||hit?.closest('label')?.contains(n))?{x,y}:null})()`);
  for(let attempt=0;attempt<100;attempt++){const a=await probe();await pause(60);const b=await probe();if(a&&b&&Math.abs(a.x-b.x)<1&&Math.abs(a.y-b.y)<1){for(const type of ['mousePressed','mouseReleased'])await browser.send('Input.dispatchMouseEvent',{type,...b,button:'left',clickCount:1});await browser.settle();return}}
  throw Error(`Real pointer target never became visible, enabled and stable: ${selector}`);
};
const writes=()=>requests.filter(r=>!["GET","HEAD"].includes(r.method)).length;
const clickText=async(text,scope="[data-employee-profile]")=>{
  const selector=await e(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(scope+" button")})].find(n=>n.textContent.replace(/\\s+/g,'')===${JSON.stringify(text.replace(/\s+/g,''))}&&n.getClientRects().length);if(!n)throw Error('missing button ${text}');n.dataset.employeeTest='target';return '[data-employee-test=target]'})()`);
  await browser.click(selector);await e("document.querySelector('[data-employee-test=target]')?.removeAttribute('data-employee-test')");
};
const fill=async(selector,text)=>{await browser.click(selector);await e(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.focus();n.select()})()`);await browser.send("Input.insertText",{text});await browser.settle()};
const tab=async(step,scope="[data-employee-profile]")=>{
  const selector=`${scope} .profile-tabs button[data-step="${step}"]`;
  if(step==='appearance'&&!await e(`document.querySelector(${JSON.stringify(selector)}).getClientRects().length`))return browser.click(`${scope} .identity-summary button`);
  return browser.click(selector);
};
const editor=async(id)=>{await e(`employeeProfileFixture.editor(${JSON.stringify(id)})`);await browser.wait(`!!document.querySelector('[data-employee-profile][data-employee-id="${id}"]')`)};
const directory=async()=>{await e("employeeProfileFixture.directory()");await browser.wait("!!document.querySelector('.wand-employee-workspace')");await browser.settle();if(await e("document.querySelector('.wand-employee-workspace').dataset.collapsed==='true'"))await browser.click('.directory-toggle')};
try{
  await browser.send("Page.navigate",{url:origin});await browser.wait("!!window.employeeProfileFixture");await directory();
  assert.equal(await e("document.querySelectorAll('.employee-item').length"),4);assert.equal(await e("document.querySelectorAll('[data-employee-profile]').length"),1,"single editor rather than many expanded forms");
  await browser.click('.directory input[type=checkbox]');await browser.wait("document.querySelectorAll('.employee-item').length===5");await browser.click('.directory input[type=checkbox]');
  await fill('.directory input[type=search]',"无匹配样本");await browser.wait("document.querySelector('.no-results')?.textContent.includes('没有匹配')");await browser.key("Escape");
  await browser.wait("document.querySelectorAll('.employee-item').length===4");assert.equal(await e("document.activeElement===document.querySelector('.directory input[type=search]')"),true,"search Escape clears and preserves focus");
  cases.push({name:"directory single editor, archived filter and search Escape"});
  await fill('#employee-emp-custom-name',"目录未保存草稿");
  await browser.click('.employee-item[data-directory-employee-id="emp-custom"]');
  await browser.click('.employee-item[data-directory-employee-id="emp-source"]');
  await browser.wait("[...document.querySelectorAll('[role=dialog]')].some(n=>n.textContent.includes('放弃尚未保存')&&n.getClientRects().length)");
  await clickText("继续编辑","[role=dialog]");
  assert.equal(await e("document.querySelector('#employee-emp-custom-name').value"),"目录未保存草稿");
  await clickText("取消");cases.push({name:"same-selected row preserves dirty guard before switching; continue editing retains draft"});
  await editor("emp-custom");const before=writes();
  await fill('#employee-emp-custom-name',"未保存员工");await tab("role");await fill('#employee-emp-custom-duty',"未保存职责");await fill('#employee-emp-custom-prompt',"未保存角色");
  await tab("appearance");await browser.click('.appearance input[value="diamond"]');await browser.key("ArrowRight");assert.equal(await e("document.querySelector('.appearance input[value=round]').checked"),true);await browser.key("Tab");assert.ok(await e("document.activeElement.closest('fieldset')?.classList.contains('colors')"),"Tab follows native option groups");assert.equal(writes(),before);
  await clickText("取消");await browser.wait("document.querySelector('#employee-emp-custom-name').value==='普通员工'");
  assert.equal(await e("document.querySelector('.appearance input[value=heart]').checked"),true,"Cancel restores avatar together with profile draft");assert.equal(writes(),before);
  await tab("identity");await fill('#employee-emp-custom-name',"Esc 撤销");await browser.key("Escape");await browser.wait("document.querySelector('#employee-emp-custom-name').value==='普通员工'");
  cases.push({name:"whole profile cancel/Escape restore profile and avatar without writes"});
  for(const id of ["e_wand_default","e_wand_ops"]){
    await editor(id);assert.equal(await e("document.querySelector('.appearance input[type=file]')!==null"),false);assert.equal(await e("document.querySelectorAll('.appearance input[type=radio]').length"),0);
    assert.ok(await e("document.querySelector('.fixed-avatar')?.textContent.includes('系统固定头像')"));
    for(const field of ["name","duty","prompt"])assert.equal(await e(`document.getElementById('employee-${id}-${field}').disabled`),false,`${id} profile ${field} editable`);
    await fill(`#employee-${id}-name`,`${id} 已编辑`);await tab("role");await fill(`#employee-${id}-duty`,"固定身份的新职责");await fill(`#employee-${id}-prompt`,"固定身份的新角色");
    await tab("tools");await browser.click('[aria-label="把备用 2上移"]');await browser.click('.wand-employee-save-submit');
    await browser.wait("document.querySelector('[data-employee-profile]').textContent.includes('员工资料已保存')");
    const write=requests.filter(r=>r.method==="PUT").at(-1);assert.equal(write.path,`/api/silicon-employees/${id}`);assert.equal("avatar" in write.body,false,"fixed avatar never echoed");assert.equal("tags" in write.body,false);
    assert.equal(write.body.prompt,"固定身份的新角色");assert.deepEqual(write.body.agents.map(a=>a.model),["m2","m1"]);
    assert.equal(employees.find(item=>item.id===id).avatar,id==="e_wand_default"?"plush-cat:v1:silver":"plush-cat:v1:orange");
  }
  cases.push({name:"both fixed cats forbid avatar editing but save changed profile and ordered candidates only"});
  await editor("emp-source");const sourceBefore=writes();assert.equal(await e("document.querySelector('.appearance img.photo').getAttribute('src')"),photo);assert.equal(await e("document.querySelectorAll('.appearance input[type=radio]').length"),0);
  await fill('#employee-emp-source-name',"源员工已编辑");await browser.click('.wand-employee-save-submit');await browser.wait("document.querySelector('[data-employee-profile]').textContent.includes('员工资料已保存')");assert.equal(employees.find(item=>item.id==="emp-source").avatar,photo);
  await clickText("改用毛绒头像",".appearance");await browser.wait("!!document.querySelector('.appearance input[value=heart]')");await browser.click('.appearance input[value=blue]');assert.equal(writes(),sourceBefore+1);
  await clickText("取消");assert.equal(await e("document.querySelector('.appearance img.photo').getAttribute('src')"),photo);
  cases.push({name:"source uploaded image persists through unrelated save; explicit conversion cancelled without overwriting source"});
  await editor("emp-custom");await tab("tools");const validationBefore=writes();await clickText("添加候选");await browser.wait("document.querySelectorAll('.wand-team-candidate').length===3");await browser.click('.wand-employee-save-submit');
  await browser.wait("document.querySelector('[role=alert]')?.textContent.includes('与更靠前')");assert.equal(writes(),validationBefore,"invalid duplicate candidates blocked before request");await browser.click('[aria-label="删除备用 3"]');await browser.wait("document.querySelectorAll('.wand-team-candidate').length===2");
  await browser.click('[aria-label="把备用 2上移"]');await browser.wait("document.querySelector('.wand-team-candidate [aria-label$=模型]').textContent.includes('模型二')");await browser.wait("!document.querySelector('.wand-employee-save-submit').disabled");await browser.click('.wand-employee-save-submit');await browser.wait("document.querySelector('[data-employee-profile]').textContent.includes('员工资料已保存')");
  assert.deepEqual(employees.find(item=>item.id==="emp-custom").agents.map(a=>a.model),["m2","m1"]);
  cases.push({name:"candidate duplicate validation, deletion and fallback order save"});
  await e("employeeProfileFixture.drawer('emp-custom')");await browser.wait("!!document.querySelector('#object-profile-panel.open')");await pause(400);await clickText("编辑员工配置","#object-profile-panel");await browser.wait("!!document.querySelector('#object-profile-panel [data-employee-profile]')");
  await tab("tools","#object-profile-panel");const model='#object-profile-panel .wand-team-candidate [aria-label$="模型"]';await browser.click(model);await browser.wait("!!document.querySelector('.wand-ui-select-content input')");await browser.click('.wand-ui-select-content input');await browser.send("Input.insertText",{text:"模型"});
  assert.ok(await e("!!document.querySelector('#object-profile-panel [data-employee-profile]')"),"owned Portal search does not close drawer editor");await browser.key("Escape");await browser.wait("!document.querySelector('.wand-ui-select-content')");assert.ok(await e("!!document.querySelector('#object-profile-panel [data-employee-profile]')"),"first Escape closes owned select only");
  assert.equal(await e(`document.activeElement===document.querySelector(${JSON.stringify(model)})`),true,"Portal Escape restores model trigger");await clickText("取消","#object-profile-panel");await browser.wait("!document.querySelector('#object-profile-panel [data-employee-profile]')");await browser.key("Escape");await browser.wait("!document.querySelector('#object-profile-panel.open')");
  cases.push({name:"real ObjectProfilePanel owned Portal search, Escape and focus restore"});
  await editor("emp-custom");
  for(const theme of ["warm","blue","forest","mauve","graphite"]){await e(`employeeProfileFixture.setTheme('${theme}')`);
    for(const width of [1440,390,320]){await browser.send("Emulation.setDeviceMetricsOverride",{width,height:1000,deviceScaleFactor:1,mobile:false});await browser.settle();assert.equal(await e("document.documentElement.scrollWidth<=innerWidth"),true,`${theme}/${width} contains layout`);await browser.screenshot(join(output,`profile-${theme}-${width}.png`));cases.push({name:"theme/responsive",theme,width})}}
  await browser.send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});await browser.wait("document.querySelector('.preview-state')?.textContent.includes('已减少动效')");assert.equal(await e("[...document.querySelectorAll('.appearance button')].find(n=>n.textContent.includes('预览说话动作')).disabled"),true);
  await browser.screenshot(join(output,"profile-reduced-motion.png"));cases.push({name:"reduced motion shows honest static state and disables speech preview"});
  const fallback=await openPlushBrowser(390,1000,true);try{await fallback.send("Page.navigate",{url:origin});await fallback.wait("!!window.employeeProfileFixture");await fallback.evaluate("employeeProfileFixture.editor('emp-custom')");await fallback.wait("!!document.querySelector('[data-employee-profile]')");await fallback.click('.profile-tabs button[data-step=appearance]');await fallback.wait("document.querySelector('.appearance .preview-state')?.textContent.includes('3D 不可用')");assert.equal(await fallback.evaluate("[...document.querySelectorAll('.appearance button')].find(n=>n.textContent.includes('预览说话动作')).disabled"),true);await fallback.screenshot(join(output,"profile-webgl-fallback.png"));}finally{await fallback.close()}
  cases.push({name:"WebGL fallback truthful static label and disabled animation preview"});
  await browser.send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"no-preference"}]});await directory();
  await browser.click('.employee-item[data-directory-employee-id="emp-custom"]');await tab("advanced");await clickText("归档员工");await browser.wait("!document.querySelector('.employee-item[data-directory-employee-id=emp-custom]')");
  await browser.click('.directory-toggle');await browser.click('.directory input[type=checkbox]');await browser.wait("!!document.querySelector('.employee-item[data-directory-employee-id=emp-custom]')");await browser.click('.employee-item[data-directory-employee-id="emp-custom"]');await tab("advanced");await clickText("恢复员工");await browser.wait("[...document.querySelectorAll('[data-employee-profile] button')].some(n=>n.textContent.trim()==='归档员工')");assert.equal(employees.find(item=>item.id==="emp-custom").archivedAt,undefined);
  cases.push({name:"actual directory archive and restore fixture roundtrip"});
  await browser.click('.directory-toggle');await clickText("新建员工",".directory");await browser.wait("!!document.querySelector('#new-employee-expectation')");
  await fill('#new-employee-expectation',"不能丢失的新建草稿");await browser.click('.directory-toggle');await browser.click('.employee-item[data-directory-employee-id="emp-custom"]');
  await browser.wait("[...document.querySelectorAll('[role=dialog]')].some(n=>n.textContent.includes('放弃尚未保存')&&n.getClientRects().length)");await clickText("继续编辑","[role=dialog]");
  assert.equal(await e("document.querySelector('#new-employee-expectation').value"),"不能丢失的新建草稿");
  await browser.click('.directory header button');await browser.click('.ant-collapse-header');await fill('#new-employee-name',"手动创建验证员工");await fill('#new-employee-duty',"真实手动配置");
  deferCreate=true;await browser.click('.wand-employee-create-submit');await browser.wait("document.querySelector('.wand-employee-create-submit').getAttribute('aria-busy')==='true'");
  await browser.click('.directory-toggle');await browser.click('.employee-item[data-directory-employee-id="emp-custom"]');
  assert.ok(await e("!!document.querySelector('#new-employee-name')"),"pending manual create prevents scope switch");
  createRelease();await browser.wait("!!document.querySelector('[data-employee-id=emp-created]')");assert.equal(employees.find(item=>item.id==='emp-created').name,"手动创建验证员工");
  await browser.click('.directory header button');await tab("advanced");await clickText("删除员工");await browser.wait("[...document.querySelectorAll('[role=dialog]')].some(n=>n.textContent.includes('删除员工')&&n.getClientRects().length)");await clickText("取消","[role=dialog]");assert.ok(employees.some(item=>item.id==='emp-created'));
  await clickText("删除员工");await browser.wait("[...document.querySelectorAll('[role=dialog]')].some(n=>n.textContent.includes('删除员工')&&n.getClientRects().length)");await clickText("删除员工","[role=dialog]");await browser.wait("!document.querySelector('[data-employee-id=emp-created]')");assert.equal(employees.some(item=>item.id==='emp-created'),false);
  cases.push({name:"manual create dirty guard, delayed create blocks switching, confirmation cancel and explicit delete fixture roundtrip"});
  assert.equal(result.modelCalls,0);assert.deepEqual(browser.errors,[]);result.ok=true;writeFileSync(join(output,"browser-result.json"),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:true,cases:cases.length,modelCalls:0,output}));
}catch(error){result.ok=false;result.error=error.message;result.errors=browser.errors;await browser.screenshot(join(output,"failure.png")).catch(()=>{});writeFileSync(join(output,"browser-result.json"),JSON.stringify(result,null,2));throw error}
finally{await browser.close();await new Promise(resolveClose=>server.close(resolveClose));rmSync(temp,{recursive:true,force:true})}
