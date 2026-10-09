import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { openBrowser } from './sidebar-ux-browser.mjs';

const entry = `import React,{useSyncExternalStore} from 'react';import{createRoot}from'react-dom/client';
import{WandUiProvider}from'./src/web-ui/react/theme.tsx';
import{DaemonUpdateNotice}from'./src/web-ui/react/shell/daemon-update-notice.tsx';
import{WandDialog}from'./src/web-ui/react/ui/dialog.tsx';
import{overlayStore}from'./src/web-ui/react/overlay-controller.tsx';
function ConfirmHost(){const{activeDialog:d}=useSyncExternalStore(overlayStore.subscribe,overlayStore.getSnapshot,overlayStore.getSnapshot);return d?<WandDialog open {...d.options} onDismiss={()=>overlayStore.completeDialog(d.id,{dismissed:true})} onAction={action=>overlayStore.completeDialog(d.id,{dismissed:false,action})}/>:null;}
window.renderNotice=compact=>createRoot(document.getElementById('root')).render(<WandUiProvider><input aria-label="草稿" defaultValue="不要覆盖"/><header style={{padding:12,display:'flex',alignItems:'center',gap:8}}><strong>Wand</strong><DaemonUpdateNotice compact={compact}/></header><ConfirmHost/></WandUiProvider>);window.renderNotice(new URLSearchParams(location.search).has('compact'));`;
const built = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: process.cwd() }, bundle: true,
  format: 'iife', write: false, define: { 'process.env.NODE_ENV': '"production"' } });
const script = built.outputFiles[0].text;
let phase='idle', requests=0, failed=false, updates=0, failUpdate=false, allowed=true, release;
const server=createServer((req,res)=>{
  if(req.url==='/api/daemon-maintenance/force-update') {
    updates++;
    let body='';req.on('data',data=>body+=data);req.on('end',async()=>{
      assert.deepEqual(JSON.parse(body),{confirmInterrupt:true});
      await new Promise(resolve=>{release=resolve;});
      res.writeHead(failUpdate?409:200,{'Content-Type':'application/json'});
      if(!failUpdate)phase='idle';
      res.end(JSON.stringify(failUpdate?{error:'强制更新未完成，请稍后重试。'}:{pending:false,phase:'idle'}));
    });return;
  }
  if(req.url==='/api/daemon-maintenance') {
    requests++;res.writeHead(failed?503:200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(failed?{error:'offline'}:{pending:phase!=='idle',phase,canForceUpdate:allowed}));return;
  }
  if(req.url==='/app.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(script);return;}
  res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root" style="max-width:320px"></div><script src="/app.js"></script></body></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
mkdirSync('output/daemon-update-20261009',{recursive:true});
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await openBrowser(base,390,700);
try {
  await browser.wait('!!document.querySelector("input")');
  await browser.wait('!document.querySelector(".daemon-update-notice")');
  await browser.click('input');await browser.evaluate("document.querySelector('input').value='保留当前输入'");
  for(const next of ['waiting','updating','retrying','idle']) {
    phase=next;await browser.evaluate("document.dispatchEvent(new Event('visibilitychange'))");
    const label={waiting:'组件待更新',updating:'组件更新中',retrying:'组件更新待重试'}[next];
    await browser.wait(next==='idle'?'!document.querySelector(".daemon-update-notice")':`document.querySelector('.daemon-update-notice')?.textContent.includes(${JSON.stringify(label)})`);
    assert.deepEqual(await browser.evaluate(`(()=>{const n=document.querySelector('.daemon-update-notice');const i=document.querySelector('input');return{focus:document.activeElement===i,value:i.value,overflow:n?n.scrollWidth>n.clientWidth:false}})()`),{focus:true,value:'保留当前输入',overflow:false});
    if(next!=='idle')assert.equal(await browser.evaluate("document.querySelector('[data-daemon-update-action]').disabled"),next==='updating');
  }
  phase='waiting';await browser.evaluate("document.dispatchEvent(new Event('visibilitychange'))");await browser.wait('!!document.querySelector(".daemon-update-notice")');
  await browser.click('[data-daemon-update-status]');
  await browser.wait("document.querySelector('.ant-popover')?.textContent.includes('等待执行与队列结束')");
  await browser.key('Escape');await browser.wait("document.querySelector('[data-daemon-update-status]').getAttribute('aria-expanded')==='false'");
  assert.equal(await browser.evaluate("document.activeElement===document.querySelector('[data-daemon-update-status]')"),true);
  await browser.click('[data-daemon-update-action]');await browser.wait('!!document.querySelector("[role=dialog]")');
  assert.match(await browser.evaluate("document.querySelector('[role=dialog]').textContent"),/会话历史与排队消息会保留/);
  await browser.key('Escape');await browser.wait('!document.querySelector("[role=dialog]")');assert.equal(updates,0);
  // Failure keeps the notice/input and exposes actionable detail; duplicates are disabled.
  failUpdate=true;
  await browser.click('[data-daemon-update-action]');await browser.click('[role=dialog] .ant-btn-dangerous');
  await browser.wait("document.querySelector('[data-daemon-update-action]').disabled");
  for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,10));assert.ok(release);release();release=null;
  await browser.wait("document.querySelector('[role=alert]')?.textContent.includes('强制更新未完成')");assert.equal(updates,1);
  await browser.screenshot('output/daemon-update-20261009/mobile-failure.png');
  await browser.key('Escape');failUpdate=false;
  await browser.click('[data-daemon-update-action]');await browser.click('[role=dialog] .ant-btn-dangerous');
  for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,10));assert.ok(release);release();release=null;
  await browser.wait('!document.querySelector(".daemon-update-notice")');assert.equal(updates,2);
  assert.equal(await browser.evaluate("document.querySelector('input').value"),'保留当前输入');
  phase='waiting';failed=false;
  await browser.send('Page.navigate',{url:base+'/?compact=1'});await browser.wait('!!document.querySelector(".daemon-update-notice")');
  assert.equal(await browser.evaluate("document.querySelector('.daemon-update-notice').querySelectorAll('button').length"),1);
  await browser.click('[data-daemon-update-status]');await browser.wait("document.querySelector('.ant-popover')?.textContent.includes('强制更新')");
  await browser.screenshot('output/daemon-update-20261009/compact.png');
  allowed=false;await browser.evaluate("document.dispatchEvent(new Event('visibilitychange'))");
  await browser.wait("document.querySelector('[data-daemon-update-action]')?.disabled===true");
  assert.equal(updates,2);
  failed=true;await browser.evaluate("document.dispatchEvent(new Event('visibilitychange'))");
  await browser.settle();assert.equal(await browser.evaluate("!!document.querySelector('.daemon-update-notice')"),true);
  assert.equal(browser.errors.length,0);
  console.log(JSON.stringify({phases:4,cancelWithoutMutation:true,manualSuccess:true,manualFailure:true,duplicateGuard:true,queuesWarning:true,keyboard:true,compact:true,errors:0}));
} finally {release?.();await browser.close();await new Promise(resolve=>server.close(resolve));}
