// Production employee page/drawer/fields against loopback-only fixtures. Never invokes a model or installed-service mutation.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { openPlushBrowser } from "./run-plush-avatar-browser-harness.mjs";
import { runEmployeeLayoutCases } from "./employee-layout-cases.mjs";

const layoutQa = process.env.WAND_EMPLOYEE_LAYOUT_QA === "1";
const hrQa = process.env.WAND_HR_RECRUITMENT_QA === "1";
const root = resolve(import.meta.dirname, "../.."), output = resolve(root,process.env.WAND_EMPLOYEE_PROFILE_OUTPUT??(layoutQa?"output/architecture-stage2/employee-wide-layout/fixture":"output/employee-profile-browser"));
const confirmOnly = process.env.WAND_EMPLOYEE_CONFIRM_ONLY === "1";
const guardOnly = process.env.WAND_EMPLOYEE_GUARD_ONLY === "1";
mkdirSync(output,{recursive:true});
const temp = mkdtempSync(join(tmpdir(),"wand-employee-profile-"));
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause,ms));
const photo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZxZsAAAAASUVORK5CYII=";
const agent = model => ({kind:"structured",provider:"codex",model,thinkingEffort:"off"});
const person = (id,name,avatar="",extra={}) => ({id,name,avatar,duty:"验证职责",prompt:"验证角色",tags:["研发"],agents:[agent("m1"),agent("m2")],createdAt:"2026-10-10T00:00:00Z",updatedAt:"2026-10-10T00:00:00Z",...extra});
const seeds = [person("emp-custom","普通员工","plush:v1:heart:coral:none:none"),
  person("e_wand_default","固定银猫","plush-cat:v1:silver",{systemKey:"wand-default",tags:["默认用户"]}),
  person("e_wand_ops","固定橘猫","plush-cat:v1:orange",{systemKey:"wand-ops",tags:["系统用户"]}),
  person("e_wand_decision_expert","石一","",{systemKey:"wand-decision-expert",tags:["系统用户"]}),
  person("e_wand_speech_polisher","口述整理师","",{systemKey:"wand-speech-polisher",tags:["系统用户"]}),
  person("e_wand_hr","嘟嘟","plush-dog:v1:shiba:red-scarf",{systemKey:"wand-hr",tags:["系统用户"]}),
  person("emp-source","源员工",photo),person("emp-archived","归档员工","",{archivedAt:"2026-10-09T00:00:00Z"})];
let employees = structuredClone(seeds);
let createRelease = null, deferCreate = false, draftRelease = null;
let failRecruitCreate = true;
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
  import {installReactUiStyles,installStyleSheet} from './src/web-ui/react/styles';
  import {aiTeamsChunkStyles} from './src/web-ui/react/ai-teams/styles';
  installReactUiStyles();installStyleSheet('employee-fixture-teams',aiTeamsChunkStyles);const catalog=normalizeIssueModelCatalog({codexModels:[{id:'m1',label:'模型一'},{id:'m2',label:'模型二'},{id:'m3',label:'模型三'}]});
  const providers=ISSUE_AGENT_PROVIDERS.map(({value,label})=>({value,label}));
  const controls={saves:0,cancels:0,draftResponses:0,dialogActions:[],setTheme:setWandTheme,dialogState:()=>overlayStore.getSnapshot().activeDialog?.id??null};window.employeeProfileFixture=controls;
  const requestDraft=siliconEmployeesRepository.draft.bind(siliconEmployeesRepository);
  siliconEmployeesRepository.draft=async value=>{const draft=await requestDraft(value);controls.draftResponses++;return draft;};
  function DialogOwner(){const entry=React.useSyncExternalStore(overlayStore.subscribe,overlayStore.getSnapshot,overlayStore.getSnapshot).activeDialog;
    return entry&&<WandDialog open key={entry.id} {...entry.options} onAction={(action,inputValue)=>{controls.dialogActions.push({id:entry.id,action});overlayStore.completeDialog(entry.id,{dismissed:false,action,inputValue})}} onDismiss={()=>overlayStore.completeDialog(entry.id,{dismissed:true})}/>;}
  function App(){const [mode,setMode]=React.useState('directory'),[employee,setEmployee]=React.useState(null),[sequence,setSequence]=React.useState(0),[open,setOpen]=React.useState(false),[width,setWidth]=React.useState(innerWidth);const trigger=React.useRef(null);
    React.useEffect(()=>{const resize=()=>setWidth(innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize)},[]);
    controls.mode=setMode;controls.editor=async(id)=>{setEmployee(await siliconEmployeesRepository.get(id));setSequence(n=>n+1);setMode('editor')};
    controls.drawer=async(id)=>{setEmployee(await siliconEmployeesRepository.get(id));setSequence(n=>n+1);setMode('drawer');setOpen(true)};
    controls.directory=()=>{invalidateEmployeeList();setSequence(n=>n+1);setMode('directory')};
    return <><div className='fixture-toolbar'><span>Wand 员工页 · 本地隔离验证</span><button id='profile-trigger' ref={trigger} onClick={()=>setOpen(true)}>资料入口</button></div>
      <div id='fixture-stage'>{mode==='directory'?<div className='wand-teams-page fixture-employee-page'><div className='wand-teams-layout wand-employees-layout'><EmployeeListPage key={sequence} catalog={catalog} providerOptions={providers}/></div></div>:mode==='editor'&&employee?<EmployeeCard key={employee.id+sequence} employee={employee} editorOnly catalog={catalog} providerOptions={providers} onCancel={()=>{controls.cancels++}} onSave={async patch=>{controls.saves++;setEmployee(await siliconEmployeesRepository.update(employee.id,patch))}}/>:null}</div>
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
    if(hrQa&&path==='/api/silicon-employees/draft'){
      result.mockDrafts=(result.mockDrafts||0)+1;
      if(body.expectation==='模拟拟定失败')return send({error:'拟定失败，请重试'},503);
      if(body.expectation==='模拟取消')await new Promise(resolveDraft=>{draftRelease=resolveDraft});
      return send({draft:{name:'招聘验证人选',duty:'验证职责',prompt:'验证角色',agent:agent('m1'),candidates:[agent('m1'),agent('m2')]}});
    }
    if(layoutQa&&path==='/api/silicon-employees/draft'){
      result.mockDrafts=(result.mockDrafts||0)+1;
      await new Promise(resolveDraft=>{draftRelease=resolveDraft});
      return send({draft:{name:'迟到的隔离生成',duty:'虚拟职责',prompt:'虚拟角色',agent:agent('m1')}});
    }
    if(/draft|structured-sessions|\/commands|optimize/.test(path)){result.modelCalls++;return send({error:"No model execution in fixtures"},403)}
    if(path==="/api/silicon-employees"){
      if(request.method==="POST"){if(hrQa&&failRecruitCreate){failRecruitCreate=false;return send({error:"入职失败，请重试"},503)}if(deferCreate)await new Promise(resolveCreate=>{createRelease=resolveCreate});const created=person("emp-created","", "",body);employees.push(created);return send(created,201)}
      return send({employees:url.searchParams.has("includeArchived")?employees:employees.filter(e=>!e.archivedAt)});
    }
    const knowledge=path.match(/^\/api\/silicon-employees\/([^/]+)\/knowledge$/);
    if(knowledge&&request.method==="GET")return send({employeeId:knowledge[1],entries:[],total:0,maxEntries:200});
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
  response.setHeader("Content-Type","text/html;charset=utf-8");response.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/tailwind.css"><style>html,body{margin:0}.fixture-toolbar{height:38px;display:flex;align-items:center;gap:16px;padding:0 16px;font-size:12px;border-bottom:1px solid var(--border)}#fixture-stage{height:calc(100dvh - 38px);overflow:hidden}#fixture-stage>[data-employee-profile]{height:100%}.fixture-employee-page{height:100%;display:flex;flex-direction:column;min-width:0;min-height:0}</style><body><div id="root" data-wand-ui-root></div><div id="wand-react-ui-portals" data-wand-ui-root></div><script src="/app.js"></script></body></html>');
});
server.listen(0,"127.0.0.1");await once(server,"listening");const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await openPlushBrowser(1440,1000),e=browser.evaluate;
// Library closing surfaces keep layout boxes briefly. Re-resolve painted candidates on every
// probe; a pinned first text match can disappear or remain covered after a dialog reopens.
const clickTarget=async(target)=>{
  const probe=()=>e(`(()=>{const target=${JSON.stringify(target)};
    window.__employeePointerProbes=(window.__employeePointerProbes??0)+1;
    const identities=window.__employeePointerIdentities??=new WeakMap();
    candidates: for(const n of document.querySelectorAll(target.selector)){
      if(target.text!==undefined&&n.innerText.replace(/\\s+/g,'')!==target.text)continue;
      if(n.disabled||n.closest('[inert],[aria-hidden="true"]')||n.checkVisibility?.({visibilityProperty:true})===false)continue;
      // Two identical samples can occur while a compositor/main-thread entrance is
      // stalled. Wait for finite native geometry effects, not a guessed delay or
      // a second click after a miss; unrelated/infinite color/spin effects do not block.
      for(let ancestor=n;ancestor;ancestor=ancestor.parentElement){
        const moving=ancestor.getAnimations().some(animation=>
          ['running','paused'].includes(animation.playState)&&Number.isFinite(animation.effect?.getComputedTiming().endTime)
          &&animation.effect.getKeyframes().some(frame=>['transform','translate','scale','rotate','width','height','top','left','right','bottom','inset','margin','padding'].some(property=>property in frame)));
        if(moving)continue candidates;
      }
      n.scrollIntoView({block:'nearest',behavior:'instant'});
      const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
      if(r.width<=0||r.height<=0||!(n===hit||n.contains(hit)||hit?.closest('label')?.contains(n)))continue;
      if(!identities.has(n))identities.set(n,window.__employeePointerSequence=(window.__employeePointerSequence??0)+1);
      return{x,y,identity:identities.get(n),animations:n.getAnimations().concat(...[...function*(node){while(node){yield node;node=node.parentElement}}(n.parentElement)].map(node=>node.getAnimations())).map(animation=>({state:animation.playState,time:animation.currentTime,delay:animation.effect?.getTiming().delay,properties:Object.keys(animation.effect?.getKeyframes()[0]??{}),target:animation.effect?.target?.className}))};
    }return null})()`);
  for(let attempt=0;attempt<100;attempt++){
    const a=await probe();await pause(60);const b=await probe();
    if(a&&b&&a.identity===b.identity&&Math.abs(a.x-b.x)<1&&Math.abs(a.y-b.y)<1){
      await e(`(window.__employeeClickPlans??=[]).push(${JSON.stringify({target,...b})});window.__employeeClickPlans=window.__employeeClickPlans.slice(-30);true`);
      for(const type of ['mousePressed','mouseReleased'])await browser.send('Input.dispatchMouseEvent',{type,x:b.x,y:b.y,button:'left',clickCount:1});
      await browser.settle();return;
    }
  }
  const targets=await e(`([...document.querySelectorAll(${JSON.stringify(target.selector)})].filter(n=>${JSON.stringify(target.text)}===undefined||n.innerText.replace(/\\s+/g,'')===${JSON.stringify(target.text)}).slice(0,10).map(n=>{const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {text:n.textContent,connected:n.isConnected,disabled:n.disabled,visible:n.checkVisibility?.({visibilityProperty:true}),scope:n.closest('[role=dialog]')?'dialog':'page',rect:{x:r.x,y:r.y,width:r.width,height:r.height},hit:hit?{tag:hit.tagName,text:hit.textContent.slice(0,80)}:null}}))`);
  throw Error(`Real pointer target never became visible, enabled and stable: ${JSON.stringify(target)}; evidence=${JSON.stringify(targets)}`);
};
browser.click=selector=>clickTarget({selector});
const writes=()=>requests.filter(r=>!["GET","HEAD"].includes(r.method)).length;
const clickText=(text,scope="[data-employee-profile]")=>clickTarget({selector:scope+' button',text:text.replace(/\s+/g,'')});
const fill=async(selector,text)=>{await browser.click(selector);await e(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.focus();n.select()})()`);await browser.send("Input.insertText",{text});await browser.settle()};
const section=async(step,scope="[data-employee-profile]")=>{
  if(step==='appearance'){
    if(!await e(`!!document.querySelector('${scope} .appearance')`))await browser.click(`${scope} .identity-summary button`);
    return;
  }
  if(step==='advanced'&&!await e(`document.querySelector('${scope} .advanced-details').open`))await browser.click(`${scope} .advanced-details>summary`);
  await e(`document.querySelector('${scope} #${step}').scrollIntoView({block:'start',behavior:'instant'})`);
};
const editor=async(id)=>{await e(`employeeProfileFixture.editor(${JSON.stringify(id)})`);await browser.wait(`!!document.querySelector('[data-employee-profile][data-employee-id="${id}"]')`)};
const directory=async()=>{await e("employeeProfileFixture.directory()");await browser.wait("!!document.querySelector('.wand-employee-workspace')");await browser.settle()};
try{
  await browser.send("Page.navigate",{url:origin});await browser.wait("!!window.employeeProfileFixture");await directory();
  if(guardOnly)await e(`const style=document.createElement("style");style.textContent=".ant-zoom-appear,.ant-zoom-enter{animation-duration:2s!important}";document.head.append(style);true`);
  await e(`window.__guardPointer=[];for(const type of ['mousedown','mouseup','click'])document.addEventListener(type,event=>{const n=event.target;window.__guardPointer.push({type,tag:n.tagName,text:n.textContent.slice(0,50),x:event.clientX,y:event.clientY,dialog:employeeProfileFixture.dialogState()});window.__guardPointer=window.__guardPointer.slice(-60)},true);true`);
  if(hrQa){
    await editor('e_wand_hr');
    for(const field of ['name','duty','prompt','tags'])assert.equal(await e(`document.getElementById("employee-e_wand_hr-${field}").disabled`),true);
    assert.equal(await e("document.querySelector('[data-plush-avatar]').dataset.avatarConfig.includes('dog')"),true);
    await directory();await clickText('招聘员工','.employee-directory');await browser.wait("!!document.querySelector('#new-employee-expectation')");
    await browser.wait("!!document.querySelector('.wand-recruiter-summary [data-renderer=webgl]')");
    for(const width of [1280,390]){
      await browser.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await browser.settle();
      assert.equal(await e("document.documentElement.scrollWidth>innerWidth"),false);
      await browser.screenshot(join(output,'recruitment-'+width+'.png'));
    }
    await fill('#new-employee-expectation','模拟拟定失败');
    await browser.click('.wand-employee-create-submit');await browser.wait("document.querySelector('[role=alert]')?.textContent.includes('拟定失败')");
    assert.equal(await e("document.querySelector('#new-employee-expectation').value"),'模拟拟定失败');
    await fill('#new-employee-expectation','招聘一位测试工程师');
    const actionGeometry = await e("document.querySelector('.wand-employee-create-submit').getBoundingClientRect().toJSON()");
    await browser.click('.wand-employee-create-submit');await browser.wait("document.querySelector('#new-employee-name')?.value==='招聘验证人选'");
    const reviewedGeometry = await e("document.querySelector('.wand-employee-create-submit').getBoundingClientRect().toJSON()");
    for(const key of ['x','y','width','height'])assert.ok(Math.abs(actionGeometry[key]-reviewedGeometry[key])<1,'recruitment action stays in place: '+key);
    assert.equal(requests.filter(r=>r.path==='/api/silicon-employees'&&r.method==='POST').length,0,'draft is not onboarding');
    assert.equal(await e("document.querySelectorAll('.is-new .wand-team-candidate').length"),2,'all HR candidates survive');
    assert.equal(await e("document.querySelector('.wand-employee-create-submit').textContent.includes('确认入职')"),true);
    await fill('#new-employee-name','确认后的招聘人选');await browser.click('.wand-employee-create-submit');
    await browser.wait("document.querySelector('[role=alert]')?.textContent.includes('入职失败')");
    assert.equal(await e("document.querySelector('#new-employee-name').value"),'确认后的招聘人选');
    assert.equal(await e("document.querySelectorAll('.is-new .wand-team-candidate').length"),2);
    await browser.click('.wand-employee-create-submit');await browser.wait("!!document.querySelector('[data-employee-profile]')");
    assert.equal(employees.at(-1).name,'确认后的招聘人选');assert.deepEqual(employees.at(-1).agents.map(a=>a.model),['m1','m2']);
    await directory();await clickText('招聘员工','.employee-directory');await fill('#new-employee-expectation','模拟取消');
    await browser.click('.wand-employee-create-submit');await browser.wait("document.querySelector('.wand-employee-create-submit').disabled");
    await clickText('取消','.is-new');await browser.wait("!!document.querySelector('.employee-directory')");
    await clickText('招聘员工','.employee-directory');await fill('#new-employee-expectation','新的招聘需求');
    assert.ok(draftRelease);draftRelease();await browser.wait("employeeProfileFixture.draftResponses===2");
    assert.equal(await e("document.querySelector('#new-employee-expectation').value"),'新的招聘需求');
    assert.equal(await e("document.querySelector('#new-employee-name').value"),'');
    assert.equal(requests.filter(r=>r.path==='/api/silicon-employees'&&r.method==='POST').length,2,'cancelled generation never creates');
    cases.push({name:'HR lock, real Shiba WebGL, wide/mobile, draft review, explicit onboarding, failure recovery and late cancellation isolation'});
  }else if(layoutQa){
    await runEmployeeLayoutCases({browser,output,origin,cases,fill,clickText,directory,editor,writes,releaseDraft:()=>{assert.ok(draftRelease,'mock draft is pending');draftRelease();}});
  }else if(guardOnly){
    await browser.send('Emulation.setCPUThrottlingRate',{rate:4});
    await browser.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    for(const width of [1440,320]){
      await browser.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
      await directory();await browser.click('.employee-item[data-directory-employee-id="emp-custom"]');await fill('#employee-emp-custom-name','保留确认草稿');
      for(let iteration=0;iteration<8;iteration++){
        await browser.click('[aria-label="返回员工列表"]');
        await browser.wait("employeeProfileFixture.dialogState()!==null");
        const id=await e("employeeProfileFixture.dialogState()");
        if(iteration===0){
          const count=await e(`(()=>{
            const dialog=document.querySelector('[role=dialog]'),animations=[];
            for(let n=dialog;n;n=n.parentElement)for(const a of n.getAnimations()){
              if(a.playState==='running'&&a.effect.getKeyframes().some(f=>'transform' in f)){a.pause();animations.push(a)}
            }
            window.__heldEmployeeEntrance=animations;return animations.length;
          })()`);
          assert.ok(count>0,'exercise the real library entrance transform, not a mock dialog');
          const start=await e("window.__employeePointerProbes");
          const action=clickText('继续编辑','[role=dialog]');
          try{
            await browser.wait(`window.__employeePointerProbes>=${start+3}`,'the locator waits rather than clicking a stalled entrance');
            assert.equal(await e("employeeProfileFixture.dialogState()"),id,'stalled entrance must retain the live dialog and draft');
          }finally{await e("window.__heldEmployeeEntrance.forEach(a=>a.finish());true");await action;}
        }else await clickText('继续编辑','[role=dialog]');
        await browser.wait("employeeProfileFixture.dialogState()===null",'continue editing must complete the actual overlay request');
        assert.equal(await e("document.querySelector('#employee-emp-custom-name').value"),'保留确认草稿');
        assert.deepEqual(await e("employeeProfileFixture.dialogActions.at(-1)"),{id,action:false});
      }
    }
    assert.equal(writes(),0);
    assert.equal(await e("window.__employeeClickPlans.filter(plan=>plan.animations.some(a=>a.properties.includes('transform')&&['running','paused'].includes(a.state))).length"),0,'no pointer is sent during unresolved entrance geometry');
    cases.push({name:'dirty-leave confirmation accepts sixteen real pointer cancellations, CPU4x wide/mobile',events:await e('window.__guardPointer')});
  }else if(confirmOnly){
    await browser.send('Emulation.setDeviceMetricsOverride',{width:320,height:1000,deviceScaleFactor:1,mobile:false});
    await browser.send('Emulation.setCPUThrottlingRate',{rate:4});
    await browser.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await browser.click('.employee-item[data-directory-employee-id="emp-custom"]');await section('advanced');
    // A library closing surface may retain layout boxes without being painted or interactive.
    // The test locator must not pin itself to such a same-label node.
    await e(`(()=>{const retained=document.createElement('aside');retained.style.cssText='visibility:hidden;position:absolute;top:0';retained.innerHTML='<section data-employee-profile><button>删除员工</button></section><div role="dialog"><button>取消</button><button>删除员工</button></div>';document.body.prepend(retained)})()`);
    const mutations=writes();
    for(let iteration=0;iteration<8;iteration++){
      await clickText('删除员工');await browser.wait("[...document.querySelectorAll('[role=dialog]')].some(n=>n.textContent.includes('删除员工')&&n.getClientRects().length)");
      await clickText('取消','[role=dialog]');
      await browser.wait("employeeProfileFixture.dialogState()===null",'cancel completes the current overlay request');
      assert.equal(writes(),mutations,'cancel never deletes or writes');
      await clickText('删除员工');await browser.wait("employeeProfileFixture.dialogState()!==null",'a new confirmation request is actually open');
      await clickText('取消','[role=dialog]');
      await browser.wait("employeeProfileFixture.dialogState()===null",'reopened confirmation actually closes');
      assert.equal(writes(),mutations,'reopening and cancelling never writes');
    }
    await clickText('删除员工');await browser.wait("[...document.querySelectorAll('[role=dialog]')].some(n=>n.textContent.includes('删除员工')&&n.getClientRects().length)");
    await clickText('删除员工','[role=dialog]');await browser.wait("!document.querySelector('[data-employee-id=emp-custom]')");
    assert.equal(employees.some(item=>item.id==='emp-custom'),false);assert.equal(writes(),mutations+1,'explicit confirmation deletes exactly once');
    cases.push({name:'rapid cancel/reopen/confirm with real pointer',width:320,cpuRate:4,cancellations:16,deletes:1});
  }else{
  assert.equal(await e("document.querySelectorAll('.employee-item').length"),seeds.filter(employee=>!employee.archivedAt).length);assert.equal(await e("document.querySelectorAll('[data-employee-profile]').length"),0,"directory opens without an automatic split editor");
  await browser.click('.employee-directory input[type=checkbox]');await browser.wait(`document.querySelectorAll('.employee-item').length===${seeds.length}`);await browser.click('.employee-directory input[type=checkbox]');
  await fill('.employee-directory input[type=search]',"无匹配样本");await browser.wait("document.querySelector('.no-results')?.textContent.includes('没有匹配')");await browser.key("Escape");
  await browser.wait(`document.querySelectorAll('.employee-item').length===${seeds.filter(employee=>!employee.archivedAt).length}`);assert.equal(await e("document.activeElement===document.querySelector('.employee-directory input[type=search]')"),true,"search Escape clears and preserves focus");
  cases.push({name:"directory index, archived filter and search Escape"});
  await browser.click('.employee-item[data-directory-employee-id="emp-custom"]');
  assert.equal(await e("document.querySelectorAll('[data-employee-profile] [role=tab],.employee-directory').length"),0,"editor has no tabs or side directory");
  assert.equal(await e("['identity','role','tools'].every(id=>document.querySelector('#'+id).getClientRects().length>0)"),true,"ordinary fields appear in one continuous form");
  await fill('#employee-emp-custom-name',"目录未保存草稿");
  await browser.click('[aria-label="返回员工列表"]');
  await browser.wait("[...document.querySelectorAll('[role=dialog]')].some(n=>n.textContent.includes('放弃尚未保存')&&n.getClientRects().length)");
  await clickText("继续编辑","[role=dialog]");
  assert.equal(await e("document.querySelector('#employee-emp-custom-name').value"),"目录未保存草稿");
  await browser.wait("![...document.querySelectorAll('[role=dialog]')].some(n=>n.getClientRects().length)");
  await clickText("取消");await browser.click('[aria-label="返回员工列表"]');
  await browser.wait("!!document.querySelector('.employee-directory')");
  assert.equal(await e("document.activeElement?.dataset.directoryEmployeeId"),"emp-custom","returning restores focus to the employee row");
  cases.push({name:"back guard retains draft; explicit cancel returns safely to original index"});
  await editor("emp-custom");const before=writes();
  await fill('#employee-emp-custom-name',"未保存员工");await section("role");await fill('#employee-emp-custom-duty',"未保存职责");await fill('#employee-emp-custom-prompt',"未保存角色");
  await section("appearance");await browser.click('.appearance input[value="diamond"]');await browser.key("ArrowRight");assert.equal(await e("document.querySelector('.appearance input[value=round]').checked"),true);await browser.key("Tab");assert.ok(await e("document.activeElement.closest('fieldset')?.classList.contains('colors')"),"Tab follows native option groups");assert.equal(writes(),before);
  await clickText("取消");await browser.wait("document.querySelector('#employee-emp-custom-name').value==='普通员工'");
  assert.equal(await e("document.querySelector('.appearance input[value=heart]').checked"),true,"Cancel restores avatar together with profile draft");assert.equal(writes(),before);
  await section("identity");await fill('#employee-emp-custom-name',"Esc 撤销");await browser.key("Escape");await browser.wait("document.querySelector('#employee-emp-custom-name').value==='普通员工'");
  cases.push({name:"whole profile cancel/Escape restore profile and avatar without writes"});
  for(const id of ["e_wand_default","e_wand_ops"]){
    await editor(id);await section("appearance");assert.equal(await e("document.querySelector('.appearance input[type=file]')!==null"),false);assert.equal(await e("document.querySelectorAll('.appearance input[type=radio]').length"),0);
    assert.ok(await e("document.querySelector('.fixed-avatar')?.textContent.includes('系统固定头像')"));
    for(const field of ["name","duty","prompt"])assert.equal(await e(`document.getElementById('employee-${id}-${field}').disabled`),false,`${id} profile ${field} editable`);
    await fill(`#employee-${id}-name`,`${id} 已编辑`);await section("role");await fill(`#employee-${id}-duty`,"固定身份的新职责");await fill(`#employee-${id}-prompt`,"固定身份的新角色");
    await section("tools");await browser.click('[aria-label="把备用 2上移"]');await browser.click('.wand-employee-save-submit');
    await browser.wait("document.querySelector('[data-employee-profile]').textContent.includes('员工资料已保存')");
    const write=requests.filter(r=>r.method==="PUT").at(-1);assert.equal(write.path,`/api/silicon-employees/${id}`);assert.equal("avatar" in write.body,false,"fixed avatar never echoed");assert.equal("tags" in write.body,false);
    assert.equal(write.body.prompt,"固定身份的新角色");assert.deepEqual(write.body.agents.map(a=>a.model),["m2","m1"]);
    assert.equal(employees.find(item=>item.id===id).avatar,id==="e_wand_default"?"plush-cat:v1:silver":"plush-cat:v1:orange");
  }
  cases.push({name:"both fixed cats forbid avatar editing but save changed profile and ordered candidates only"});
  for(const id of ["e_wand_decision_expert","e_wand_speech_polisher"]){
    await directory();await browser.click(`.employee-item[data-directory-employee-id="${id}"]`);await browser.wait(`!!document.getElementById("employee-${id}-name")`);
    for(const width of [1440,390]){
      await browser.send("Emulation.setDeviceMetricsOverride",{width,height:1000,deviceScaleFactor:1,mobile:false});await browser.settle();
      for(const field of ["name","duty","prompt","tags"])assert.equal(await e(`document.getElementById("employee-${id}-${field}").disabled`),true,`${id}/${width}: ${field} locked`);
      assert.ok(await e("document.querySelector('.ant-alert')?.textContent.includes('内置员工已锁定')"));
      assert.equal(await e("document.documentElement.scrollWidth>innerWidth"),false);
      await browser.screenshot(join(output,`builtin-${id}-${width}.png`));
    }
    await section("appearance");assert.equal(await e("document.querySelectorAll('.appearance input:not(:disabled)').length"),0,"all avatar editing inputs locked, including disabled fieldsets");
    await section("advanced");assert.equal(await e("[...document.querySelectorAll('[data-employee-profile] button')].some(n=>/归档员工|恢复员工|删除员工/.test(n.textContent))"),false);
    await section("tools");await browser.click('[aria-label="把备用 2上移"]');await browser.click('.wand-employee-save-submit');await browser.wait("document.querySelector('[data-employee-profile]').textContent.includes('员工资料已保存')");
    const write=requests.filter(r=>r.method==="PUT").at(-1);assert.equal(write.path,`/api/silicon-employees/${id}`);assert.deepEqual(Object.keys(write.body),["agents"]);assert.deepEqual(write.body.agents.map(a=>a.model),["m2","m1"]);
    assert.equal(employees.find(item=>item.id===id).name,id==="e_wand_decision_expert"?"石一":"口述整理师");
    cases.push({name:"locked built-in profile, avatar and lifecycle; ordered candidates still editable",id});
  }
  await browser.send("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await editor("emp-source");await section("appearance");const sourceBefore=writes();assert.equal(await e("document.querySelector('.appearance img.photo').getAttribute('src')"),photo);assert.equal(await e("document.querySelectorAll('.appearance input[type=radio]').length"),0);
  await fill('#employee-emp-source-name',"源员工已编辑");await browser.click('.wand-employee-save-submit');await browser.wait("document.querySelector('[data-employee-profile]').textContent.includes('员工资料已保存')");assert.equal(employees.find(item=>item.id==="emp-source").avatar,photo);
  await clickText("改用毛绒头像",".appearance");await browser.wait("!!document.querySelector('.appearance input[value=heart]')");await browser.click('.appearance input[value=blue]');assert.equal(writes(),sourceBefore+1);
  await clickText("取消");assert.equal(await e("document.querySelector('.appearance img.photo').getAttribute('src')"),photo);
  cases.push({name:"source uploaded image persists through unrelated save; explicit conversion cancelled without overwriting source"});
  await editor("emp-custom");await section("tools");const validationBefore=writes();await clickText("添加候选");await browser.wait("document.querySelectorAll('.wand-team-candidate').length===3");await browser.click('.wand-employee-save-submit');
  await browser.wait("document.querySelector('[role=alert]')?.textContent.includes('与更靠前')");assert.equal(writes(),validationBefore,"invalid duplicate candidates blocked before request");await browser.click('[aria-label="删除备用 3"]');await browser.wait("document.querySelectorAll('.wand-team-candidate').length===2");
  await browser.click('[aria-label="把备用 2上移"]');await browser.wait("document.querySelector('.wand-team-candidate [aria-label$=模型]').textContent.includes('模型二')");await browser.wait("!document.querySelector('.wand-employee-save-submit').disabled");await browser.click('.wand-employee-save-submit');await browser.wait("document.querySelector('[data-employee-profile]').textContent.includes('员工资料已保存')");
  assert.deepEqual(employees.find(item=>item.id==="emp-custom").agents.map(a=>a.model),["m2","m1"]);
  cases.push({name:"candidate duplicate validation, deletion and fallback order save"});
  await e("employeeProfileFixture.drawer('emp-custom')");await browser.wait("!!document.querySelector('#object-profile-panel.open')");await pause(400);await clickText("编辑员工配置","#object-profile-panel");await browser.wait("!!document.querySelector('#object-profile-panel [data-employee-profile]')");
  await section("tools","#object-profile-panel");const model='#object-profile-panel .wand-team-candidate [aria-label$="模型"]';await browser.click(model);await browser.wait("!!document.querySelector('.wand-ui-select-content input')");await browser.click('.wand-ui-select-content input');await browser.send("Input.insertText",{text:"模型"});
  assert.ok(await e("!!document.querySelector('#object-profile-panel [data-employee-profile]')"),"owned Portal search does not close drawer editor");await browser.key("Escape");await browser.wait("!document.querySelector('.wand-ui-select-content')");assert.ok(await e("!!document.querySelector('#object-profile-panel [data-employee-profile]')"),"first Escape closes owned select only");
  assert.equal(await e(`document.activeElement===document.querySelector(${JSON.stringify(model)})`),true,"Portal Escape restores model trigger");await clickText("取消","#object-profile-panel");await browser.wait("!document.querySelector('#object-profile-panel [data-employee-profile]')");await browser.key("Escape");await browser.wait("!document.querySelector('#object-profile-panel.open')");
  cases.push({name:"real ObjectProfilePanel owned Portal search, Escape and focus restore"});
  await editor("emp-custom");
  for(const theme of ["warm","blue","forest","mauve","graphite"]){await e(`employeeProfileFixture.setTheme('${theme}')`);
    for(const width of [1440,390,320]){await browser.send("Emulation.setDeviceMetricsOverride",{width,height:1000,deviceScaleFactor:1,mobile:false});await browser.settle();assert.equal(await e("document.documentElement.scrollWidth<=innerWidth"),true,`${theme}/${width} contains layout`);await browser.screenshot(join(output,`profile-${theme}-${width}.png`));cases.push({name:"theme/responsive",theme,width})}}
  await section("appearance");
  await browser.send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});await browser.wait("document.querySelector('.preview-state')?.textContent.includes('已减少动效')");assert.equal(await e("[...document.querySelectorAll('.appearance button')].find(n=>n.textContent.includes('预览说话动作')).disabled"),true);
  await browser.screenshot(join(output,"profile-reduced-motion.png"));cases.push({name:"reduced motion shows honest static state and disables speech preview"});
  const fallback=await openPlushBrowser(390,1000,true);try{await fallback.send("Page.navigate",{url:origin});await fallback.wait("!!window.employeeProfileFixture");await fallback.evaluate("employeeProfileFixture.editor('emp-custom')");await fallback.wait("!!document.querySelector('[data-employee-profile]')");await fallback.click('.identity-summary button');await fallback.wait("document.querySelector('.appearance .preview-state')?.textContent.includes('3D 不可用')");assert.equal(await fallback.evaluate("[...document.querySelectorAll('.appearance button')].find(n=>n.textContent.includes('预览说话动作')).disabled"),true);await fallback.screenshot(join(output,"profile-webgl-fallback.png"));}finally{await fallback.close()}
  cases.push({name:"WebGL fallback truthful static label and disabled animation preview"});
  await browser.send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"no-preference"}]});await directory();
  await browser.click('.employee-item[data-directory-employee-id="emp-custom"]');await section("advanced");await clickText("归档员工");await browser.wait("[...document.querySelectorAll('[data-employee-profile] button')].some(n=>n.textContent.trim()==='恢复员工')");
  await browser.click('[aria-label="返回员工列表"]');await browser.wait("!!document.querySelector('.employee-directory')");
  assert.equal(await e("!!document.querySelector('.employee-item[data-directory-employee-id=emp-custom]')"),false);
  await browser.click('.employee-directory input[type=checkbox]');await browser.wait("!!document.querySelector('.employee-item[data-directory-employee-id=emp-custom]')");await browser.click('.employee-item[data-directory-employee-id="emp-custom"]');await section("advanced");await clickText("恢复员工");await browser.wait("[...document.querySelectorAll('[data-employee-profile] button')].some(n=>n.textContent.trim()==='归档员工')");assert.equal(employees.find(item=>item.id==="emp-custom").archivedAt,undefined);
  cases.push({name:"actual directory archive and restore fixture roundtrip"});
  await browser.click('[aria-label="返回员工列表"]');await clickText("招聘员工",".employee-directory");await browser.wait("!!document.querySelector('#new-employee-expectation')");
  await fill('#new-employee-expectation',"不能丢失的新建草稿");await browser.click('[aria-label="返回员工列表"]');
  await browser.wait("[...document.querySelectorAll('[role=dialog]')].some(n=>n.textContent.includes('放弃尚未保存')&&n.getClientRects().length)");await clickText("继续编辑","[role=dialog]");
  assert.equal(await e("document.querySelector('#new-employee-expectation').value"),"不能丢失的新建草稿");
  await browser.wait("![...document.querySelectorAll('[role=dialog]')].some(n=>n.getClientRects().length)");await browser.click('.ant-collapse-header');await fill('#new-employee-name',"手动创建验证员工");await fill('#new-employee-duty',"真实手动配置");
  await clickText("编辑头像",".is-new");await browser.click('.is-new .appearance input[value="diamond"]');
  assert.equal(await e("document.querySelectorAll('.ant-popover,.ant-modal-wrap').length"),0,"new employee avatar edits inline without another overlay");
  await e("document.querySelector('.wand-employee-create-submit').scrollIntoView({block:'nearest',behavior:'instant'});true");await browser.settle();
  const createBefore=await e("document.querySelector('.wand-employee-create-submit').getBoundingClientRect().toJSON()");
  deferCreate=true;await browser.click('.wand-employee-create-submit');await browser.wait("document.querySelector('.wand-employee-create-submit').getAttribute('aria-busy')==='true'");
  const createPending=await e("document.querySelector('.wand-employee-create-submit').getBoundingClientRect().toJSON()");
  assert.ok(['x','y','width','height'].every(key=>Math.abs(createBefore[key]-createPending[key])<1),'pending create keeps button position and size');
  assert.equal(await e("document.querySelector('[aria-label=\"返回员工列表\"]').disabled"),true);
  assert.ok(await e("!!document.querySelector('#new-employee-name')"),"pending manual create prevents scope switch");
  createRelease();await browser.wait("!!document.querySelector('[data-employee-id=emp-created]')");assert.equal(employees.find(item=>item.id==='emp-created').name,"手动创建验证员工");assert.match(employees.find(item=>item.id==='emp-created').avatar,/^plush:v1:diamond:/);
  await section("advanced");await clickText("删除员工");await browser.wait("[...document.querySelectorAll('[role=dialog]')].some(n=>n.textContent.includes('删除员工')&&n.getClientRects().length)");await clickText("取消","[role=dialog]");assert.ok(employees.some(item=>item.id==='emp-created'));
  await clickText("删除员工");await browser.wait("[...document.querySelectorAll('[role=dialog]')].some(n=>n.textContent.includes('删除员工')&&n.getClientRects().length)");await clickText("删除员工","[role=dialog]");await browser.wait("!document.querySelector('[data-employee-id=emp-created]')");assert.equal(employees.some(item=>item.id==='emp-created'),false);
  cases.push({name:"manual create dirty guard, delayed create blocks switching, confirmation cancel and explicit delete fixture roundtrip"});
  }
  assert.equal(result.modelCalls,0);assert.deepEqual(browser.errors,[]);result.pointerEvidence=await e("({events:window.__guardPointer,plans:window.__employeeClickPlans,dialog:employeeProfileFixture.dialogState(),actions:employeeProfileFixture.dialogActions})");result.ok=true;writeFileSync(join(output,"browser-result.json"),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:true,cases:cases.length,modelCalls:0,output}));
}catch(error){result.ok=false;result.error=error.message;result.errors=browser.errors;result.pointerEvidence=await e("({events:window.__guardPointer,plans:window.__employeeClickPlans,dialog:employeeProfileFixture.dialogState(),actions:employeeProfileFixture.dialogActions})").catch(()=>null);await browser.screenshot(join(output,"failure.png")).catch(()=>{});writeFileSync(join(output,"browser-result.json"),JSON.stringify(result,null,2));throw error}
finally{await browser.close();await new Promise(resolveClose=>server.close(resolveClose));rmSync(temp,{recursive:true,force:true})}
