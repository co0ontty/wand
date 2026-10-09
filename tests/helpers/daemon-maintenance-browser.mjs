import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { openBrowser } from './sidebar-ux-browser.mjs';

const entry = `import React from 'react';import{createRoot}from'react-dom/client';
import{WandUiProvider}from'./src/web-ui/react/theme.tsx';
import{DaemonUpdateNotice}from'./src/web-ui/react/shell/daemon-update-notice.tsx';
createRoot(document.getElementById('root')).render(<WandUiProvider><input aria-label="草稿" defaultValue="不要覆盖"/><DaemonUpdateNotice/></WandUiProvider>);`;
const built = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: process.cwd() }, bundle: true,
  format: 'iife', write: false, define: { 'process.env.NODE_ENV': '"production"' } });
const script = built.outputFiles[0].text;
let phase='idle', requests=0, failed=false;
const server=createServer((req,res)=>{
  if(req.url==='/api/daemon-maintenance') {
    requests++;res.writeHead(failed?503:200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(failed?{error:'offline'}:{pending:phase!=='idle',phase}));return;
  }
  if(req.url==='/app.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(script);return;}
  res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root" style="max-width:320px"></div><script src="/app.js"></script></body></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await openBrowser(`http://127.0.0.1:${server.address().port}`,390,700);
try {
  await browser.wait('!!document.querySelector("input")');
  for(let i=0;i<100&&requests===0;i++) await new Promise(r=>setTimeout(r,10));
  assert.ok(requests>0);
  assert.equal(await browser.evaluate('!!document.querySelector(".daemon-update-notice")'),false,'no update: no notice');
  await browser.click('input');
  await browser.evaluate("document.querySelector('input').value='保留当前输入'");
  for(const next of ['waiting','updating','retrying','idle']) {
    phase=next;
    await browser.evaluate("document.dispatchEvent(new Event('visibilitychange'))");
    const copy={waiting:'等待执行与队列结束',updating:'正在自动更新',retrying:'自动重试'}[next];
    await browser.wait(next==='idle'?'!document.querySelector(".daemon-update-notice")':`document.querySelector('.daemon-update-notice')?.textContent.includes(${JSON.stringify(copy)})`);
    const state=await browser.evaluate(`(()=>{const n=document.querySelector('.daemon-update-notice');const i=document.querySelector('input');return{text:n?.textContent??'',focus:document.activeElement===i,value:i.value,overflow:n?n.scrollWidth>n.clientWidth:false,actions:n?.querySelectorAll('button,a').length??0}})()`);
    assert.equal(state.focus,true);assert.equal(state.value,'保留当前输入');assert.equal(state.overflow,false);assert.equal(state.actions,0);
    assert.doesNotMatch(state.text,/restart-daemons|手动|暂时异常|恢复正常/);
  }
  phase='waiting';await browser.evaluate("document.dispatchEvent(new Event('visibilitychange'))");
  await browser.wait('!!document.querySelector(".daemon-update-notice")');
  failed=true;const before=requests;
  await browser.evaluate("document.dispatchEvent(new Event('visibilitychange'))");
  await browser.wait("!!document.querySelector('.daemon-update-notice')?.textContent.includes('等待执行与队列结束')");
  for(let i=0;i<30&&requests===before;i++) await new Promise(r=>setTimeout(r,10));
  assert.ok(requests>before);assert.equal(browser.errors.length,0);
  console.log(JSON.stringify({phases:4,unchangedComponentsSilent:true,focusPreserved:true,failedProbePreservesNotice:true,errors:0}));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
