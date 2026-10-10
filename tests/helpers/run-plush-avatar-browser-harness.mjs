// Real Chrome, production React owners. Loopback fixture only; never dispatches a model.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { build } from "esbuild";

const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
const root = resolve(import.meta.dirname, "../..");
export const output = resolve(root, process.env.WAND_PLUSH_BROWSER_OUTPUT || "output/plush-avatar");
mkdirSync(output, { recursive: true });

export async function recordMotion(browser, name = "avatar-motion") {
  const directory = join(output, name); mkdirSync(directory, { recursive: true });
  browser.events.splice(0);
  await browser.send("Page.startScreencast", { format: "png", everyNthFrame: 1, maxWidth: 1280, maxHeight: 960 });
  const samples = [], deadline = Date.now() + 4500;
  try {
    while (Date.now() < deadline) {
      const fresh = browser.events.splice(0);
      for (const event of fresh.filter(item => item.method === "Page.screencastFrame")) {
        const { data, metadata, sessionId } = event.params;
        const path = join(directory, `frame-${String(samples.length).padStart(4,"0")}.png`);
        writeFileSync(path, Buffer.from(data,"base64")); samples.push({ path, time: metadata.timestamp });
        await browser.send("Page.screencastFrameAck", { sessionId });
      }
      await pause(20);
    }
  } finally { await browser.send("Page.stopScreencast"); }
  assert.ok(samples.length >= 10, "actual animated browser screencast yields multiple frames");
  writeFileSync(join(directory,"timing.json"), JSON.stringify(samples,null,2));
  const concat = samples.map((sample,index) => `file '${sample.path}'\nduration ${Math.max(0.01,(samples[index+1]?.time || sample.time+0.1)-sample.time)}`).join("\n") + `\nfile '${samples.at(-1).path}'\n`;
  writeFileSync(join(directory,"frames.ffconcat"), concat);
  const ffmpeg = process.env.FFMPEG_BIN || "/opt/homebrew/bin/ffmpeg";
  let video = null;
  if (existsSync(ffmpeg)) {
    video = join(output, `${name}.mp4`);
    const child = spawn(ffmpeg,["-y","-hide_banner","-loglevel","error","-f","concat","-safe","0","-i",join(directory,"frames.ffconcat"),"-vsync","vfr","-c:v","libx264","-pix_fmt","yuv420p","-movflags","+faststart",video], {stdio:["ignore","ignore","pipe"]});
    let error = ""; child.stderr.on("data",chunk=>error+=chunk);
    const code = await new Promise(resolveExit=>child.once("exit",resolveExit)); assert.equal(code,0,error);
  }
  return { frames: samples.length, duration: samples.at(-1).time-samples[0].time, video, timing: "Actual Chrome screencast timestamps preserved" };
}

export async function openPlushBrowser(width = 1280, height = 960, fallback = false) {
  const temp = mkdtempSync(join(tmpdir(), "wand-plush-chrome-"));
  const chrome = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--no-first-run", "--ignore-certificate-errors", "--remote-allow-origins=*",
    "--remote-debugging-port=0", `--user-data-dir=${temp}/profile`,
    ...(fallback ? ["--disable-webgl"] : ["--enable-unsafe-swiftshader"]), "about:blank",
  ], { stdio: "ignore" });
  let socket;
  try {
    const portFile = join(temp, "profile/DevToolsActivePort");
    for (let n = 0; n < 150 && !existsSync(portFile); n++) await pause(50);
    assert.ok(existsSync(portFile), "Chrome must start");
    const port = readFileSync(portFile, "utf8").split("\n")[0];
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
    await once(socket, "open");
    const pending = new Map(), errors = [], events = []; let sequence = 0;
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.method) events.push(message);
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(Error(`CDP rejected ${request.method}`)) : request.resolve(message.result);
    });
    const send = (method, params = {}) => new Promise((resolveSend, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP deadline ${method}`)); }, 15000);
      pending.set(id, { method, timer, resolve: resolveSend, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (reply.exceptionDetails) throw Error("Browser evaluation failed: " + (reply.exceptionDetails.exception?.description || reply.exceptionDetails.text));
      return reply.result.value;
    };
    const wait = async (expression, label = expression) => {
      for (let n = 0; n < 250; n++) { if (await evaluate(expression)) return; await pause(40); }
      throw Error(`Browser condition missing: ${label}`);
    };
    const settle = () => evaluate("document.fonts.ready.then(()=>new Promise(resolve=>{let n=0;function frame(){if(++n===6)resolve();else requestAnimationFrame(frame)}requestAnimationFrame(frame)}))");
    const click = async selector => {
      const point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled)throw Error('missing/enabled target');n.scrollIntoView({block:'nearest',behavior:'instant'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
      await settle();
    };
    const clickText = async text => {
      const selector = await evaluate(`(()=>{const n=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)}&&n.getClientRects().length);if(!n)throw Error('Missing ${text}');n.dataset.plushTest='target';return '[data-plush-test="target"]'})()`);
      await click(selector); await evaluate("document.querySelector('[data-plush-test]')?.removeAttribute('data-plush-test')");
    };
    const key = async name => {
      const codes = { Tab: 9, Escape: 27, Enter: 13, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
      for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: name, code: name, windowsVirtualKeyCode: codes[name] });
      await settle();
    };
    const screenshot = async path => {
      await settle(); const shot = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path, Buffer.from(shot.data, "base64"));
    };
    await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    return { send, evaluate, wait, settle, click, clickText, key, screenshot, errors, events,
      async close() {
        socket.close(); chrome.kill("SIGTERM"); await Promise.race([once(chrome, "exit"), pause(1500)]);
        try { rmSync(temp, { recursive: true, force: true }); } catch { /* only owned Chrome profile */ }
      },
    };
  } catch (error) { socket?.close(); chrome.kill("SIGTERM"); throw error; }
}

export async function runPlushBrowser() {
  const temp = mkdtempSync(join(tmpdir(), "wand-plush-source-"));
  const photo = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#a44"/><circle cx="20" cy="20" r="12" fill="#fee"/></svg>').toString("base64");
  let stored = { id: "avatar-fixture", name: "头像验证员工", duty: "仅本地浏览器验证", prompt: "Never dispatch", avatar: "", tags: [],
    agents: [{ id: "avatar-fixture-agent", kind: "structured", provider: "codex", model: "fixture-model", thinkingEffort: "off" }], createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z" };
  const requests = [], cases = [], evidence = { fixtureOnly: true, productionComponents: true, modelExecution: false, cases, requests,
    rendererSourceSha256: createHash("sha256").update(readFileSync(join(root,"src/web-ui/react/avatars/renderer.ts"))).digest("hex") };
  const bundle = join(temp, "app.js");
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import * as React from "react";
    import {createRoot} from "react-dom/client";
    import {EmployeeCard} from "./src/web-ui/react/agents/employee-card";
    import {EmployeeAvatar,EmployeeAvatarPicker} from "./src/web-ui/react/agents/employee-avatar";
    import {siliconEmployeesRepository} from "./src/web-ui/react/agents/employee-repository";
    import {WandUiProvider} from "./src/web-ui/react/theme";
    import {setWandTheme} from "./src/web-ui/react/theme-preference";
    import {installReactUiStyles} from "./src/web-ui/react/styles";
    import {defaultPlushAvatar,encodePlushAvatar,parsePlushAvatar} from "./src/plush-avatar";
    import {PlushAvatar} from "./src/web-ui/react/avatars/plush-avatar";
    installReactUiStyles();
    const controls={setTheme:setWandTheme,changes:[],saves:0,photo:${JSON.stringify(photo)},setAvatar:null};window.plushHarness=controls;
    const examples=[['心形','heart:coral:none:none'],['圆角三角','triangle:sage:gold:none'],['菱形','diamond:lavender:none:none'],
      ['圆形','round:cream:none:beanie'],['圆角方形','square:blue:ink:none'],['胶囊','capsule:ochre:none:beret']];
    controls.showShapes=()=>{document.querySelector('main').hidden=true;const target=document.createElement('div');target.id='shape-showcase';document.body.appendChild(target);
      createRoot(target).render(<WandUiProvider><main style={{maxWidth:1000,margin:'auto',padding:20}}><h1 style={{fontSize:20}}>Wand · 几何毛绒 3D 头像</h1>
        <p>实际 Three.js 模型与配件 · 本地隔离视觉验证</p><section style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:22}}>
          {examples.map(([label,value])=><figure key={value} style={{margin:0,textAlign:'center',padding:14,borderRadius:8,background:'var(--bg-secondary)'}}>
            <PlushAvatar config={parsePlushAvatar('plush:v1:'+value)} size={256} interactive/>
            <figcaption style={{fontSize:13,lineHeight:2}}>{label}</figcaption></figure>)}
        </section></main></WandUiProvider>);window.scrollTo(0,0)};
    function Harness(){
      const [employee,setEmployee]=React.useState(null);
      React.useEffect(()=>{siliconEmployeesRepository.list().then(list=>setEmployee(list[0]));},[]);
      const [avatar,setAvatar]=React.useState('');controls.setAvatar=setAvatar;
      const [gallery,setGallery]=React.useState(false);controls.setGallery=setGallery;
      return <WandUiProvider><main style={{maxWidth:1000,margin:'auto',padding:16}}>
        <h1 style={{fontSize:20}}>毛绒头像 · 本地交互验证</h1><p>真实组件；隔离配置，不调用模型。</p>
        <section id="standalone"><EmployeeAvatarPicker employeeId="stable-person" name="稳定员工" avatar={avatar} disabled={false}
          onChange={value=>{controls.changes.push(value);setAvatar(value)}}/><output id="draft-value" hidden>{avatar}</output></section>
        <section id="employee-form">{employee&&<EmployeeCard employee={employee} catalog={null} providerOptions={null}
          onSave={async patch=>{controls.saves++;setEmployee(await siliconEmployeesRepository.update(employee.id,patch))}}/>}</section>
        {gallery&&<section id="avatar-gallery" aria-label="多人头像" style={{display:'grid',gridTemplateColumns:'repeat(9,minmax(0,1fr))',gap:12,marginTop:30}}>
          {Array.from({length:36},(_,n)=><div key={n}><EmployeeAvatar employee={{id:'gallery-'+n,name:'员工 '+n,avatar:''}} size="lg"/><small>员工 {n+1}</small></div>)}
        </section>}
        <div style={{height:1500}} aria-hidden="true"/>
      </main></WandUiProvider>;
    }
    createRoot(document.getElementById('root')).render(<Harness/>);
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: bundle,
    define: { "process.env.NODE_ENV": '"production"' } });
  const runtimeBundle = join(temp, "plush-avatar.js");
  await build({ entryPoints: [join(root,"src/web-ui/react/avatars/renderer.ts")], bundle: true, platform: "browser",
    format: "iife", minify: true, outfile: runtimeBundle });
  writeFileSync(bundle, readFileSync(bundle,"utf8").replaceAll("${plushAvatarChunkSrc}", "/assets/plush-avatar.js"));
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://fixture.invalid").pathname;
    if (path.startsWith("/api/")) {
      let raw = ""; for await (const chunk of request) raw += chunk;
      requests.push({ path, method: request.method, ...(raw ? { body: JSON.parse(raw) } : {}) });
      response.setHeader("Content-Type", "application/json");
      if (path === "/api/silicon-employees") response.end(JSON.stringify({ employees: [stored] }));
      else if (path === "/api/silicon-employees/avatar-fixture" && request.method === "PUT") {
        stored = { ...stored, ...JSON.parse(raw) }; response.end(JSON.stringify(stored));
      } else response.end(JSON.stringify(path === "/api/session-check" ? { authed: false } : {}));
      return;
    }
    const files = { "/app.js": [bundle, "text/javascript"], "/assets/plush-avatar.js": [runtimeBundle,"text/javascript"], "/styles.css": [join(root,"src/web-ui/content/styles.css"),"text/css"],
      "/tailwind.css": [join(root,"src/web-ui/content/tailwind.css"),"text/css"] };
    if (files[path]) { response.setHeader("Content-Type", files[path][1]); response.end(readFileSync(files[path][0])); return; }
    response.setHeader("Content-Type", "text/html;charset=utf-8");
    response.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><body><div id="root" data-wand-ui-root></div><div id="wand-react-ui-portals" data-wand-ui-root></div><script src="/app.js"></script></body></html>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await openPlushBrowser();
  const e = browser.evaluate;
  const scopedText = async (text, scope = "#standalone") => {
    const selector = await e(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(scope + " button")})].find(n=>n.textContent.trim()===${JSON.stringify(text)}&&n.getClientRects().length);if(!n)throw Error('Missing scoped button');n.dataset.plushTest='scope';return '[data-plush-test=scope]'})()`);
    await browser.click(selector); await e("document.querySelector('[data-plush-test=scope]')?.removeAttribute('data-plush-test')");
  };
  const open = async (scope = "#standalone") => {
    await scopedText("捏脸", scope);
    await browser.wait(`!!document.querySelector('${scope} [role=region][aria-label="捏脸"]')`);
  };
  const choose = async (label, scope = "#standalone") => browser.click(`${scope} input[aria-label="${label}"]`);
  const diagnostics = () => e("window.__wandPlushDiagnostics?.()");
  try {
    await browser.send("Page.navigate", { url: origin });
    await browser.wait("!!document.querySelector('#standalone [data-plush-avatar][data-renderer=webgl]')", "actual WebGL avatar ready");
    await browser.wait("!!document.querySelector('#employee-form .wand-team-member-head')");
    const initial = await e("document.querySelector('#standalone [data-plush-avatar]').dataset.avatarConfig");
    assert.equal(await e("plushHarness.changes.length"), 0, "render defaults never writes");
    await browser.send("Page.reload"); await browser.wait("!!document.querySelector('#standalone [data-plush-avatar][data-renderer=webgl]')");
    assert.equal(await e("document.querySelector('#standalone [data-plush-avatar]').dataset.avatarConfig"), initial, "stable ID survives refresh");
    cases.push({ name: "stable seed refresh; zero implicit changes", config: initial });
    await browser.click('#standalone button[aria-label="编辑员工头像"]');
    await browser.wait("[...document.querySelectorAll('.ant-popover button')].some(n=>n.textContent.trim()==='上传图片')");
    await browser.key("Escape");
    await e("(()=>{const n=document.querySelector('#standalone input[type=file]'),d=new DataTransfer();d.items.add(new File(['invalid'], 'bad.svg',{type:'image/svg+xml'}));n.files=d.files;n.dispatchEvent(new Event('change',{bubbles:true}))})()");
    await browser.wait("document.querySelector('#standalone [role=alert]')?.textContent.includes('PNG')");
    assert.equal(await e("plushHarness.changes.length"), 0, "rejected upload retains original avatar");
    await e("new Promise(resolve=>{const c=document.createElement('canvas');c.width=16;c.height=16;c.getContext('2d').fillRect(0,0,16,16);c.toBlob(blob=>{const n=document.querySelector('#standalone input[type=file]'),d=new DataTransfer();d.items.add(new File([blob],'valid.png',{type:'image/png'}));n.files=d.files;n.dispatchEvent(new Event('change',{bubbles:true}));resolve()},'image/png')})");
    await browser.wait("document.querySelector('#draft-value').textContent.startsWith('data:image/')");
    assert.equal(requests.filter(r => r.method !== "GET").length, 0, "upload writes draft only");
    cases.push({name:"upload valid PNG, invalid format preserves config; no server write"});
    await e("plushHarness.setAvatar(plushHarness.photo)"); await browser.wait("!!document.querySelector('#standalone img[src^=\"data:image\"]')");
    await open(); await choose("心形"); await choose("珊瑚"); await choose("金框眼镜"); await choose("贝雷帽");
    assert.equal(await e("document.querySelector('#draft-value').textContent"), photo, "sculpting leaves original photo intact");
    await browser.clickText("取消");
    await browser.wait("!document.querySelector('#standalone [role=region][aria-label=捏脸]')");
    assert.equal(await e("document.activeElement.getAttribute('aria-label')"), "编辑员工头像", "cancel restores trigger focus");
    assert.equal(await e("document.querySelector('#draft-value').textContent"), photo);
    await open(); await choose("菱形"); await browser.key("Escape");
    await browser.wait("!document.querySelector('#standalone [role=region][aria-label=捏脸]')");
    assert.equal(await e("document.querySelector('#draft-value').textContent"), photo);
    cases.push({ name: "uploaded photo preserved by preview, Cancel and Escape" });
    await open(); await choose("心形"); await e("plushHarness.setAvatar('plush:v1:square:blue:ink:none')");
    await browser.wait("!document.querySelector('#standalone [role=region][aria-label=捏脸]')");
    assert.equal(await e("document.querySelector('#draft-value').textContent"), "plush:v1:square:blue:ink:none");
    assert.ok(await e("document.querySelector('#standalone [role=alert]')?.textContent.includes('头像已更新')"));
    cases.push({name:"external avatar replacement invalidates stale sculpt preview"});
    await open(); await choose("圆角三角"); await choose("灰绿"); await choose("金框眼镜"); await choose("无帽子");
    await e("document.querySelector('#standalone input[aria-label=\"圆角三角\"]').focus()"); await browser.key("ArrowRight");
    assert.equal(await e("document.querySelector('#standalone input[aria-label=\"菱形\"]').checked"), true, "native radio arrow selection");
    await browser.key("Tab");
    assert.ok(await e("document.activeElement.closest('fieldset')?.querySelector('legend')?.textContent.startsWith('颜色')"), "Tab moves between native option groups");
    const ax = await browser.send("Accessibility.getFullAXTree");
    for(const label of ["造型","颜色","眼镜","帽子"])assert.ok(ax.nodes.some(node=>node.role?.value==="group"&&node.name?.value.startsWith(label)),`${label} has a native accessible fieldset group`);
    await choose("圆角三角");
    const mutationsBeforeApply = requests.filter(r => r.method !== "GET").length;
    await browser.clickText("使用这个头像");
    await browser.wait("document.querySelector('#draft-value').textContent==='plush:v1:triangle:sage:gold:none'");
    assert.equal(requests.filter(r => r.method !== "GET").length, mutationsBeforeApply, "apply is draft-only");
    cases.push({ name: "shape/color/glasses/hat apply changes draft only; native arrow keyboard" });
    await browser.click("#employee-form .wand-team-member-head"); await open("#employee-form");
    await choose("心形", "#employee-form"); await choose("珊瑚", "#employee-form"); await choose("无眼镜", "#employee-form"); await choose("无帽子", "#employee-form");
    await browser.clickText("使用这个头像");
    assert.equal(await e("plushHarness.saves"), 0); assert.equal(stored.avatar, "");
    await browser.click("#employee-form .wand-employee-save-submit"); await browser.wait("plushHarness.saves===1");
    assert.equal(stored.avatar, "plush:v1:heart:coral:none:none");
    cases.push({ name: "production repository route persists only explicit employee save", avatar: stored.avatar });
    await open();
    for (const theme of ["warm", "blue", "forest", "mauve", "graphite"]) {
      await e(`plushHarness.setTheme(${JSON.stringify(theme)})`); await browser.settle();
      for (const width of [1280, 390, 320]) {
        await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 960, deviceScaleFactor: 1, mobile: false });
        await browser.settle();
        assert.equal(await e("document.documentElement.scrollWidth<=innerWidth"), true, `${theme}/${width} no horizontal overflow`);
        const radios = await e("[...document.querySelectorAll('#standalone input[type=radio]')].map(n=>({label:n.getAttribute('aria-label'),checked:n.checked}))");
        assert.ok(radios.length >= 18, "composable controls remain available");
        await e("window.scrollTo(0,0)");
        await browser.screenshot(join(output, `sculpt-${theme}-${width}.png`));
        cases.push({ name: "theme/narrow", theme, width });
      }
    }
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
    await e("plushHarness.setTheme('warm');window.scrollTo(0,0)"); await browser.settle();
    const shapeExamples = [["heart","心形","珊瑚","无眼镜","无帽子"],["triangle","圆角三角","灰绿","金框眼镜","无帽子"],
      ["diamond","菱形","淡紫","无眼镜","无帽子"],["round","圆形","奶油","无眼镜","针织帽"],
      ["square","圆角方形","雾蓝","黑框眼镜","无帽子"],["capsule","胶囊","赭黄","无眼镜","贝雷帽"]];
    await e("document.querySelector('#employee-form').hidden=true");
    for (const [id,shape,color,glasses,hat] of shapeExamples) {
      for (const option of [shape,color,glasses,hat]) await choose(option);
      await browser.wait("document.querySelector('#standalone [role=region] [data-plush-avatar]').dataset.renderer==='webgl'");
      await pause(150); await e("window.scrollTo(0,0)"); await browser.screenshot(join(output,`shape-${id}.png`));
    }
    cases.push({ name:"six actual 3D plush shapes and optional accessories", shapes:shapeExamples.map(item=>item[0]) });
    const before = await e("(()=>{const n=document.querySelector('#standalone [role=region] canvas');return{frame:n?.dataset.frame,rotation:n?.dataset.sceneRotation,box:n?.getBoundingClientRect().toJSON()}})()");
    await pause(800);
    const after = await e("(()=>{const n=document.querySelector('#standalone [role=region] canvas');return{frame:n?.dataset.frame,rotation:n?.dataset.sceneRotation,box:n?.getBoundingClientRect().toJSON()}})()");
    assert.ok(Number(after.frame)>Number(before.frame), "real rendered frames advance");
    assert.notEqual(after.rotation, before.rotation, "3D object orientation changes");
    assert.deepEqual(after.box, before.box, "canvas geometry stable while actual object animates");
    const idleMouth = await e("document.querySelector('#standalone [role=region] canvas')?.dataset.mouthScale");
    await browser.clickText("预览说话动作");
    const speaking = [];
    for (let sample = 0; sample < 8; sample++) {
      await pause(80); speaking.push(Number(await e("document.querySelector('#standalone [role=region] canvas')?.dataset.mouthScale")));
    }
    assert.ok(Math.max(...speaking) - Math.min(...speaking) > 0.002, "explicit speech preview animates mouth");
    assert.ok(speaking.some(value => Math.abs(value - Number(idleMouth)) > 0.002), "speaking differs from idle mouth");
    const video = await recordMotion(browser); cases.push({name:"actual timestamped browser motion video",...video});
    const frames = [];
    for (let n = 0; n < 24; n++) {
      const path = join(output, `motion-${String(n).padStart(3,"0")}.png`); await browser.screenshot(path); frames.push(path); await pause(50);
    }
    cases.push({ name: "actual 3D object/mouth frames", before, after, speaking, frames: frames.length });
    await e("plushHarness.setGallery(true)"); await browser.wait("document.querySelectorAll('#avatar-gallery [data-plush-avatar]').length===36");
    await e("document.querySelector('#avatar-gallery').scrollIntoView({block:'center',behavior:'instant'})"); await pause(1800);
    const budget = await diagnostics(); assert.ok(budget, "diagnostics available");
    assert.equal(budget.contexts, 1); assert.ok(budget.animated <= 6, "ordinary plus preview animation cap");
    assert.ok(budget.registrations >= 36, "large actual avatar list mounted");
    cases.push({ name: "36 avatar shared WebGL budget", diagnostics: budget });
    const heap = await browser.send("Runtime.getHeapUsage"); cases.push({name:"Chrome JavaScript heap with large list",heap});
    await e("window.plushContextLoss=window.__wandPlushRuntime.renderer.getContext().getExtension('WEBGL_lose_context');plushContextLoss.loseContext()");
    await browser.wait("window.__wandPlushDiagnostics().contextLost===true");
    await browser.wait("!!document.querySelector('#avatar-gallery [data-renderer=fallback]')");
    await e("plushContextLoss.restoreContext()"); await browser.wait("window.__wandPlushDiagnostics().contextLost===false");
    await browser.wait("!!document.querySelector('#avatar-gallery [data-renderer=webgl]')");
    cases.push({name:"real WebGL context loss uses fallback and restores 3D"});
    const background = await browser.send("Target.createTarget", {url:"about:blank",background:false});
    try {
      await browser.send("Target.activateTarget", {targetId:background.targetId});
      await browser.wait("document.visibilityState==='hidden'");
      await pause(200); const hiddenBefore = await diagnostics(); await pause(500); const hiddenAfter = await diagnostics();
      assert.equal(hiddenAfter.hidden,true); assert.equal(hiddenAfter.animated,0); assert.equal(hiddenAfter.frames,hiddenBefore.frames);
      cases.push({name:"real background Chrome tab pauses renderer",diagnostics:hiddenAfter});
    } finally {await browser.send("Target.closeTarget",{targetId:background.targetId});await browser.send("Page.bringToFront");}
    await browser.wait("document.visibilityState==='visible'");
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    // A motion-preference change renders one frozen frame for each visible
    // identity. Let this bounded static redraw finish before testing the loop.
    let reduced1 = await diagnostics();
    for(let settle=0;settle<30;settle++){await pause(200);const next=await diagnostics();if(next.reducedMotion&&next.animated===0&&next.frames===reduced1.frames){reduced1=next;break}reduced1=next;}
    await pause(500); const reduced2 = await diagnostics();
    assert.equal(reduced2.reducedMotion, true); assert.equal(reduced2.animated, 0); assert.equal(reduced2.frames, reduced1.frames, "reduced motion freezes ambient loop");
    cases.push({ name: "reduced motion", diagnostics: reduced2 });
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    await e("window.scrollTo(0,document.documentElement.scrollHeight)"); await pause(500);
    const offscreen = await diagnostics(); assert.equal(offscreen.visible, 0); assert.equal(offscreen.animated, 0);
    cases.push({ name: "offscreen avatars pause", diagnostics: offscreen });
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    assert.deepEqual(browser.errors, [], "no runtime exception");
    const fallback = await openPlushBrowser(390, 960, true);
    try {
      await fallback.send("Page.navigate", { url: origin }); await fallback.wait("!!document.querySelector('[data-plush-avatar][data-renderer=fallback]')");
      assert.equal(await fallback.evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
      await fallback.clickText("捏脸"); await fallback.wait("!!document.querySelector('#standalone [role=region]')");
      await fallback.click('#standalone input[aria-label="心形"]'); await fallback.click('#standalone input[aria-label="珊瑚"]');
      await fallback.click('#standalone input[aria-label="无眼镜"]'); await fallback.click('#standalone input[aria-label="无帽子"]');
      await fallback.clickText("使用这个头像");
      assert.equal(await fallback.evaluate("document.querySelector('#draft-value').textContent"),"plush:v1:heart:coral:none:none","WebGL fallback retains usable configuration editing");
      await fallback.screenshot(join(output, "webgl-fallback.png"));
      cases.push({ name: "WebGL unavailable retains geometric fallback and usable controls" });
    } finally { await fallback.close(); }
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    await e("plushHarness.showShapes()"); await browser.wait("document.querySelectorAll('#shape-showcase [data-plush-avatar][data-renderer=webgl]').length===6");
    await pause(500); await browser.screenshot(join(output,"six-shapes-3d.png"));
    cases.push({name:"six high-resolution actual 3D model gallery",size:256});
    evidence.ok = true; writeFileSync(join(output,"browser-result.json"), JSON.stringify(evidence,null,2)+"\n");
    console.log(JSON.stringify({ ok: true, cases: cases.length, output, realWebgl: true, modelCalls: 0 }));
  } catch (error) {
    evidence.ok = false; evidence.error = error.message; evidence.runtimeErrors = browser.errors;
    await browser.screenshot(join(output, "failure.png")).catch(()=>{});
    writeFileSync(join(output,"browser-result.json"), JSON.stringify(evidence,null,2)+"\n"); throw error;
  } finally {
    await browser.close(); await new Promise(resolveClose=>server.close(resolveClose)); rmSync(temp,{recursive:true,force:true});
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await runPlushBrowser();
