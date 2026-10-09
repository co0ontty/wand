import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { validateSpeechWav } from "../src/speech-service.ts";

test("speech settings and real browser recording preserve selection, cancellation and draft revision", { skip: process.env.WAND_SPEECH_BROWSER !== "1", timeout: 120_000 }, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-speech-browser-"));
  const artifacts = join(root, "output/server-speech/browser"); mkdirSync(artifacts, { recursive: true });
  let settings = { enabled: true, model: "base", language: "auto", threads: 2, acceleration: "cpu" };
  let uploads = 0, delay = 0;
  const status = () => ({ settings, ready: settings.enabled, reason: settings.enabled ? null : "服务端识别未启用", maxDurationSeconds: 60, busy: false,
    runtime: { available: true, backend: "cpu", platform: "linux", arch: "x64" }, download: null,
    models: [{ id: "base", label: "Whisper Base", size: 147951465, description: "通用 CPU / Mac mini", downloaded: true }] });
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import * as React from 'react'; import { createRoot } from 'react-dom/client';
    import { WandUiProvider } from './src/web-ui/react/theme'; import { installReactUiStyles } from './src/web-ui/react/styles';
    import { installSettingsLibraryStyles } from './src/web-ui/react/settings/styles';
    import { SpeechSettingsTab } from './src/web-ui/react/settings/speech-panel'; import { ComposerSpeechButton } from './src/web-ui/react/composer-voice/button';
    import { ComposerStore } from './src/web-ui/browser/composer';
    installReactUiStyles(); installSettingsLibraryStyles(); const store = new ComposerStore({storage:()=>localStorage,isUnloading:()=>false,disposeAttachment:()=>{}});
    function App(){const [key,setKey]=React.useState('one'),[hint,setHint]=React.useState('');
      const revision=()=>store.read(key).revision; React.useSyncExternalStore(store.subscribe.bind(store),revision,revision); const draft=store.read(key);
      return <WandUiProvider><div data-speech-composer><SpeechSettingsTab admin/><textarea aria-label="草稿" value={draft.text} onChange={e=>store.edit(key,{text:e.target.value})}/>
        <button id="switch" onClick={()=>setKey(key==='one'?'two':'one')}>切换</button><span id="hint">{hint}</span>
        <ComposerSpeechButton ownerKey={key} revision={draft.revision} onStatus={setHint} onCommit={(text,expectedRevision)=>store.edit(key,{text:draft.text+' '+text,expectedRevision,persist:true})}/></div></WandUiProvider>}
    createRoot(document.getElementById('root')).render(<App/>);` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith("/api/speech")) {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/speech/settings") { let body = ""; for await (const chunk of req) body += chunk; settings = JSON.parse(body); }
      if (req.url === "/api/speech/transcribe") {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); validateSpeechWav(Buffer.concat(chunks)); uploads += 1;
        if (delay) await new Promise(r => setTimeout(r, delay));
        res.end(JSON.stringify({ text: "浏览器录音转写", model: "base", backend: "cpu" })); return;
      }
      res.end(JSON.stringify(status())); return;
    }
    if (req.url === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(readFileSync(join(temp, "app.js"))); return; }
    if (req.url === "/styles.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); return; }
    res.setHeader("content-type", "text/html; charset=utf-8"); res.end('<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>body{margin:0}#root{max-width:840px;padding:16px;margin:auto}textarea{display:block;width:90%}</style><div id="root"></div><script src="/app.js"></script></html>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const chrome = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--user-data-dir=${temp}/profile`, "about:blank"], { stdio: "ignore" });
  let socket: WebSocket | undefined;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  try {
    const portFile = join(temp, "profile/DevToolsActivePort");
    for (let i = 0; i < 100 && !existsSync(portFile); i += 1) await sleep(50);
    assert.ok(existsSync(portFile), "Chrome did not start");
    const port = readFileSync(portFile, "utf8").split("\n")[0];
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    socket = new WebSocket(tabs.find(tab => tab.type === "page")!.webSocketDebuggerUrl); await once(socket, "open");
    let serial = 0; const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    const errors: string[] = [];
    socket.addEventListener("message", event => { const msg = JSON.parse(String(event.data)); if (msg.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(msg.params));
      const call = pending.get(msg.id); if (call) { pending.delete(msg.id); if (msg.error) call.reject(Error(JSON.stringify(msg.error))); else call.resolve(msg.result); } });
    const send = (method: string, params = {}) => new Promise<any>((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression: string) => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
    const wait = async (expression: string) => { for (let i = 0; i < 200; i += 1) { if (await evaluate(expression)) return; await sleep(30); } throw Error(`Missing ${expression}: ${await evaluate("document.body.innerText")}`); };
    const click = async (selector: string) => { const point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 }); };
    const hold = async (cancel: boolean | "restore" = false) => { const point = await evaluate(`(()=>{const n=document.querySelector('[aria-label="按住语音输入"]');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await wait("document.getElementById('hint').textContent.includes('正在聆听')"); await sleep(350);
      if (cancel) {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y - 80, buttons: 1 });
        await wait("document.getElementById('hint').textContent.includes('松开取消')");
      }
      if (cancel === "restore") {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, buttons: 1 });
        await wait("document.getElementById('hint').textContent.includes('正在聆听')");
      }
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: cancel === true ? point.y - 80 : point.y, button: "left", clickCount: 1 }); };
    await send("Runtime.enable"); await send("Page.enable"); await send("Page.navigate", { url: origin });
    await wait("document.getElementById('settings-speech-mode') && document.body.textContent.includes('运行时已安装')");
    for (const width of [1280, 390]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
      await sleep(250); assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }); writeFileSync(join(artifacts, `settings-${width}.png`), Buffer.from(shot.data, "base64"));
    }
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await click("#settings-speech-mode .wand-ui-select-trigger");
    await wait(`!!document.querySelector('.wand-ui-select-item[title="客户端本地识别"]')`);
    await click('.wand-ui-select-item[title="客户端本地识别"]');
    assert.equal(await evaluate("localStorage.getItem('wand.voiceRecognitionMode')"), "local");
    await click("#settings-speech-mode .wand-ui-select-trigger");
    await wait(`!!document.querySelector('.wand-ui-select-item[title="服务端识别"]')`);
    await click('.wand-ui-select-item[title="服务端识别"]');
    assert.equal(await evaluate("localStorage.getItem('wand.voiceRecognitionMode')"), "server");
    await hold(); await wait("document.querySelector('textarea').value.includes('浏览器录音转写')"); assert.equal(uploads, 1);
    await hold(true); await sleep(350); assert.equal(uploads, 1, "cancel uploaded audio");
    await wait("!!document.querySelector('[aria-label=\"按住语音输入\"]')");
    await hold("restore"); await wait("document.getElementById('hint').textContent === ''"); assert.equal(uploads, 2);
    delay = 600; await hold(); await wait("document.getElementById('hint').textContent.includes('服务端识别中')");
    await click("#switch"); await sleep(1000); assert.equal(await evaluate("document.querySelector('textarea').value"), "", "late result crossed owners");
    assert.deepEqual(errors, []);
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1000, deviceScaleFactor: 1, mobile: true });
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await evaluate("document.querySelector('textarea').blur();window.dispatchEvent(new Event('resize'))");
    await wait("document.querySelector('textarea').hasAttribute('data-idle-speech')");
    const inputPoint = async () => evaluate("(()=>{const n=document.querySelector('textarea');n.scrollIntoView({block:'center',behavior:'instant'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
    const touch = (type: string, point?: {x: number; y: number}) => send("Input.dispatchTouchEvent", { type, touchPoints: point ? [point] : [] });
    let point = await inputPoint();
    await touch("touchStart", point); await sleep(30); await touch("touchEnd");
    await wait("document.activeElement === document.querySelector('textarea')");
    assert.equal(await evaluate("document.querySelector('textarea').hasAttribute('data-idle-speech')"), false, "focused input stole editing gestures");
    await evaluate("document.querySelector('textarea').blur()");
    await wait("document.querySelector('textarea').hasAttribute('data-idle-speech')");
    const before = uploads; delay = 0; point = await inputPoint();
    await touch("touchStart", point); await wait("document.getElementById('hint').textContent.includes('正在聆听')");
    assert.equal(await evaluate("document.activeElement === document.querySelector('textarea')"), false, "hold summoned keyboard");
    await touch("touchMove", { x: point.x, y: point.y - 80 }); await touch("touchEnd"); await sleep(250);
    assert.equal(uploads, before, "idle-input cancel uploaded audio");
    point = await inputPoint(); await touch("touchStart", point); await wait("document.getElementById('hint').textContent.includes('正在聆听')");
    await sleep(350); await touch("touchEnd");
    await wait("document.querySelector('textarea').value.includes('浏览器录音转写')");
    assert.equal(uploads, before + 1);
    assert.equal(await evaluate("document.querySelector('textarea').hasAttribute('data-idle-speech')"), false, "nonempty input stole long-press selection");
    writeFileSync(join(artifacts, "evidence.json"), JSON.stringify({ actualBrowser: "Chrome headless", fakeMicrophone: true, mockServer: true, uploads, cases: ["desktop/narrow no overflow", "real MediaRecorder to canonical WAV", "cancel no upload", "cancel gesture reversal restores feedback", "mode selection persists through native library popup", "late result no cross-draft", "idle-input tap focuses", "idle-input hold avoids keyboard", "idle-input up-cancel sends nothing", "nonempty/focused native editing preserved"] }, null, 2));
  } finally { socket?.close(); const exited = once(chrome, "close"); chrome.kill(); await exited;
    await new Promise<void>(r => server.close(() => r())); rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});
