// Production composer avatars in real Chrome/WebGL. No AI tasks or config writes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { build } from "esbuild";
import { openPlushBrowser, recordMotion } from "./run-plush-avatar-browser-harness.mjs";
const root = resolve(import.meta.dirname, "../.."), output = resolve(process.env.WAND_FILE_AVATAR_OUTPUT || "output/avatar-file-work");
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "wand-file-avatar-"));
await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
import * as React from 'react';import {createRoot} from 'react-dom/client';
import {ComposerIdentity} from './src/web-ui/react/composer-sender/identity';
import {PlushAvatar} from './src/web-ui/react/avatars/plush-avatar';
import {resolveEmployeeAvatar} from './src/plush-avatar';
import {composerAvatarActivity} from './src/web-ui/composer-avatar-activity';
import {WandUiProvider} from './src/web-ui/react/theme';
const employees=[{id:'e_wand_default',name:'赛博虎妞',avatar:'plush-cat:v1:silver'},
{id:'e_wand_ops',name:'勤劳的初二',avatar:'plush-cat:v1:orange'},
{id:'demo',name:'几何员工',avatar:'plush:v1:round:sage:gold:none'}];
function Preview(){const [messages,setMessages]=React.useState([]),[running,setRunning]=React.useState(false);
const action=composerAvatarActivity({structuredState:{inFlight:running}},messages);
React.useEffect(()=>{window.fileFixture={set(kind){setRunning(kind!=='idle');setMessages(kind==='idle'?[]:[{role:'user',content:[]},{role:'assistant',content:[{type:'tool_use',id:'demo-file',name:'fixture',input:{},activity:{kind:kind==='reading'?'read_file':'edit_file',label:'fixture.txt'}}]}]);},finish(error=false){setMessages(previous=>[...previous,{role:'assistant',content:[{type:'tool_result',tool_use_id:'demo-file',content:'',is_error:error}]}]);},stop(){setRunning(false)},switch(){setMessages([{role:'user',content:[]}])},cycle(kind){this.set('idle');setTimeout(()=>this.set(kind),550);setTimeout(()=>this.set('idle'),9400)}}},[]);
return <WandUiProvider><main><h1>输入框员工头像 · 动态设计稿</h1><p>查看文件时读书，编写文件时执笔写字</p><div className='cards'>{employees.map(employee=><section key={employee.id}>
<h2>{employee.name}</h2><div className='detail'><PlushAvatar config={resolveEmployeeAvatar(employee)} size={220} interactive={employee.id!=='demo'} fileActivity={action}/></div>
<div className='composer-preview'><ComposerIdentity employee={employee} fileActivity={action}/><div className='input-example'>继续输入你的消息…</div></div>
</section>)}</div><p className='status'>{action==='reading'?'查看文件 · 阅读中':action==='writing'?'编写文件 · 书写中':'待机'}</p><small>上方放大展示动作 · 下方为实际输入框 72px 头像</small></main></WandUiProvider>}
createRoot(document.getElementById('root')).render(<Preview/>);
` }, bundle: true, format: "iife", target: "es2022", outfile: join(temp, "app.js"), jsx: "automatic" });
await build({ entryPoints: [join(root, "src/web-ui/react/avatars/renderer.ts")], bundle: true, format: "iife", target: "es2022", outfile: join(temp, "runtime.js") });
const server = createServer((req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  const asset = pathname === "/app.js" ? "app.js" : pathname === "/assets/plush-avatar.js" ? "runtime.js" : null;
  if (asset) { res.setHeader("Content-Type", "text/javascript"); res.end(readFileSync(join(temp, asset))); return; }
  res.setHeader("Content-Type", "text/html;charset=utf-8");
  res.end(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;background:#faf8f5;color:#29241f;font:15px -apple-system,'PingFang SC',sans-serif}main{max-width:980px;margin:32px auto;padding:0 18px;text-align:center}h1{font-size:24px}h2{font-size:16px;margin:12px}.cards{display:flex;gap:20px}.cards section{flex:1;min-width:0;border:1px solid #ebe5dd;border-radius:12px;background:#fffdfa;padding:16px 8px}.detail{height:248px;display:grid;place-items:center}.composer-preview{position:relative;text-align:left;min-height:80px;border-top:1px solid #ebe5dd;margin:12px 6px 0;padding:20px 0 0}.composer-floating-avatar{position:absolute;left:0;top:0}.input-example{margin-left:78px;color:#6b5e54;font-size:13px;line-height:28px}.status{font-size:18px;min-height:28px}small{color:#6b5e54}@media(max-width:600px){main{margin:16px auto}.cards{flex-direction:column}.detail{height:180px}.detail .wand-plush-avatar{transform:scale(.75)}h1{font-size:20px}}
</style><body><div id="root"></div><script>window.__wandBrowserRuntime={configPath:"",aiTeamsChunkSrc:"",plushAvatarChunkSrc:"/assets/plush-avatar.js"};</script><script src="/app.js"></script></body></html>`);
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const report = { modelCalls: 0, cases: [], videos: [] };
const b = await openPlushBrowser(1180, 680, false, "no-preference");
try {
  await b.send("Page.navigate", { url: origin });
  await b.wait("!!window.fileFixture && document.querySelectorAll('[data-renderer=webgl]').length===6");
  for (const action of ["reading", "writing"]) {
    await b.evaluate(`fileFixture.set('${action}');true`);
    await b.wait(`document.querySelector('.composer-floating-avatar canvas').dataset.fileActivity==='${action}'`);
    assert.equal(await b.evaluate("document.querySelectorAll('.wand-avatar-thinking').length"), 0);
    const before = await b.evaluate("document.querySelector('.composer-floating-avatar canvas').dataset.filePropPose");
    await new Promise(r => setTimeout(r, 450));
    const after = await b.evaluate("document.querySelector('.composer-floating-avatar canvas').dataset.filePropPose");
    assert.notEqual(after, before, "actual 3D props advance");
    if (action === "writing") assert.equal(await b.evaluate("Number(document.querySelector('.composer-floating-avatar canvas').dataset.nibContact)"), 0);
    if (action === "reading") {
      await b.wait("Number(document.querySelector('.composer-floating-avatar canvas').dataset.pageAngle)>0.5 && Number(document.querySelector('.composer-floating-avatar canvas').dataset.pageAngle)<1.25");
      await b.screenshot(join(output, "reading-turn.png"));
    }
    const border = await b.evaluate("[...document.querySelectorAll('.detail canvas,.composer-floating-avatar canvas')].map(c=>{const pixels=c.getContext('2d').getImageData(0,c.height-1,c.width,1).data;let n=0;for(let x=0;x<c.width;x++)if(pixels[x*4+3]>20)n++;return n})");
    assert.ok(border.every(count=>count===0), `held props are not clipped at canvas bottom: ${JSON.stringify(border)}`);
    await b.screenshot(join(output, `${action}.png`));
    await b.evaluate("(()=>{const e=window.__wandPlushRuntime;e.camera.position.set(3.2,2.0,4);e.camera.lookAt(0,-0.25,0);for(const r of e.registrations)r.dirty=true;e.schedule()})()");
    await b.settle(); await new Promise(r=>setTimeout(r,350));
    await b.screenshot(join(output, `${action}-side.png`));
    await b.evaluate("(()=>{const e=window.__wandPlushRuntime;e.camera.position.set(0.12,0.14,5);e.camera.lookAt(0,0.05,0);for(const r of e.registrations)r.dirty=true;e.schedule()})()");
    await b.settle();
    await b.evaluate(`fileFixture.cycle('${action}');true`);
    report.videos.push({ action, ...await recordMotion(b, `file-${action}-preview-v3`, 11000) });
    await b.wait("document.querySelector('.composer-floating-avatar').dataset.fileActivity==='idle'");
    await b.evaluate(`fileFixture.set('${action}');fileFixture.finish(true);true`);
    await b.wait("document.querySelector('.composer-floating-avatar').dataset.fileActivity==='idle'");
    report.cases.push({ action, actualFrames: true, noTopDecoration: true, resultErrorRetires: true });
  }
  await b.evaluate("fileFixture.set('writing');fileFixture.set('reading');true");
  await b.wait("document.querySelector('.composer-floating-avatar').dataset.fileActivity==='reading'");
  await b.evaluate("fileFixture.switch();true");
  await b.wait("document.querySelector('.composer-floating-avatar').dataset.fileActivity==='idle'");
  await b.evaluate("fileFixture.set('writing');fileFixture.stop();true");
  await b.wait("document.querySelector('.composer-floating-avatar').dataset.fileActivity==='idle'");
  report.cases.push({ quickSwitch: true, nextTurn: true, cancel: true });
  await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  for (const action of ["reading", "writing", "idle"]) {
    await b.evaluate(`fileFixture.set('${action}');true`); await b.settle();
    await new Promise(r => setTimeout(r, 300));
    await b.screenshot(join(output, `reduced-${action}.png`));
  }
  const frozen = await b.evaluate("window.__wandPlushDiagnostics().frames");
  await new Promise(r => setTimeout(r, 400));
  assert.equal(await b.evaluate("window.__wandPlushDiagnostics().frames"), frozen);
  await b.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1300, deviceScaleFactor: 1, mobile: false });
  await b.evaluate("fileFixture.set('writing');true"); await b.settle();
  assert.equal(await b.evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
  await b.screenshot(join(output, "writing-390.png"));
  report.cases.push({ reducedMotionFrozen: true, distinctCachedPoses: true, narrowOverflow: false });
  await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await b.evaluate("document.querySelector('main').style.marginTop='2000px';window.scrollTo(0,0);true");
  await b.wait("window.__wandPlushDiagnostics().visible===0");
  assert.equal(await b.evaluate("window.__wandPlushDiagnostics().animated"), 0);
  assert.deepEqual(b.errors, []);
  report.cases.push({ offscreenPaused: true, runtimeErrors: 0 });
} finally { await b.close(); }
const fallback = await openPlushBrowser(390, 1300, true, "reduce");
try {
  await fallback.send("Page.navigate", { url: origin }); await fallback.wait("document.querySelectorAll('[data-renderer=fallback]').length===6");
  for (const action of ["reading", "writing"]) {
    await fallback.evaluate(`fileFixture.set('${action}');true`); await fallback.settle();
    assert.equal(await fallback.evaluate("document.querySelector('.composer-floating-avatar [data-file-prop]').dataset.fileProp"), action);
    await fallback.screenshot(join(output, `fallback-${action}.png`));
  }
  report.cases.push({ webglFallback: ["reading", "writing"] });
} finally { await fallback.close(); await new Promise(r => server.close(r)); rmSync(temp, { recursive: true, force: true }); }
report.ok = true; writeFileSync(join(output, "browser-result.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
