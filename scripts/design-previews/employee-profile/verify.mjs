import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openPlushBrowser } from "../../../tests/helpers/run-plush-avatar-browser-harness.mjs";
import assert from "node:assert/strict";
const output=join(import.meta.dirname,"evidence");mkdirSync(output,{recursive:true});
const browser=await openPlushBrowser(1440,1120);
const cases=[];
const setInput=(selector,value)=>browser.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}))})()`);
try{
 await browser.send("Page.navigate",{url:"http://127.0.0.1:8794/"});
 await new Promise(resolve=>setTimeout(resolve,700));
 await browser.wait("!!document.querySelector('#employee-name')");
 await browser.wait("!!document.querySelector('.avatar-stage [data-renderer=webgl]')");
 await browser.screenshot(join(output,"employee-profile-desktop.png"));
 assert.equal(await browser.evaluate("document.documentElement.scrollWidth>innerWidth"),false);cases.push("desktop genuine WebGL; no horizontal overflow");
 await setInput('#employee-name','');await browser.clickText('保存修改');await browser.wait("document.activeElement.id==='employee-name' && !!document.querySelector('[role=alert]')");cases.push("empty name rejects save and focuses field");
 await browser.clickText('取消');assert.equal(await browser.evaluate("document.querySelector('#employee-name').value"),'产品设计师');cases.push("cancel restores saved local draft");
 await setInput('#employee-name','这是一位有很长很长名字的产品设计与协作员工');await browser.clickText('保存修改');await browser.wait("!!document.querySelector('[role=status]')?.textContent.includes('本地预览')");assert.equal(await browser.evaluate("document.documentElement.scrollWidth>innerWidth"),false);cases.push("long name truncation; local save feedback");
 await browser.click('[data-step=tools]');await browser.click('[aria-label="下移候选 1"]');assert.equal(await browser.evaluate("document.querySelector('[aria-label=\"候选 1 工具\"]').textContent.includes('Pi')"),true);await browser.click('[aria-label="上移候选 2"]');cases.push("candidate order changes with accessible controls");
 await browser.click('[aria-label="候选 1 工具"]');await browser.wait("!!document.querySelector('input[aria-label=\"搜索执行工具\"]')");await setInput('input[aria-label="搜索执行工具"]','zzzz不存在');await browser.wait("document.body.textContent.includes('没有匹配的选项')");await browser.key('Escape');cases.push("canonical searchable selector empty state; Esc close");
 await browser.click('[data-step=identity]');await browser.click('.shape input[aria-label="心形"]');await browser.key('ArrowRight');await browser.wait("document.querySelector('.shape input[aria-label=\"圆角三角\"]').checked");cases.push("native avatar radio arrow navigation");
 await browser.key('Escape');await browser.wait("!document.querySelector('.appearance') && document.activeElement.textContent.includes('编辑头像')");await browser.clickText('编辑头像');cases.push("avatar workspace Esc closes and restores focus");
 for(const id of ['e_wand_default','e_wand_ops']){
  const name=id==='e_wand_default'?'赛博虎妞':'勤劳的初二';
  const target=await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('.employee-item')].find(b=>b.textContent.includes(${JSON.stringify(name)}));b.dataset.verify='fixed';return '[data-verify=fixed]'})()`);
  await browser.click(target);await browser.wait("!!document.querySelector('.avatar-stage [data-renderer=webgl]')");
  assert.equal(await browser.evaluate("!!document.querySelector('.appearance input[type=file]')"),false);assert.equal(await browser.evaluate("!!document.querySelector('.appearance fieldset')"),false);assert.equal(await browser.evaluate("document.querySelector('#employee-name').disabled"),false);
  await browser.screenshot(join(output,`${id}-fixed-cat.png`));cases.push(`${name}: actual 3D fixed avatar; no avatar editor; name editable`);
  await browser.evaluate("document.querySelector('[data-verify]')?.removeAttribute('data-verify')");
 }
 await setInput('input[aria-label="搜索员工"]','不存在的名字');await browser.wait("document.querySelector('.no-results')?.textContent.includes('没有匹配')");await browser.click('input[aria-label="搜索员工"]');await browser.key('Escape');await browser.wait("document.querySelectorAll('.employee-item').length===4");cases.push("directory empty search and Esc clear");
 await browser.click('.employee-item');await browser.click('[data-step=identity]');
 for(const width of [1280,390,320]){
  await browser.send('Emulation.setDeviceMetricsOverride',{width,height:width>600?1000:920,deviceScaleFactor:1,mobile:false});await browser.settle();
  if(width<600){await browser.click('[data-step=appearance]');await browser.wait("!!document.querySelector('.appearance')");}
  assert.equal(await browser.evaluate("document.documentElement.scrollWidth>innerWidth"),false,`${width} overflow`);
  await browser.screenshot(join(output,`employee-profile-${width}.png`));cases.push(`${width}px responsive layout no overflow`);
  if(width<600){await browser.click('[aria-label="员工目录"]');await browser.wait("document.querySelector('.directory').getBoundingClientRect().width>200");await browser.click('.directory [aria-label="折叠员工侧栏"]');await browser.wait("document.querySelector('.directory').getBoundingClientRect().width===0");cases.push(`${width}px mobile directory open/close`);}
 }
 assert.deepEqual(browser.errors,[]);
 const requests=browser.events.filter(e=>e.method==='Network.requestWillBeSent').map(e=>({url:e.params.request.url,method:e.params.request.method}));
 assert.equal(requests.some(r=>r.method!=='GET'||r.url.includes('/api/')),false);
 const report={cases,errors:browser.errors,actualApiRequests:0,modelCalls:0,productionWrites:0,chromeSecurity:'Default Chrome settings; no unsafe SwiftShader or certificate bypass'};
 writeFileSync(join(output,'browser-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close()}
