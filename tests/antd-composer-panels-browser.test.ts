// Real Chrome + production queue/todo/terminal/notice owners. Synthetic transport never sends to a service/model.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { cssEvidenceCapture } from "./helpers/antd-css-evidence.js";

const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const modes = ["desktop", "390px", "320px", "native-shell", "reactUi=0", "reduce-motion"];
export async function runPanels(matrix = modes, queueOnly = false) {
  const root = resolve(import.meta.dirname, "..");
  const directory = mkdtempSync(join(tmpdir(), "wand-panels-source-"));
  const result: any = { ok: false, evidence: "Real Chrome production adapters/native callbacks; local synthetic HTTP only; no installed service or device", cases: [], requests: [], errors: [], exceptions: [], dialogs: [] };
  let browser: ReturnType<typeof spawn> | undefined;
  let socket: WebSocket | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let queue: string[] = [];
  let editPlan: { error?: boolean; defer?: boolean } | null = null;
  const deferred: Array<() => void> = [];
  let evaluate: ((expression: string) => Promise<any>) | undefined;
  try {
    const bundle = join(directory, "app.js");
    await build({ entryPoints: [join(root, "tests/helpers/composer-panels-browser-harness.ts")], bundle: true,
      platform: "browser", format: "iife", jsx: "automatic", outfile: bundle, define: { "process.env.NODE_ENV": '"production"' } });
    server = createServer(async (request, response) => {
      const path = new URL(request.url!, "http://fixture.test").pathname;
      const files: Record<string, [string, string]> = { "/app.js": [bundle, "text/javascript"],
        "/styles.css": [join(root, "src/web-ui/content/styles.css"), "text/css"],
        "/tailwind.css": [join(root, "src/web-ui/content/tailwind.css"), "text/css"] };
      if (files[path]) { response.setHeader("Content-Type", files[path][1]); response.end(readFileSync(files[path][0])); return; }
      if (path.startsWith("/api/") || path.startsWith("/_fixture/")) {
        let raw = ""; for await (const chunk of request) raw += chunk;
        const body = raw ? JSON.parse(raw) : null;
        let payload: any = {};
        if (path === "/_fixture/queue") queue = body;
        else if (path === "/_fixture/edit-plan") editPlan = body;
        else if (path === "/_fixture/release") deferred.splice(0).forEach(reply => reply());
        else if (path === "/api/session-check") payload = { authed: false };
        else if (path.includes("/queued")) {
          const operation = { path, method: request.method, body, compact: request.headers["x-wand-tool-projection"] };
          result.requests.push(operation);
          const match = path.match(/\/queued\/(\d+)(\/promote)?$/);
          const plan = match && request.method === "DELETE" ? editPlan : null;
          if (plan) editPlan = null;
          if (plan?.error) {
            const reply = () => { response.writeHead(503, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "Synthetic edit failure" })); };
            if (plan.defer) deferred.push(reply); else reply(); return;
          }
          if (match && match[2]) { assert.equal(body.expectedText, queue[Number(match[1])]); queue.splice(Number(match[1]), 1); }
          else if (match && request.method === "DELETE") { assert.equal(body.expectedText, queue[Number(match[1])]); queue.splice(Number(match[1]), 1); }
          else if (match && request.method === "PATCH") { assert.equal(body.expectedText, queue[Number(match[1])]); queue[Number(match[1])] = body.text; }
          else if (request.method === "PATCH") queue = body.order.map((index: number) => queue[index]);
          else if (request.method === "DELETE") queue = [];
          payload = { id: "panels-A", queuedMessages: [...queue], status: "running", structuredState: { inFlight: true } };
          if (plan?.defer) {
            const captured = JSON.stringify(payload);
            deferred.push(() => { response.setHeader("Content-Type", "application/json"); response.end(captured); }); return;
          }
        } else if (path === "/api/sessions/panels-A") payload = { id: "panels-A", queuedMessages: [...queue], status: "running", sessionKind: "structured", messages: [], structuredState: { inFlight: true } };
        else if (path.endsWith("/input")) result.requests.push({ path, method: request.method, body, compact: request.headers["x-wand-tool-projection"] });
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(payload)); return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width,initial-scale=1"/><link rel="stylesheet" href="/tailwind.css"/><link rel="stylesheet" href="/styles.css"/>
        <style>#panels-source-host{display:flex;flex-direction:column;height:760px;width:100%;}#chat-output{display:flex;flex:1;min-height:0;}#app{height:120px;}</style>
        </head><body><script src="/app.js"></script></body></html>`);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    browser = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--disable-gpu", "--no-first-run",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${directory}/profile`, origin], { stdio: "ignore" });
    const portFile = join(directory, "profile/DevToolsActivePort");
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(50);
    assert.ok(existsSync(portFile), "Chrome must run; absence is a failure");
    const port = readFileSync(portFile, "utf8").split("\n")[0];
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket = new WebSocket(tabs.find((tab: any) => tab.type === "page" && tab.url.startsWith(origin)).webSocketDebuggerUrl); await once(socket, "open");
    let id = 0;
    const pending = new Map<number, any>();
    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolveSend, reject) => {
      const requestId = ++id; const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("CDP deadline: " + method)); }, 15000);
      pending.set(requestId, { resolve: resolveSend, reject, timer }); socket!.send(JSON.stringify({ id: requestId, method, params }));
    });
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") result.exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") result.errors.push(message.params.args.map((arg: any) => arg.value || arg.description).join(" "));
      if (message.method === "Page.javascriptDialogOpening") { result.dialogs.push({ type: message.params.type, message: message.params.message }); void send("Page.handleJavaScriptDialog", { accept: false }); }
      const waiting = pending.get(message.id); if (!waiting) return;
      pending.delete(message.id); clearTimeout(waiting.timer); message.error ? waiting.reject(new Error(JSON.stringify(message.error))) : waiting.resolve(message.result);
    });
    const captureCss = cssEvidenceCapture("composer-panels");
    evaluate = async expression => {
      const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description || answer.exceptionDetails.text);
      await captureCss(send); return answer.result.value;
    };
    const e = evaluate;
    const wait = async (expression: string, description: string) => {
      for (let i = 0; i < 150; i++) { if (await e(expression)) return; await sleep(20); }
      throw new Error("Condition not reached: " + description);
    };
    const waitRequests = async (count: number) => {
      for (let i = 0; i < 150 && result.requests.length < count; i++) await sleep(20);
      assert.ok(result.requests.length >= count, "native request reaches the local transport");
    };
    const point = async (selector: string) => {
      await e(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:"nearest"});void 0`);
      await e("p.frames()");
      return e(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing real control');const r=n.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);return {x,y,visible:r.width>0&&r.height>0,hit:n===hit||n.contains(hit),hitElement:hit?.outerHTML.slice(0,350),rect:r.toJSON()};})()`);
    };
    const click = async (selector: string) => {
      let position = await point(selector);
      // Ant retains an exiting mask briefly after retiring the controlled content.
      for (let i = 0; i < 100 && !(position.visible && position.hit); i++) { await sleep(20); position = await point(selector); }
      assert.equal(position.visible && position.hit, true, "visible hit-testable real control: " + selector + " " + JSON.stringify(position));
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: position.x, y: position.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: position.x, y: position.y, button: "left", clickCount: 1 });
      await e("p.frames()");
    };
    await send("Runtime.enable"); await send("Page.enable"); await wait("Boolean(window.composerPanels)", "production harness");
    for (const mode of matrix) {
      if (mode !== matrix[0]) {
        await e("window.__panelsNavigating=true;void 0");
        await send("Page.navigate", { url: origin + (mode === "reactUi=0" ? "/?reactUi=0" : "/") });
        await wait("!window.__panelsNavigating && Boolean(window.composerPanels)", "fresh production owners");
      }
      await send("Page.bringToFront");
      await send("Emulation.setDeviceMetricsOverride", { width: mode === "320px" ? 320 : mode === "390px" ? 390 : 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduce-motion" ? "reduce" : "no-preference" }] });
      await e(`document.documentElement.classList.toggle("is-wand-app",${mode === "native-shell"});window.p=window.composerPanels;void 0`);
      await e("window.startupDialogOutcome='pending';p.dialog('owned').then(value=>{window.startupDialogOutcome={value};});void 0");
      await wait("!!document.querySelector('[data-wand-owned-dialog-root] .wand-ui-dialog-content input')", "startup fallback owns a private portal");
      const startupPrivatePortal = await e("!document.getElementById('wand-react-ui-portals') && !window.__wandReactUi && document.querySelector('[data-wand-owned-dialog-root] .wand-ui-dialog-content input')?.value==='owned-layer-value'");
      assert.equal(startupPrivatePortal, true);
      await click(".wand-ui-dialog-actions .wand-ui-button-secondary");
      await wait("startupDialogOutcome?.value===null && !document.querySelector('[data-wand-owned-dialog-root]')", "startup fallback removes only its own root");
      assert.equal(await e("!document.getElementById('wand-react-ui-portals') && !window.__wandReactUi"), true);
      await e("p.setup()");
      const record = (name: string, facts: any) => result.cases.push({ mode, name, ...facts });
      const requestStart = result.requests.length;
      await e('p.queue(["alpha queue","beta queue","gamma queue"])');
      assert.equal(await e("document.querySelector('.composer-surface').contains(document.getElementById('queue-bar-host'))"), true);
      const queueSummary = await e(`(()=>{const q=document.querySelector('.queue-bar-toggle'),r=q.getBoundingClientRect();const others=['.composer-floating-avatar','.composer-usage-line','.composer-inline-config'].map(s=>document.querySelector(s)?.getBoundingClientRect()).filter(b=>b?.width&&b?.height);return {height:r.height,overlap:others.some(b=>r.left<b.right&&r.right>b.left&&r.top<b.bottom&&r.bottom>b.top),contained:r.left>=0&&r.right<=innerWidth};})()`);
      assert.equal(queueSummary.overlap, false, JSON.stringify(queueSummary));
      assert.ok(queueSummary.height <= 44); assert.equal(queueSummary.contained,true);
      record("bounded independent queue summary",queueSummary);
      const sendRect=await e("document.getElementById('send-input-button').getBoundingClientRect().toJSON()");
      await click('.queue-bar-toggle');
      await wait("!!document.getElementById('queue-work-panel')","portalled queue");
      const expandedRect=await e("document.getElementById('send-input-button').getBoundingClientRect().toJSON()");
      assert.ok(Math.abs(sendRect.y-expandedRect.y)<1);
      const queueStyle=await e("(()=>{const p=document.querySelector('#queue-work-panel .composer-work-panel');return {background:getComputedStyle(p).backgroundColor,portalled:!document.getElementById('queue-bar-host').contains(p)};})()");
      assert.notEqual(queueStyle.background,"rgba(0, 0, 0, 0)");assert.equal(queueStyle.portalled,true);
      record("opaque portalled panel with stable sender",queueStyle);
      await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
      await wait("!p.state.queueBarExpanded","queue Escape closes");
      assert.equal(await e("document.activeElement===document.querySelector('.queue-bar-toggle')"),true);
      await click('.queue-bar-toggle');await click('#input-box');await wait("!p.state.queueBarExpanded","outside closes queue");
      await click('.queue-bar-toggle');
      await click('.queue-bar-item[data-index="1"] [data-action="more"]');
      await click('.queue-extra-actions [data-action="delete"]');
      await wait('JSON.stringify(p.queueTexts())===JSON.stringify(["alpha queue","gamma queue"])',"confirmed deletion");
      await wait("p.composer.read(p.state.selectedId).queueRemoval?.status==='confirmed'","removal receipt");
      assert.equal(await e("p.composer.read(p.state.selectedId).queueRemoval.text"),"beta queue");
      await click('.queue-removal [data-action="dismiss-removed"]');
      record("removal retains recoverable original without auto-requeue",{queue:await e("p.queueTexts()")});
      await click('.queue-bar-item[data-index="0"] [data-action="edit"]');
      await wait('p.queueTexts()[0]==="gamma queue" && document.getElementById("input-box").value==="alpha queue"',"retrieve to draft");
      assert.equal(result.requests.at(-1).body.expectedText,"alpha queue");
      assert.equal(await e("document.querySelector('.wand-ui-dialog-content input')===null"),true);
      await e('p.queue(["alpha edited","gamma queue"])');await click('.queue-bar-toggle');
      const from=await point('.queue-bar-item[data-index="0"] .queue-drag-handle'),to=await point('.queue-bar-item[data-index="1"] .queue-bar-item-text');
      const beforeCancel = result.requests.length;
      await send("Input.dispatchMouseEvent",{type:"mousePressed",x:from.x,y:from.y,button:"left",clickCount:1});
      await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:from.x,y:to.y+5,button:"left",buttons:1});
      await e("(()=>{const d=p.state.queueBarDrag;d.handleEl.dispatchEvent(new PointerEvent('pointercancel',{pointerId:d.pointerId,bubbles:true}));})()");
      await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:from.x,y:to.y+5,button:"left",clickCount:1});
      assert.equal(await e("Boolean(p.state.queueBarDrag)"),false);
      assert.equal(result.requests.length,beforeCancel,"cancel does not submit a PATCH");
      assert.deepEqual(await e("p.queueTexts()"),["alpha edited","gamma queue"]);
      record("cancelled handle gesture never commits",{requests:0});
      await send("Input.dispatchMouseEvent",{type:"mousePressed",x:from.x,y:from.y,button:"left",clickCount:1});
      assert.equal(await e("Boolean(p.state.queueBarDrag)"),true);
      await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:from.x,y:to.y+5,button:"left",buttons:1});
      await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:from.x,y:to.y+5,button:"left",clickCount:1});
      await wait('JSON.stringify(p.queueTexts())===JSON.stringify(["gamma queue","alpha edited"])',"real pointer reorder");
      await click('.queue-bar-item[data-index="1"] [data-action="request-promote"]');
      assert.equal(await e("p.queueTexts().length"),2,"no interrupt before confirmation");
      await click('[data-action="confirm-queue"]');
      await wait('p.state.queueBarPromoting===false && JSON.stringify(p.queueTexts())===JSON.stringify(["gamma queue"])',"promote confirmed");
      const promote=result.requests.at(-1);assert.equal(promote.body.expectedText,"alpha edited");assert.ok(promote.body.idempotencyKey);
      await e('p.queue(["clear one","clear two"])');
      if(!await e("p.state.queueBarExpanded"))await click('.queue-bar-toggle');
      await click('[data-action="request-clear"]');await click('[data-action="confirm-queue"]');
      await wait("p.queueTexts().length===0 && p.composer.read(p.state.selectedId).queueRemoval?.status==='confirmed'","clear retains recovery");
      assert.equal(await e("document.getElementById('queue-bar-host').hidden"),false);
      await click('.queue-removal [data-action="dismiss-removed"]');
      await wait("document.getElementById('queue-bar-host').hidden","dismiss recovery retires empty queue");
      const queueOperations=result.requests.slice(requestStart);
      assert.deepEqual(queueOperations.map((op:any)=>op.method),["DELETE","DELETE","PATCH","POST","DELETE"]);
      record("queue actions once with confirmation and durable recovery",{count:queueOperations.length});

      const longQueued = "长消息保留完整换行与代码路径。\n".repeat(12) + "全文末尾不可丢失";
      await e(`p.queue([${JSON.stringify(longQueued)},"短消息"])`);
      if (!await e("p.state.queueBarExpanded")) await click('.queue-bar-toggle');
      const textHeight=await e("document.querySelector('.queue-bar-item-text').clientHeight");
      assert.equal(textHeight,44,"long queue preview is two lines");
      const densitySendRect=await e("document.getElementById('send-input-button').getBoundingClientRect().toJSON()");
      await click('.queue-bar-item[data-index="0"] button[aria-controls]');
      assert.equal(await e("document.querySelector('.queue-bar-item-text').dataset.full"),"true");
      assert.equal(await e("document.querySelector('.queue-bar-item-text > p').textContent"),longQueued,"expanded text keeps every original newline and the full ending");
      assert.ok(await e("document.querySelector('.queue-bar-item-text').clientHeight>44"));
      assert.deepEqual(await e("document.getElementById('send-input-button').getBoundingClientRect().toJSON()"),densitySendRect);
      await click('.queue-bar-item[data-index="0"] button[aria-controls]');
      assert.equal(await e("document.querySelector('.queue-bar-item-text').clientHeight"),44);
      const density=await e("(()=>{const panel=document.querySelector('.composer-queue-panel').getBoundingClientRect();const buttons=[...document.querySelectorAll('.composer-queue-panel .queue-icon-action,.composer-queue-panel .queue-drag-handle')].map(n=>{const r=n.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right};});return {panel:panel.toJSON(),buttons};})()");
      assert.ok(density.panel.left>=0 && density.panel.right<= (mode==='320px'?320:mode==='390px'?390:1280));
      if(mode==='320px'||mode==='390px')for(const b of density.buttons){assert.ok(b.width>=44&&b.height>=44);assert.ok(b.left>=0&&b.right<=(mode==='320px'?320:390));}
      const bodyPoint=await point('.queue-bar-item[data-index="1"] .queue-bar-item-text');
      await send("Input.dispatchMouseEvent",{type:"mousePressed",x:bodyPoint.rect.left+2,y:bodyPoint.y,button:"left",clickCount:1});
      await send("Input.dispatchMouseEvent",{type:"mouseMoved",x:bodyPoint.rect.left+42,y:bodyPoint.y,button:"left",buttons:1});
      await send("Input.dispatchMouseEvent",{type:"mouseReleased",x:bodyPoint.rect.left+42,y:bodyPoint.y,button:"left",clickCount:1});
      assert.equal(await e("Boolean(p.state.queueBarDrag)"),false,"body selection never starts dragging");
      assert.ok(await e("getSelection().toString().length>0"),"real body text selection remains usable");
      record("density preserves full text, narrow targets and body selection",density);
      if(process.env.WAND_QUEUE_SCREENSHOTS) {
        const capture=resolve(process.env.WAND_QUEUE_SCREENSHOTS,`queue-${mode.replace(/[^a-z0-9-]/gi,'-')}.png`);
        mkdirSync(dirname(capture),{recursive:true});
        writeFileSync(capture,Buffer.from((await send("Page.captureScreenshot",{format:"png"})).data,"base64"));
      }
      if(mode==='320px'||mode==='390px') {
        const retainedText="保留原文".repeat(12);
        await e(`(()=>{const token=p.composer.beginQueueRemoval('panels-A',[${JSON.stringify(retainedText)}]);p.composer.finishQueueRemoval('panels-A',token,'confirmed');})()`);
        await e('p.queue(["短消息"])');
        await click('.queue-removal .composer-work-read-more');
        assert.equal(await e("document.querySelector('.queue-removal .composer-work-text').dataset.full"),"true");
        await click('.queue-removal [data-action="dismiss-removed"]');
        record("retained original under sixty characters still expands when actually clipped",{length:retainedText.length});
      }

      const cancelEdit = () => click(".wand-ui-dialog-actions .wand-ui-button-secondary");
      const configureEdit = (plan: any) => e(`fetch('/_fixture/edit-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(plan))}}).then(()=>undefined)`);
      const releaseEdit = () => e("fetch('/_fixture/release',{method:'POST'}).then(()=>undefined)");
      const expandQueue = async () => {
        if (!await e("p.state.queueBarExpanded")) await click(".queue-bar-toggle");
        await e("p.frames()");
      };
      await e('p.composer.edit("panels-A",{text:"existing draft"});p.composer.edit("panels-A",{addAttachment:{name:"draft.png",size:3,file:new File(["png"],"draft.png")}});p.queue(["edit original","keep other"])');
      await expandQueue();
      await configureEdit({ defer: true });
      const untouched = result.requests.length;
      const replies = await e("p.stats.queueReplies");
      await click('.queue-bar-item[data-index="0"] [data-action="edit"]');
      await waitRequests(untouched + 1);
      assert.equal(await e('p.composer.read("panels-A").text'), "existing draft", "not filled before server confirms removal");
      await e('p.composer.edit("panels-A",{text:"new typing while taking"});void 0');
      await releaseEdit(); await wait(`p.stats.queueReplies>${replies}`, "retrieve confirmation");
      await wait('p.composer.read("panels-A").text==="new typing while taking\\n\\nedit original"', "merge into latest text");
      assert.equal(await e('p.composer.read("panels-A").attachments[0].name'), "draft.png");
      record("retrieve confirms then merges latest draft and attachments", { oldDraftNotOverwritten: true, attachmentsKept: true });

      await e('p.queue(["owner original","keep other"])'); await expandQueue();
      await configureEdit({ defer: true });
      const lateReplies = await e("p.stats.queueReplies");
      await click('.queue-bar-item[data-index="0"] [data-action="edit"]');
      await waitRequests(untouched + 2);
      await e('p.switchFixture("panels-B",["other session queue"]);p.serverQueue(["newer B queue"])');
      const newOwner = await e('p.composer.read("panels-B")');
      await releaseEdit(); await wait(`p.stats.queueReplies>${lateReplies}`, "late owner reply"); await e("p.frames()");
      assert.equal(await e('p.composer.read("panels-B").revision'), newOwner.revision);
      assert.equal(await e('p.composer.read("panels-B").text'), newOwner.text);
      assert.ok((await e('p.composer.read("panels-A").text')).includes("owner original"));
      record("late retrieve belongs only to original session", { newDraftKept: true, originalDraftRecovered: true });

      await e('p.switchFixture("panels-A",[]);p.queue(["older original","keep other"])'); await expandQueue();
      await configureEdit({ defer: true });
      const epochReplies = await e("p.stats.queueReplies");
      await click('.queue-bar-item[data-index="0"] [data-action="edit"]');
      await waitRequests(untouched + 3);
      await e('p.serverQueue(["newer websocket item","keep other"])');
      await releaseEdit(); await wait(`p.stats.queueReplies>${epochReplies}`, "late accepted removal"); await e("p.frames()");
      assert.deepEqual(await e("p.queueTexts()"), ["newer websocket item", "keep other"]);
      record("late accepted take cannot undo newer websocket queue", { newerQueueKept: true });

      await e('p.queue(["unknown original","keep other"])'); await expandQueue();
      await configureEdit({ error: true, defer: true });
      const failedReplies = await e("p.stats.queueReplies");
      const beforeUnknown = await e('p.composer.read("panels-A").text');
      await click('.queue-bar-item[data-index="0"] [data-action="edit"]');
      await waitRequests(untouched + 4);
      await releaseEdit(); await wait(`p.stats.queueReplies>${failedReplies}`, "unknown removal response"); await e("p.frames()");
      assert.equal(await e('p.composer.read("panels-A").text'), beforeUnknown);
      assert.equal(await e('p.composer.read("panels-A").queueRetrieval.status'), "unknown");
      assert.equal(await e('document.querySelector(".queue-retrieval").textContent.includes("unknown original")'), true);
      assert.equal(result.requests.length, untouched + 4, "unknown removal never retries");
      assert.equal(await e("!!document.querySelector('.wand-ui-dialog-content input')"), false);
      await click('[data-action="dismiss-retrieved"]');
      record("unknown take keeps copyable original and never resends", { requests: 1, draftKept: true, originalKept: true });

      await e('p.queue(["IME original"])'); await expandQueue();
      await configureEdit({ defer: true });
      const imeReplies = await e("p.stats.queueReplies");
      await click('.queue-bar-item[data-index="0"] [data-action="edit"]');
      await waitRequests(untouched + 5);
      await e('p.state.composerComposing=true;p.composer.edit("panels-A",{text:"候选输入"});document.getElementById("input-box").value="候选输入";void 0');
      await releaseEdit(); await wait(`p.stats.queueReplies>${imeReplies}`, "receipt during composition"); await e("p.frames()");
      assert.equal(await e('document.getElementById("input-box").value'), "候选输入");
      assert.equal(await e('p.composer.read("panels-A").queueRetrieval.status'), "confirmed");
      await e('p.state.composerComposing=false;p.composer.edit("panels-A",{text:"中文"});void 0');
      await click('[data-action="restore-retrieved"]');
      assert.equal(await e('document.getElementById("input-box").value'), "中文\n\nIME original");
      record("confirmed retrieve defers active composition and merges only on request", { bufferKept: true });

      await e("window.savedGeneric=window.__wandReactUi;window.portalBefore=document.getElementById('wand-react-ui-portals');window.portalToast=p.rawOverlay.toast('Owned portal lease',{duration:0});window.__wandReactUi={dialog(options){p.rawOverlay.dialog(options);throw Error('Synthetic bridge failure after publish')},toast(){},closeTopmost(){return false}};window.dialogOutcome='pending';p.dialog('owned').then(value=>{window.dialogOutcome={value};});void 0");
      const ownedInput = '.wand-ui-dialog-content input[aria-label="Owned fallback layer probe"]';
      const ownedCancel = '.wand-ui-dialog-content:has(input[aria-label="Owned fallback layer probe"]) .wand-ui-button-secondary';
      await wait(`document.querySelectorAll('[data-wand-owned-dialog-root]').length===1 && !!document.querySelector(${JSON.stringify(ownedInput)})`, "one owned fallback for throwing bridge");
      await e("p.frames()");
      assert.equal(await e("Array.from(document.querySelectorAll('[role=dialog]')).filter(node=>node.getClientRects().length>0).length"), 1);
      assert.equal(await e(`(()=>{const input=document.querySelector(${JSON.stringify(ownedInput)});return input?.value==='owned-layer-value' && input.closest('.ant-modal-root')?.parentElement===portalBefore && !document.querySelector('[data-wand-owned-dialog-root] .wand-ui-portals');})()`), true, "independent root reuses the Shell portal for its current request");
      await e("window.__wandReactRestartOverlay.showRestart('fixture-old-instance','99.99.99');void 0");
      await wait("!!document.querySelector('.wand-restart-surface')", "restart covers the owned request");
      await e("p.frames()");
      const guardedCancel = await point(ownedCancel);
      assert.equal(guardedCancel.hit, false, "restart masks the owned dialog control");
      assert.equal(await e(`document.elementFromPoint(${guardedCancel.x},${guardedCancel.y})?.closest('.ant-modal-root')?.querySelector('.wand-restart-surface')!=null`), true, "the actual blocker belongs to restart");
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: guardedCancel.x, y: guardedCancel.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: guardedCancel.x, y: guardedCancel.y, button: "left", clickCount: 1 });
      await e("p.frames()");
      assert.equal(await e("dialogOutcome"), "pending", "real pointer cannot reach the owned action under restart");
      assert.equal(await e("window.handleNativeBack()"), true);
      assert.equal(await e("dialogOutcome"), "pending", "restart consumes native back before the owned dialog");
      await e("window.__wandReactRestartOverlay.dispose();void 0");
      await e("p.frames()");
      assert.equal(await e("window.handleNativeBack()"), true);
      await wait("dialogOutcome?.value===null && !document.querySelector('[data-wand-owned-dialog-root]')", "native back cancels independent fallback");
      assert.equal(await e("portalBefore.isConnected && document.getElementById('wand-react-ui-portals')===portalBefore && Array.from(document.querySelectorAll('.ant-notification-notice')).some(node=>node.textContent.includes('Owned portal lease'))"), true, "owned unmount preserves shared portal and its unrelated notice");
      const ownedNoticeClose = ".ant-notification-notice-info .ant-notification-notice-close";
      assert.equal(await e(`document.querySelectorAll(${JSON.stringify(ownedNoticeClose)}).length`), 1, "the owned notice has one real close action even while previous warnings remain");
      await click(ownedNoticeClose);
      await wait("!Array.from(document.querySelectorAll('.ant-notification-notice')).some(node=>node.textContent.includes('Owned portal lease'))", "the preserved shared notice remains interactive");
      await e("window.__wandReactUi.dialog=options=>{p.rawOverlay.dialog(options);return Promise.reject(Error('Synthetic async bridge failure'));};window.dialogOutcome='pending';p.dialog('owned').then(value=>{window.dialogOutcome={value};});void 0");
      await wait(`document.querySelectorAll('[data-wand-owned-dialog-root]').length===1 && !!document.querySelector(${JSON.stringify(ownedInput)})`, "one fallback after rejected published request");
      await e("p.frames()"); assert.equal(await e("Array.from(document.querySelectorAll('[role=dialog]')).filter(node=>node.getClientRects().length>0).length"), 1); await cancelEdit();
      await wait("dialogOutcome?.value===null && !document.querySelector('[data-wand-owned-dialog-root]')", "async fallback cancellation");
      await e("window.dialogOutcome='pending';p.dialog('guarded').then(value=>{window.dialogOutcome={value};});void 0");
      await wait("!!document.querySelector('.wand-ui-dialog-actions')", "guarded fallback");
      assert.equal(await e("window.handleNativeBack()"), true); assert.equal(await e("!!document.querySelector('.wand-ui-dialog-actions')"), true, "guard consumes back without dismissal");
      await click(".wand-ui-dialog-actions .wand-ui-button-primary");
      await wait("dialogOutcome?.value===true && !document.querySelector('[data-wand-owned-dialog-root]')", "guarded confirmation still accepts");
      await e("if(savedGeneric)window.__wandReactUi=savedGeneric;else delete window.__wandReactUi;void 0");
      record("throwing bridge opens one independent fallback with back handling", { nativeDialogs: result.dialogs.length, duplicateDialogs: 0, guardedBack: true, failuresAfterPublish: 2,
        startupPrivatePortal, sharedPortal: true, sharedNoticeInteractive: true, restartMasksOwned: true, restartBlocksRealPointer: true });

      await e("window.dialogOutcome='pending';p.dialog('confirm').then(value=>{window.dialogOutcome={value};});void 0");
      await wait("!!document.querySelector('.wand-ui-dialog-actions')", "generic confirmation"); await cancelEdit();
      await wait("dialogOutcome?.value===false", "confirmation cancel semantics");
      await e("window.dialogOutcome='pending';p.dialog('alert').then(()=>{window.dialogOutcome='accepted';});void 0");
      await wait("!!document.querySelector('.wand-ui-dialog-actions')", "generic alert");
      await click(".wand-ui-dialog-actions .wand-ui-button-primary"); await wait("dialogOutcome==='accepted'", "alert acceptance semantics");
      assert.equal(await e("Boolean(window.__wandReactUi)"), mode !== "reactUi=0", "rollback retains the disabled generic bridge");
      record("generic confirm and alert remain application dialogs in rollback", { confirmCancelled: true, alertAccepted: true, bridgeEnabled: mode !== "reactUi=0" });
      await e("p.queue([])");
      await e("p.resetDraft();p.frames()");

      await e('p.todos([{content:"Done",status:"completed"},{content:"Working",activeForm:"正在处理",status:"in_progress"},{content:"Pending",status:"pending"}]);p.queue(["A very long pending message ".repeat(30),"Second pending message"])');
      const shared=await e(`(()=>{const t=document.getElementById('todo-progress-toggle').getBoundingClientRect(),q=document.querySelector('.queue-bar-toggle').getBoundingClientRect(),c=document.querySelector('.composer-inline-config').getBoundingClientRect();const overlaps=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;return {overlap:overlaps(t,q),runtimeOverlap:overlaps(t,c),contained:q.left>=0&&q.right<=innerWidth,sameRow:Math.abs(t.top-q.top)<1,equalWidth:Math.abs(t.width-q.width)<1};})()`);
      assert.deepEqual(shared,{overlap:false,runtimeOverlap:false,contained:true,sameRow:true,equalWidth:true});record("Todo and queue stay in the same half-width row",shared);
      const boundary = await e(`(()=>{const top=document.querySelector('.composer-top-row').getBoundingClientRect(),divider=document.querySelector('.composer-input-divider').getBoundingClientRect(),editor=document.querySelector('.composer-main-row').getBoundingClientRect(),surface=document.querySelector('.composer-surface');return {summaryBottom:top.bottom,dividerTop:divider.top,dividerBottom:divider.bottom,dividerHeight:divider.height,editorTop:editor.top,outerBorder:getComputedStyle(surface).borderTopWidth,outerFocusLine:getComputedStyle(surface,'::before').content};})()`);
      assert.ok(boundary.summaryBottom <= boundary.dividerTop, "Todo and queue must be above the input boundary: " + JSON.stringify(boundary));
      assert.ok(boundary.dividerBottom <= boundary.editorTop, "editor and send controls belong below the boundary");
      assert.equal(boundary.dividerHeight, 1);
      assert.equal(boundary.outerBorder, "0px", "outer shell must not draw a second line above the summaries");
      assert.ok(["none", "normal"].includes(boundary.outerFocusLine));
      record("summary above divider and editor below", boundary);
      assert.equal(await e("document.querySelector('#todo-progress-toggle .composer-work-count').textContent"),"1/3");
      assert.equal(await e("document.querySelector('#todo-progress-toggle .composer-work-preview').textContent"),"正在处理");
      const panelHeight=await e("document.querySelector('.input-panel').getBoundingClientRect().height");
      const padding=await e("document.querySelector('.chat-messages').style.paddingBottom");
      await click("#todo-progress-toggle");await wait("!!document.getElementById('todo-progress-body')","Todo portal");
      assert.equal(await e("document.querySelector('.input-panel').getBoundingClientRect().height"),panelHeight);
      assert.equal(await e("document.querySelector('.chat-messages').style.paddingBottom"),padding,"opening details does not shift reading");
      const progress=await e(`(()=>{const b=document.getElementById('todo-progress-body');return {count:b.querySelectorAll('.composer-todo-list li').length,current:b.querySelector('[aria-current=step]')?.textContent,linear:b.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow'),background:getComputedStyle(b.querySelector('.composer-work-panel')).backgroundColor};})()`);
      assert.equal(progress.count,3);assert.match(progress.current,/Working/);assert.equal(progress.linear,undefined,"Todo count and row states replace the redundant progress bar");assert.notEqual(progress.background,"rgba(0, 0, 0, 0)");
      record("Todo states and opaque progress panel",progress);
      await click("#todo-progress-list li");assert.equal(await e("document.getElementById('todo-progress-toggle').getAttribute('aria-expanded')"),"true");
      await click(".queue-bar-toggle");await wait("document.getElementById('todo-progress-toggle').getAttribute('aria-expanded')==='false'","mutually exclusive panels");
      await click("#input-box");await wait("!p.state.queueBarExpanded","outside closes queue");
      await click("#todo-progress-toggle");
      await send("Input.dispatchKeyEvent",{type:"rawKeyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
      await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
      await wait("document.getElementById('todo-progress-toggle').getAttribute('aria-expanded')==='false'","Todo Escape");
      assert.equal(await e("document.activeElement===document.getElementById('todo-progress-toggle')"),true);
      const todoBounds = await e(`(()=>{const rect=(s)=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};return {todo:rect('#todo-progress-toggle'),queue:rect('.queue-bar-toggle')};})()`);
      for (const [kind, expected] of [["stopped","已停止"],["waiting","等待输入"],["permission","等待授权"],["failed","执行失败"],["done","本轮已结束"],["unknown","最近记录"]]) {
        await e("p.todoStatus('running');p.frames()");
        await e(`p.todoStatus(${JSON.stringify(kind)})`);
        assert.equal(await e("document.getElementById('todo-progress').classList.contains('hidden')"), false);
        assert.deepEqual(await e(`(()=>{const rect=(s)=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};return {todo:rect('#todo-progress-toggle'),queue:rect('.queue-bar-toggle')};})()`), todoBounds, "Todo lifecycle must not resize/reposition either half lane");
        await click("#todo-progress-toggle"); await wait("!!document.getElementById('todo-progress-body')", "read-only Todo details");
        const history = await e(`(()=>{const b=document.getElementById('todo-progress-body');return {text:b.innerText,current:b.querySelector('[aria-current=step]')!==null,kind:b.querySelector('[data-execution]')?.getAttribute('data-execution')};})()`);
        assert.ok(history.text.includes(expected)); assert.equal(history.current,false); assert.ok(!history.text.includes("进行中")); assert.ok(history.text.includes("最后记录"));
        assert.equal(await e("document.querySelector('#todo-progress-toggle .composer-work-count').textContent"),"1/3");
        await send("Input.dispatchKeyEvent",{type:"rawKeyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
        await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
        await wait("document.getElementById('todo-progress-toggle').getAttribute('aria-expanded')==='false'","history Escape");
      }
      await click("#todo-progress-toggle"); await e("p.todoStatus('newturn')");
      assert.equal(await e("document.getElementById('todo-progress').classList.contains('hidden')"),true);
      assert.equal(await e("document.querySelector('#todo-progress-toggle')?.getAttribute('aria-expanded')==='true'"),false);
      record("Todo lifecycle retains read-only progress and clears on accepted new input; queue half is unchanged", { states:6 });
      await e('p.todos([{content:"Next pending",status:"pending"},{content:"Later",status:"pending"}]);p.todoContext()');
      const lanes=await e(`(()=>{const t=document.getElementById('todo-progress-toggle').getBoundingClientRect(),u=document.querySelector('.composer-usage-line').getBoundingClientRect(),c=document.querySelector('.composer-inline-config').getBoundingClientRect();const overlap=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;return {usage:overlap(t,u),runtime:overlap(t,c)};})()`);
      assert.deepEqual(lanes,{usage:false,runtime:false});record("long runtime and identity do not collide",lanes);
      await e('p.todos([{content:"Done",status:"completed"}])');
      assert.equal(await e("document.querySelector('#todo-progress-toggle .composer-work-count').textContent"),"1/1","completed state remains inspectable during current running turn");
      await e("p.todos(null)");assert.equal(await e("document.getElementById('todo-progress').classList.contains('hidden')"),true);
      record("Todo dismissal, complete and new-turn states",{completeVisible:true,newTurnHidden:true});

      if (queueOnly) continue;
      await e("p.terminal()");
      if (await e("document.querySelector('.input-composer').hasAttribute('data-pty-collapsed')")) await click('.pty-dock-toggle');
      assert.equal(await e("document.querySelectorAll('.wand-joystick-root').length"), 0);
      const row = await e(`(()=>{const h=document.getElementById('terminal-shortcuts'),r=h.getBoundingClientRect();return {count:document.querySelectorAll('#terminal-shortcuts').length,inputHidden:document.getElementById('input-box').closest('.composer-input-wrap').inert,singleLine:new Set([...h.querySelectorAll('[data-terminal-key]:not([hidden])')].map(b=>b.getBoundingClientRect().top)).size===1,contained:r.left>=0&&r.right<=innerWidth,scrollable:h.scrollWidth>h.clientWidth};})()`);
      assert.equal(row.count, 1); assert.equal(row.inputHidden, true); assert.equal(row.singleLine, true); assert.equal(row.contained, true); assert.equal(row.scrollable,false);
      const terminalStart = result.requests.length;
      const keys = ["enter", "up", "down", "left", "right", "escape", "tab", "ctrl_c", "home", "end"];
      for (const key of keys) {
        if (await e(`document.querySelector('[data-terminal-key="${key}"]').hidden`)) {
          await click(".pty-extra-keys-trigger"); await click(`[data-extra-terminal-key="${key}"]`);
        } else await click(`[data-terminal-key="${key}"]`);
        await wait("p.state.messageQueue.length===0", "PTY key transport settled");
        assert.equal(await e("document.querySelector('.input-composer').dataset.ptyInputMode"), "shortcuts", "a shortcut does not open the keyboard");
      }
      const inputs = result.requests.slice(terminalStart).filter((operation: any) => operation.path.endsWith("/input"));
      assert.deepEqual(inputs.map((operation: any) => operation.body.shortcutKey), keys.map(key => key === "enter" ? "enter_text" : key));
      assert.deepEqual(inputs.map((operation: any) => operation.body.input), ["\r", "\u001b[A", "\u001b[B", "\u001b[D", "\u001b[C", "\u001b", "\t", "\u0003", "\u001b[H", "\u001b[F"]);
      assert.ok(inputs.every((operation: any) => operation.body.view === "terminal"));
      record("PTY shortcuts stay in one input row and dispatch once without stealing focus", { ...row, keys });

      // Actual keyboard input uses the production input/IME handlers, not the shortcut callback.
      await click(".pty-input-mode-toggle"); await click("#input-box");
      const typingStart = result.requests.length;
      await send("Input.insertText", { text: "a" });
      await wait("p.state.messageQueue.length===0 && document.getElementById('input-box').value===''", "direct typing drained");
      await send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
      await e("p.frames()");
      assert.deepEqual(result.requests.slice(typingStart).filter((op: any) => op.path.endsWith("/input")).map((op: any) => op.body.input), ["a"], "IME partial text is never sent");
      await send("Input.insertText", { text: "你" });
      await wait("!p.state.composerComposing && p.state.messageQueue.length===0", "IME committed");
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await wait("p.state.messageQueue.length===0", "physical Enter settled");
      const typed = result.requests.slice(typingStart).filter((op: any) => op.path.endsWith("/input")).map((op: any) => op.body.input);
      assert.deepEqual(typed, ["a", "你", "\r"]);
      // Shortcut buttons remain keyboard accessible without leaking a second key to the PTY.
      await click(".pty-input-mode-toggle");
      if (await e("document.querySelector('[data-terminal-key=tab]').hidden")) {
        await click(".pty-extra-keys-trigger"); await e("document.querySelector('[data-extra-terminal-key=tab]').focus()");
      } else await e("document.querySelector('[data-terminal-key=tab]').focus()");
      await e("document.addEventListener('keydown',p.captureTerminalInput,true)");
      const keyboardStart = result.requests.length;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await wait("p.state.messageQueue.length===0", "keyboard shortcut activation settled");
      assert.deepEqual(result.requests.slice(keyboardStart).filter((op: any) => op.path.endsWith("/input")).map((op: any) => op.body.input), ["\t"]);
      await e("document.removeEventListener('keydown',p.captureTerminalInput,true)");
      record("PTY keyboard passthrough and IME remain single delivery", { typed, keyboardActivation: true });

      // A native touch tap keeps the shortcut view and does not summon the keyboard.
      await send("Emulation.setTouchEmulationEnabled", { enabled: true });
      const extraEscape = await e("document.querySelector('[data-terminal-key=escape]').hidden");
      if (extraEscape) await click(".pty-extra-keys-trigger");
      const touch = await point(extraEscape ? '[data-extra-terminal-key="escape"]' : '[data-terminal-key="escape"]');
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touch.x, y: touch.y }] });
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await e("p.frames()");
      assert.equal(await e("document.querySelector('.input-composer').dataset.ptyInputMode"), "shortcuts");
      await send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await wait("p.state.messageQueue.length===0", "touch shortcut settled");

      // Enter with pending text is two packets even if the user switches sessions before it drains.
      const splitStart = result.requests.length;
      await e("p.state.inputQueue=new Promise(resolve=>window.releasePtyInput=resolve);document.getElementById('input-box').value='held text'");
      await click('[data-terminal-key="enter"]');
      await e("p.state.sessions.push({...p.state.sessions[0],id:'panels-other'});p.state.selectedId='panels-other';window.releasePtyInput()");
      await wait("p.state.messageQueue.length===0", "captured-session submission settled");
      const split = result.requests.slice(splitStart).filter((op: any) => op.path.endsWith("/input"));
      assert.deepEqual(split.map((op: any) => op.body.input), ["held text", "\r"]);
      assert.ok(split.every((op: any) => op.path === "/api/sessions/panels-A/input"));
      await e("p.state.selectedId='panels-A'");
      record("touch focus and two-packet Enter preserve session ownership", { touchFocus: true, twoPackets: true, sessionBound: true });

      await e("p.state.sessions[0].sessionKind='structured';p.updateTerminalShortcuts()");
      assert.equal(await e("document.getElementById('terminal-shortcuts').hidden"), true);
      await e("p.state.sessions[0].sessionKind='pty';p.state.sessions[0].status='exited';p.updateTerminalShortcuts()");
      assert.equal(await e("[...document.querySelectorAll('[data-terminal-key]')].every(b=>b.disabled)"), true);
      await e("p.state.sessions[0].status='running';document.documentElement.classList.add('is-wand-native-input');p.updateTerminalShortcuts()");
      assert.equal(await e("document.getElementById('terminal-shortcuts').hidden"), true);
      await e("document.documentElement.classList.remove('is-wand-native-input');p.state.selectedId=null;p.updateTerminalShortcuts()");
      assert.equal(await e("document.getElementById('terminal-shortcuts').hidden"), true);
      await e("p.state.selectedId='panels-A';p.updateTerminalShortcuts()");
      assert.equal(await e("document.querySelectorAll('[data-terminal-key]').length"), 14);
      record("structured, absent, stopped and native-input sessions stay guarded", { guarded: true });

      await e("p.notification(false);void 0"); await click(".notification-bubble-close");
      await wait("!document.querySelector('.notification-bubble')", "notification close removes mounted root");
      await e("p.notification(true);void 0"); await click(".notification-bubble-actions button");
      await wait("p.stats.actions===1 && !document.querySelector('.notification-bubble')", "notification one action and dismiss");
      await e("p.offline(true)"); assert.equal(await e("document.querySelectorAll('#offline-banner .ant-alert').length"), 1);
      await e("p.offline(false)"); assert.equal(await e("document.querySelectorAll('#offline-banner').length"), 0);
      const boot = await e("p.bootToLogin()"); assert.deepEqual(boot, { oldConnected: false, bootCount: 0, passwords: 1 });
      assert.deepEqual(await e("p.bootToLogin()"), boot, "cleared boot root can mount again and transition to login");
      record("notice close/action/offline and boot root cleanup", { actionCount: 1, boot });
      record("mode state", await e("({width:innerWidth,native:document.documentElement.classList.contains('is-wand-app'),rollback:location.search.includes('reactUi=0'),reduced:matchMedia('(prefers-reduced-motion:reduce)').matches})"));
    }
    assert.deepEqual(result.dialogs, [], "no native alert/confirm/prompt is opened");
    assert.deepEqual(result.exceptions, []); assert.deepEqual(result.errors, []); result.ok = true;
  } catch (error) {
    result.failure = String(error); if (evaluate) try { result.diagnostic = await evaluate("({active:document.activeElement?.outerHTML,queue:window.p?.queueTexts(),todo:document.getElementById('todo-progress-body')?.outerHTML,shortcuts:document.getElementById('terminal-shortcuts')?.outerHTML})"); } catch {}
    throw error;
  } finally {
    const output = resolve(root, "output/web-ui-library-migration/composer-panels/browser.json");
    mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2));
    socket?.close();
    if (browser && browser.exitCode === null) { browser.kill("SIGKILL"); await once(browser, "exit"); }
    deferred.splice(0).forEach(reply => reply()); server?.closeAllConnections();
    await new Promise<void>(done => server ? server.close(() => done()) : done());
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return result;
}

// Includes density, text-selection and cancelled-handle cases in all six modes.
test("pending-message summary stays above the input divider and preserves queue actions in six Chrome modes", { timeout: 480000, skip: process.env.WAND_QUEUE_BROWSER !== "1" }, async () => {
  assert.equal((await runPanels(modes, true)).ok, true);
});

test("Ant composer panels preserve native queue, Todo, terminal and notice actions in six Chrome modes", { timeout: 360000, skip: process.env.WAND_CHAT_BROWSER !== "1" }, async () => {
  assert.equal((await runPanels()).ok, true);
});
