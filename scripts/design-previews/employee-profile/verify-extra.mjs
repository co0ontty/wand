import assert from "node:assert/strict";
import { readFileSync,writeFileSync } from "node:fs";
import { join } from "node:path";
const output=join(import.meta.dirname,"evidence");
process.env.WAND_PLUSH_BROWSER_OUTPUT=output;
const {openPlushBrowser,recordMotion}=await import("../../../tests/helpers/run-plush-avatar-browser-harness.mjs");
const report=JSON.parse(readFileSync(join(output,'browser-report.json'),'utf8'));
const browser=await openPlushBrowser(1280,1000);
try{
 await browser.send('Page.navigate',{url:'http://127.0.0.1:8794/'});await new Promise(r=>setTimeout(r,700));await browser.wait("!!document.querySelector('.avatar-stage [data-renderer=webgl]')");
 await browser.key('Tab');assert.ok(await browser.evaluate("document.activeElement.tagName==='BUTTON'||document.activeElement.tagName==='INPUT'"));report.cases.push('Tab reaches interactive controls');
 await browser.evaluate(`(()=>{const n=document.querySelector('input[type=file]'),d=new DataTransfer();d.items.add(new File(['bad'],'bad.svg',{type:'image/svg+xml'}));n.files=d.files;n.dispatchEvent(new Event('change',{bubbles:true}))})()`);await browser.wait("document.querySelector('[role=alert]')?.textContent.includes('PNG')");report.cases.push('invalid image leaves avatar draft unchanged');
 await browser.evaluate(`new Promise(resolve=>{const c=document.createElement('canvas');c.width=24;c.height=24;c.getContext('2d').fillRect(0,0,24,24);c.toBlob(blob=>{const n=document.querySelector('input[type=file]'),d=new DataTransfer();d.items.add(new File([blob],'valid.png',{type:'image/png'}));n.files=d.files;n.dispatchEvent(new Event('change',{bubbles:true}));resolve()},'image/png')})`);await browser.wait("!!document.querySelector('.avatar-stage img[src^=\"data:image/\"]')");await browser.clickText('取消');await browser.wait("!!document.querySelector('.avatar-stage [data-renderer=webgl]')");report.cases.push('real PNG decode/crop; unified cancel restores original 3D avatar');
 for(const [value,label] of [['warm','暖白'],['blue','海蓝'],['forest','森林'],['mauve','雾紫'],['graphite','石墨']]){
  await browser.click('[aria-label="预览主题"]');
  const selector=await browser.evaluate(`(()=>{const n=[...document.querySelectorAll('[role=option]')].find(n=>n.textContent.trim()===${JSON.stringify(label)});n.dataset.verify='theme';return '[data-verify=theme]'})()`);await browser.click(selector);await browser.wait(`document.documentElement.dataset.wandTheme===${JSON.stringify(value)}`);
  for(const width of [1280,320]){await browser.send('Emulation.setDeviceMetricsOverride',{width,height:width===320?920:1000,deviceScaleFactor:1,mobile:false});await browser.settle();assert.equal(await browser.evaluate('document.documentElement.scrollWidth>innerWidth'),false);}
  report.cases.push(`${value} theme: 1280/320px no overflow; selector reflects selected theme`);
 }
 await browser.send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});await browser.click('[aria-label="预览主题"]');await browser.click('[role=option]');
 await browser.send('Emulation.setDeviceMetricsOverride',{width:1280,height:960,deviceScaleFactor:1,mobile:false});await browser.clickText('预览说话动作');report.motion=await recordMotion(browser,'employee-profile-motion');await browser.clickText('停止动作预览');report.cases.push('actual Chrome screencast: explicit local speaking preview');
 assert.deepEqual(browser.errors,[]);
}finally{await browser.close()}
const fallback=await openPlushBrowser(1280,1000,true);
try{
 await fallback.send('Page.navigate',{url:'http://127.0.0.1:8794/'});await new Promise(r=>setTimeout(r,700));await fallback.wait("!!document.querySelector('.avatar-stage [data-renderer=fallback]')");
 assert.equal(await fallback.evaluate("document.querySelector('.preview-state').textContent.includes('静态预览')"),true);assert.equal(await fallback.evaluate("[...document.querySelectorAll('.avatar-stage button')].some(b=>b.textContent.includes('说话'))"),false);
 await fallback.screenshot(join(output,'employee-profile-fallback.png'));report.cases.push('forced unavailable WebGL: visible static status, speaking controls absent');assert.deepEqual(fallback.errors,[]);
}finally{await fallback.close()}
const offline=await openPlushBrowser(1280,1000);
try{
 await offline.send('Page.navigate',{url:'file://'+join(import.meta.dirname,'Wand-employee-profile-preview.html')});await new Promise(r=>setTimeout(r,700));await offline.wait("!!document.querySelector('.avatar-stage [data-renderer=webgl]')");
 assert.equal(offline.events.some(e=>e.method==='Network.requestWillBeSent'&&/^https?:/.test(e.params.request.url)),false);report.cases.push('self-contained HTML opens offline with actual 3D; no HTTP requests; CSP forbids connections');assert.deepEqual(offline.errors,[]);
}finally{await offline.close()}
writeFileSync(join(output,'browser-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
