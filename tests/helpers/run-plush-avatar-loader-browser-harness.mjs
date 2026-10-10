// Resource failure fixtures only. No installed-service connection, model or business API.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {openPlushBrowser} from './run-plush-avatar-browser-harness.mjs';
const root=resolve(import.meta.dirname,'../..'),output=join(root,'output/plush-loader-browser');mkdirSync(output,{recursive:true});
const temp=mkdtempSync(join(tmpdir(),'wand-plush-loader-')),pause=ms=>new Promise(r=>setTimeout(r,ms));
const cases=[],assets=[],businessRequests=[],browserErrors=[],states=new Map(),result={fixtureOnly:true,cases,assets,businessRequests,browserErrors};
await build({stdin:{resolveDir:root,loader:'tsx',contents:`
 import * as React from 'react';import {createRoot} from 'react-dom/client';
 import {EmployeeAvatarWorkspace} from './src/web-ui/react/agents/employee-avatar-workspace';
 import {WandUiProvider} from './src/web-ui/react/theme';import {PortalContainerProvider} from './src/web-ui/react/ui';
 import {installReactUiStyles} from './src/web-ui/react/styles';import {installEmployeeProfileStyles} from './src/web-ui/react/styles/employee-profile';
 installReactUiStyles();installEmployeeProfileStyles();const scenario=new URL(location.href).searchParams.get('scenario');
 const controls={changes:[],renderEvents:[]};window.loaderFixture=controls;
 function App(){const[shown,setShown]=React.useState(scenario!=='offline'),[employee,setEmployee]=React.useState({id:'fixture-a',name:'资源恢复验证',avatar:'plush:v1:heart:coral:none:none'});
 controls.show=setShown;controls.employee=setEmployee;
 return <><header className='fixture-heading'>Wand 3D 资源加载恢复 · 本地隔离验证</header><main data-employee-profile className='profile'>{shown&&<EmployeeAvatarWorkspace key={employee.id} employee={employee} disabled={false} onChange={avatar=>{controls.changes.push(avatar);setEmployee(e=>({...e,avatar}))}}/>}</main></>}
 createRoot(document.getElementById('root')).render(<PortalContainerProvider container={document.getElementById('wand-react-ui-portals')}><WandUiProvider><App/></WandUiProvider></PortalContainerProvider>);
`},bundle:true,format:'iife',platform:'browser',jsx:'automatic',outfile:join(temp,'app.js'),define:{'process.env.NODE_ENV':'"production"'}});
await build({entryPoints:[join(root,'src/web-ui/react/avatars/renderer.ts')],bundle:true,format:'iife',platform:'browser',minify:true,outfile:join(temp,'runtime.js')});
const source=readFileSync(join(temp,'app.js'),'utf8'),runtime=readFileSync(join(temp,'runtime.js'));
const server=createServer((request,response)=>{
 const url=new URL(request.url,'http://fixture.invalid'),scenario=url.searchParams.get('scenario')||'first503';
 if(url.pathname.startsWith('/api/')){businessRequests.push({path:url.pathname,method:request.method});response.writeHead(403);response.end('Fixture blocks all business API');return}
 if(url.pathname==='/runtime.js'){
  const state=states.get(scenario)||{mode:scenario,count:0};states.set(scenario,state);state.count++;
  const fail=state.mode==='always503'||state.mode==='offline'||((state.mode==='first503'||state.mode==='network')&&state.count===1);
  assets.push({scenario,attempt:state.count,time:Date.now(),outcome:state.mode==='network'&&fail?'network-error':fail?503:200});
  if(state.mode==='network'&&fail){response.writeHead(200,{'Content-Type':'text/javascript','Content-Length':runtime.byteLength+100});response.write('/* interrupted resource transfer */');setTimeout(()=>response.destroy(),50);return}
  if(fail){response.writeHead(503,{'Content-Type':'text/javascript','Cache-Control':'no-store'});response.end('');return}
  const send=()=>{response.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});response.end(runtime)};
  if(state.mode==='late'||(state.mode==='timeoutLate'&&state.count===1)){state.release=send;return}send();return;
 }
 if(url.pathname==='/app.js'){response.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});response.end(source.replaceAll('${plushAvatarChunkSrc}',`/runtime.js?scenario=${scenario}`));return}
 const files={'/styles.css':join(root,'src/web-ui/content/styles.css'),'/tailwind.css':join(root,'src/web-ui/content/tailwind.css')};
 if(files[url.pathname]){response.writeHead(200,{'Content-Type':'text/css'});response.end(readFileSync(files[url.pathname]));return}
 response.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});response.end(`<!doctype html><html><meta name='viewport' content='width=device-width,initial-scale=1'><link rel='stylesheet' href='/styles.css'><link rel='stylesheet' href='/tailwind.css'><style>html,body{margin:0}.fixture-heading{padding:14px 20px;font:12px system-ui}[data-employee-profile]{width:340px!important;height:calc(100vh - 44px)!important;margin:0 auto}.appearance{width:100%!important;overflow:auto!important}</style><div id='root' data-wand-ui-root></div><div id='wand-react-ui-portals' data-wand-ui-root></div><script src='/app.js?scenario=${scenario}'></script></html>`);
});server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
const browsers=[];
const open=async(scenario,{gpu=false,reduced=false}={})=>{
 const b=await openPlushBrowser(960,1100,gpu);browsers.push(b);
 browserErrors.push(b.errors);
 if(reduced)await b.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await b.send('Page.navigate',{url:`${origin}/?scenario=${scenario}`});await b.wait('!!window.loaderFixture');return b;
};
const mark=async b=>b.evaluate("(()=>{window.__loaderCanvas=document.querySelector('.avatar-stage canvas');window.__loaderRoot=document.querySelector('.avatar-stage [data-plush-avatar]');return true})()");
const webgl=async b=>{await b.wait("document.querySelector('.avatar-stage [data-renderer=webgl]')?.querySelector('canvas')?.dataset.frame>0");assert.equal(await b.evaluate("window.__loaderCanvas===document.querySelector('.avatar-stage canvas')&&window.__loaderRoot===document.querySelector('.avatar-stage [data-plush-avatar]')"),true,'Resource recovery keeps same mounted canvas/identity')};
const diagnostics=b=>b.evaluate('window.__wandPlushLoaderDiagnostics?.()');
const retry=async b=>{await b.evaluate("(()=>{const n=[...document.querySelectorAll('.appearance button')].find(n=>n.textContent.replace(/\\s/g,'')==='重新加载3D');if(!n)throw Error('Missing resource retry');n.dataset.loaderRetry='true'})()");await b.click('[data-loader-retry]')};
try{
 for(const scenario of ['first503','network']){
  const b=await open(scenario);await b.wait("!!document.querySelector('.avatar-stage canvas')");await mark(b);await webgl(b);
  assert.equal(states.get(scenario).count,2);assert.equal((await diagnostics(b)).attempts,2,'Actual shared loader performs a retry');assert.equal(await b.evaluate('loaderFixture.changes.length'),0);cases.push({name:scenario+' auto recovery without refresh or draft change',diagnostics:await diagnostics(b)});await b.screenshot(join(output,scenario+'-recovered.png'));await b.close();browsers.splice(browsers.indexOf(b),1);
 }
 const failed=await open('always503');await failed.wait("document.querySelector('.avatar-stage [data-fallback-reason=runtime-load]')!==null");await mark(failed);assert.equal(states.get('always503').count,3,'Automatic attempts bounded at 3');assert.ok(await failed.evaluate("document.querySelector('.preview-state').textContent.includes('静态')"));
 await pause(1000);assert.equal(states.get('always503').count,3,'No endless retry after fallback');await failed.screenshot(join(output,'resource-failure.png'));
 states.get('always503').mode='ok';await retry(failed);await webgl(failed);assert.equal(states.get('always503').count,4);cases.push({name:'Exhausted failure honest static label then explicit retry recovers same mount',diagnostics:await diagnostics(failed)});await failed.close();browsers.splice(browsers.indexOf(failed),1);
 const timeoutLate=await open('timeoutLate');await timeoutLate.wait("!!document.querySelector('.avatar-stage canvas')");await mark(timeoutLate);
 const deadline=Date.now()+24000;while(Date.now()<deadline&&!await timeoutLate.evaluate("document.querySelector('.avatar-stage [data-renderer=webgl]')?.querySelector('canvas')?.dataset.frame>0"))await pause(80);
 await webgl(timeoutLate);assert.equal(states.get('timeoutLate').count,2);await timeoutLate.evaluate("(()=>{window.__readyRuntime=window.__wandPlushRuntime;window.__readyRegistrationCount=window.__wandPlushDiagnostics().registrations;window.__frameBeforeLate=Number(window.__loaderCanvas.dataset.frame);return true})()");
 states.get('timeoutLate').release();await pause(500);
 // A removed script may be discarded by Chrome; execute the same real asset again to verify registration idempotence too.
 await timeoutLate.evaluate("new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/runtime.js?scenario=duplicate';script.onload=()=>resolve(true);script.onerror=reject;document.head.append(script)})");await pause(400);
 assert.equal(await timeoutLate.evaluate("window.__readyRuntime===window.__wandPlushRuntime"),true,'Late duplicate script cannot replace active runtime');assert.equal(await timeoutLate.evaluate("window.__wandPlushDiagnostics().registrations===window.__readyRegistrationCount&&window.__wandPlushDiagnostics().createdContexts===1"),true,'Late script never adds another context or registration');assert.equal(await timeoutLate.evaluate("Number(window.__loaderCanvas.dataset.frame)>window.__frameBeforeLate"),true,'Existing canvas continues real frames after late duplicate');
 cases.push({name:'True first-request 15s timeout, second success, late duplicate keeps runtime/context identity',diagnostics:await diagnostics(timeoutLate)});await timeoutLate.close();browsers.splice(browsers.indexOf(timeoutLate),1);
 const late=await open('late');await late.wait("!!document.querySelector('.avatar-stage canvas')");while(!states.get('late')?.release)await pause(20);await mark(late);
 await late.evaluate('loaderFixture.show(false)');await late.wait("!document.querySelector('.appearance')");states.get('late').release();await pause(600);
 assert.equal(await late.evaluate('window.__wandPlushDiagnostics?.().registrations||0'),0,'Unmounted avatar never attaches late runtime');assert.equal(await late.evaluate('document.querySelectorAll("canvas").length'),0);
 await late.evaluate("loaderFixture.employee({id:'fixture-b',name:'替换身份',avatar:'plush:v1:square:blue:none:none'});loaderFixture.show(true)");await late.wait("!!document.querySelector('.avatar-stage canvas')");await mark(late);await webgl(late);assert.ok(await late.evaluate("document.querySelector('.avatar-stage [data-plush-avatar]').dataset.avatarConfig.includes('square')"));assert.equal(states.get('late').count,1,'Shared successful runtime reused after employee switch');cases.push({name:'Unmounted delayed response cannot resurrect old preview; replacement mounts own latest config'});await late.close();browsers.splice(browsers.indexOf(late),1);
 const offline=await open('offline');await offline.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});await offline.wait('!navigator.onLine');await offline.evaluate('loaderFixture.show(true)');await offline.wait("!!document.querySelector('.avatar-stage [data-fallback-reason=runtime-load]')");await mark(offline);
 await offline.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await offline.wait('navigator.onLine');await offline.wait("window.__wandPlushLoaderDiagnostics?.().attempts===6");await pause(1000);
 const beforeOnline=states.get('offline').count;await offline.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});await offline.wait('!navigator.onLine');await offline.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await offline.wait('navigator.onLine');await pause(1200);
 assert.equal(states.get('offline').count,beforeOnline,'Online transition offers only one additional bounded recovery cycle');assert.equal(await offline.evaluate('window.__wandPlushLoaderDiagnostics().attempts'),6);states.get('offline').mode='ok';await retry(offline);await webgl(offline);cases.push({name:'Actual browser offline/online bounded additional cycle; explicit retry then recovers',diagnostics:await diagnostics(offline)});await offline.close();browsers.splice(browsers.indexOf(offline),1);
 const gpu=await open('gpu',{gpu:true});await gpu.wait("!!document.querySelector('.avatar-stage [data-fallback-reason=webgl-unavailable]')");assert.equal(await gpu.evaluate("[...document.querySelectorAll('.appearance button')].some(n=>n.textContent.includes('重新加载'))"),false);await pause(1000);assert.equal(states.get('gpu').count,1);cases.push({name:'GPU unavailable remains honest static without asset retry'});await gpu.close();browsers.splice(browsers.indexOf(gpu),1);
 const reduced=await open('reduced',{reduced:true});await reduced.wait("!!document.querySelector('.avatar-stage canvas')");await mark(reduced);await webgl(reduced);assert.equal(await reduced.evaluate("[...document.querySelectorAll('.avatar-stage button')].find(n=>n.textContent.includes('预览说话')).disabled"),true);assert.ok(await reduced.evaluate("document.querySelector('.preview-state').textContent.includes('已减少动效')"));cases.push({name:'Reduced motion remains static after resource recovery',diagnostics:await diagnostics(reduced)});await reduced.close();browsers.splice(browsers.indexOf(reduced),1);
 assert.deepEqual(businessRequests,[]);assert.deepEqual(browserErrors.flat(),[],'No JavaScript runtime exception during recovery');result.ok=true;writeFileSync(join(output,'browser-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:true,cases:cases.length,businessRequests:0,output}));
}catch(error){result.ok=false;result.error=error.stack;result.failureDiagnostics=[];for(const [i,b]of browsers.entries()){result.runtimeErrors=b.errors;result.failureDiagnostics.push(await diagnostics(b).catch(()=>null));await b.screenshot(join(output,`failure-${i}.png`)).catch(()=>{})}writeFileSync(join(output,'browser-result.json'),JSON.stringify(result,null,2));throw error}
finally{for(const b of browsers)await b.close();await new Promise(r=>server.close(r));rmSync(temp,{recursive:true,force:true})}
