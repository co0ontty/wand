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
const modes = ["desktop", "390px", "native-shell", "reactUi=0", "reduce-motion"];
export async function runPanels(matrix = modes) {
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
          const plan = match && request.method === "PATCH" ? editPlan : null;
          if (plan) editPlan = null;
          if (plan?.error) {
            const reply = () => { response.writeHead(503, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "Synthetic edit failure" })); };
            if (plan.defer) deferred.push(reply); else reply(); return;
          }
          if (match && match[2]) { assert.equal(body.expectedText, queue[Number(match[1])]); queue.splice(Number(match[1]), 1); }
          else if (match && request.method === "DELETE") queue.splice(Number(match[1]), 1);
          else if (match && request.method === "PATCH") { assert.equal(body.expectedText, queue[Number(match[1])]); queue[Number(match[1])] = body.text; }
          else if (request.method === "PATCH") queue = body.order.map((index: number) => queue[index]);
          else if (request.method === "DELETE") queue = [];
          payload = { id: "panels-A", queuedMessages: [...queue], status: "running", structuredState: { inFlight: true } };
          if (plan?.defer) {
            const captured = JSON.stringify(payload);
            deferred.push(() => { response.setHeader("Content-Type", "application/json"); response.end(captured); }); return;
          }
        } else if (path.endsWith("/input")) result.requests.push({ path, method: request.method, body, compact: request.headers["x-wand-tool-projection"] });
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
      await send("Emulation.setDeviceMetricsOverride", { width: mode === "390px" ? 390 : 1280, height: 900, deviceScaleFactor: 1, mobile: false });
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
      await click('.queue-bar-item[data-index="1"] [data-action="delete"]');
      await wait('JSON.stringify(p.queueTexts())===JSON.stringify(["alpha queue","gamma queue"])', "native deletion");
      await wait(`document.querySelectorAll('.queue-bar-item').length===2`, "deleted row removed");
      record("queue delete delegates once", { queue: await e("p.queueTexts()"), operation: result.requests.at(-1) });
      await click('.queue-bar-item[data-index="0"] [data-action="edit"]');
      await wait("!!document.querySelector('.wand-ui-dialog-content input')", "canonical edit dialog");
      await e("document.querySelector('.wand-ui-dialog-content input').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));void 0");
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      assert.equal(result.requests.length, requestStart + 1, "IME candidate Enter never edits the queue");
      assert.equal(await e("!!document.querySelector('.wand-ui-dialog-content input')"), true);
      await e("document.querySelector('.wand-ui-dialog-content input').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));document.querySelector('.wand-ui-dialog-content input').select();void 0");
      await send("Input.insertText", { text: "alpha edited" });
      await click(".wand-ui-dialog-actions .wand-ui-button-primary");
      await wait('p.queueTexts()[0]==="alpha edited"', "canonical edit and PATCH response");
      assert.equal(await e("document.querySelector('.queue-bar-item[data-index=\"0\"] .queue-bar-item-text').textContent"), "alpha edited", "accepted edit reaches the library projection");
      record("queue edit uses Ant dialog with IME", { queue: await e("p.queueTexts()"), operation: result.requests.at(-1), nativeDialogs: result.dialogs.length });
      const from = await point('.queue-bar-item[data-index="0"] .queue-bar-item-text');
      const to = await point('.queue-bar-item[data-index="1"] .queue-bar-item-text');
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
      assert.equal(await e("Boolean(p.state.queueBarDrag)"), true, "real pointer starts drag owner");
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: to.y + 5, button: "left", buttons: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: from.x, y: to.y + 5, button: "left", clickCount: 1 });
      await wait('JSON.stringify(p.queueTexts())===JSON.stringify(["gamma queue","alpha edited"])', "drag reorder commits native queue");
      assert.equal(await e("p.state.queueBarDrag===null"), true);
      record("queue real pointer reorder", { queue: await e("p.queueTexts()"), operation: result.requests.at(-1) });
      await click('.queue-bar-item[data-index="1"] [data-action="promote-item"]');
      await wait('p.state.queueBarPromoting===false && JSON.stringify(p.queueTexts())===JSON.stringify(["gamma queue"])', "promote accepts snapshot");
      const promote = result.requests.at(-1); assert.equal(promote.body.expectedText, "alpha edited"); assert.ok(promote.body.idempotencyKey);
      record("queue promote preserves remaining input", { queue: await e("p.queueTexts()"), operation: promote });
      await e('p.queue(["clear one","clear two"])'); await click('.queue-bar [data-action="clear-all"]');
      await wait("p.queueTexts().length===0 && document.getElementById('queue-bar-host').hidden && !document.querySelector('.queue-bar')", "clear native queue and unmount adapter");
      const queueOperations = result.requests.slice(requestStart); assert.deepEqual(queueOperations.map((operation: any) => operation.method), ["DELETE", "PATCH", "PATCH", "POST", "DELETE"]);
      assert.deepEqual(queueOperations[2].body.order, [1, 0]); assert.ok(queueOperations.every((operation: any) => operation.compact === "compact"));
      record("queue clear and unique actions", { count: queueOperations.length, hostHidden: true, rowCount: 0 });

      const openEdit = async (text?: string) => {
        await click('.queue-bar-item[data-index="0"] [data-action="edit"]');
        await wait("!!document.querySelector('.wand-ui-dialog-content input')", "owned input dialog");
        if (text !== undefined) {
          await e("document.querySelector('.wand-ui-dialog-content input').select();void 0");
          await send("Input.insertText", { text });
        }
      };
      const saveEdit = () => click(".wand-ui-dialog-actions .wand-ui-button-primary");
      const cancelEdit = () => click(".wand-ui-dialog-actions .wand-ui-button-secondary");
      const configureEdit = (plan: any) => e(`fetch('/_fixture/edit-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(plan))}}).then(()=>undefined)`);
      const releaseEdit = () => e("fetch('/_fixture/release',{method:'POST'}).then(()=>undefined)");
      await e('p.queue(["edit original","keep other"])');
      const untouched = result.requests.length;
      await e("window.cancelOrigin=document.querySelector('.queue-bar-item[data-index=\"0\"] [data-action=edit]');void 0");
      await openEdit("cancelled text"); await cancelEdit();
      await wait("!document.querySelector('.wand-ui-dialog-content input') && document.activeElement===cancelOrigin", "cancel restores source focus");
      await openEdit("escaped text");
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await wait("!document.querySelector('.wand-ui-dialog-content input') && document.activeElement===cancelOrigin", "Escape restores source focus");
      assert.equal(result.requests.length, untouched); assert.deepEqual(await e("p.queueTexts()"), ["edit original", "keep other"]);
      record("queue cancel and Escape restore source focus", { requests: 0, queueKept: true, focusRestored: true });

      await openEdit("stale edit"); await e('p.serverQueue(["replacement item","keep other"])'); await saveEdit();
      await wait("!document.querySelector('.wand-ui-dialog-content input')", "stale queue dialog closes");
      assert.equal(result.requests.length, untouched); assert.deepEqual(await e("p.queueTexts()"), ["replacement item", "keep other"]);
      await e('p.queue(["edit original","keep other"])');
      const toastVisible = await e("Array.from(document.querySelectorAll('.ant-notification-notice,.notification-bubble')).some(node=>node.getClientRects().length>0)");
      assert.equal(toastVisible, true, "stale-edit warning is still visible");
      const afterWarning = await point('.queue-bar-item[data-index="0"] [data-action="edit"]');
      assert.equal(afterWarning.hit, true, "visible toast list preserves the queue's pointer target");
      record("queue changes invalidate editing and toast preserves hit testing", { requests: 0, newerQueueKept: true, toastVisible, queueHit: afterWarning.hit });
      await openEdit("wrong session edit"); await e('p.switchFixture("panels-B",["other session queue"])'); await saveEdit();
      await wait("!document.querySelector('.wand-ui-dialog-content input')", "session switch cancels editor");
      assert.equal(result.requests.length, untouched);
      assert.deepEqual(await e('p.queueTexts("panels-A")'), ["edit original", "keep other"]);
      assert.deepEqual(await e("p.queueTexts()"), ["other session queue"]);
      assert.equal(await e('p.composer.read("panels-B").text'), "new owner's draft");
      record("session switch during prompt never edits the new owner", { requests: 0, originalQueueKept: true, newDraftKept: true });

      await e('p.switchFixture("panels-A",[])'); await configureEdit({ error: true });
      await openEdit("recover entered text"); await saveEdit();
      await wait("document.querySelector('.wand-ui-dialog-content input')?.value==='recover entered text' && document.querySelector('.wand-ui-dialog-content')?.textContent.includes('Synthetic edit failure')", "failure restores entered text in owner dialog");
      assert.deepEqual(await e("p.queueTexts()"), ["edit original", "keep other"]);
      await cancelEdit(); assert.equal(result.requests.length, untouched + 1, "failed edit is never retried automatically");
      record("edit failure keeps entered text and queue without resending", { requests: 1, value: "recover entered text", queueKept: true });

      await configureEdit({ error: true, defer: true }); const failedReplies = await e("p.stats.queueReplies");
      await openEdit("late failing text"); await saveEdit();
      await waitRequests(untouched + 2); await wait("!document.querySelector('.wand-ui-dialog-content input')", "edit request waits for transport");
      await e('p.switchFixture("panels-B",[])'); const newOwner = await e('p.composer.read("panels-B")');
      await releaseEdit(); await wait(`p.stats.queueReplies>${failedReplies}`, "late failure arrives"); await e("p.frames()");
      assert.equal(await e("!!document.querySelector('.wand-ui-dialog-content input')"), false, "late error never reopens over another owner");
      assert.equal(await e('p.composer.read("panels-B").revision'), newOwner.revision);
      assert.equal(await e('p.composer.read("panels-B").text'), newOwner.text);
      assert.deepEqual(await e('p.queueTexts("panels-A")'), ["edit original", "keep other"]);
      record("late edit failure does not overwrite another session", { newOwnerRevision: newOwner.revision, inputKept: true, originalQueueKept: true });

      await e('p.switchFixture("panels-A",[])'); await configureEdit({ defer: true }); const lateReplies = await e("p.stats.queueReplies");
      await openEdit("older accepted text"); await saveEdit();
      await waitRequests(untouched + 3);
      await e('p.serverQueue(["newer websocket item","keep other"])');
      await releaseEdit(); await wait(`p.stats.queueReplies>${lateReplies}`, "late accepted response arrives"); await e("p.frames()");
      assert.deepEqual(await e("p.queueTexts()"), ["newer websocket item", "keep other"]);
      record("late accepted edit cannot undo newer queue epoch", { newerQueueKept: true, responses: 1 });

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
      await click(".ant-notification-notice-close");
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

      await e('p.todos([{content:"Done",status:"completed"},{content:"Working",activeForm:"正在处理",status:"in_progress"},{content:"Pending",status:"pending"}])');
      assert.equal(await e("document.getElementById('todo-progress-counter').textContent"), "1 / 3");
      assert.equal(await e("document.getElementById('todo-progress-task').textContent"), "正在处理");
      await click("#todo-progress-toggle");
      await wait("document.getElementById('todo-progress-body').classList.contains('expanded')", "native Todo disclosure");
      const progress = await e(`(()=>{const b=document.getElementById('todo-progress-body'),c=document.querySelector('.chat-messages');return {open:document.getElementById('todo-progress-toggle').getAttribute('aria-expanded'),count:b.querySelectorAll('.ant-list-item').length,current:b.querySelector('[aria-current=step]')?.textContent,circle:document.querySelector('#todo-progress-ring [role=progressbar]')?.getAttribute('aria-valuenow'),padding:parseFloat(c.style.paddingBottom),height:b.offsetHeight,steps:document.querySelectorAll('#todo-progress-fill .ant-progress-steps-item').length};})()`);
      assert.equal(progress.open, "true"); assert.equal(progress.count, 3); assert.equal(progress.current, "Working"); assert.equal(progress.circle, "33"); assert.equal(progress.steps, 3); assert.ok(progress.padding >= progress.height);
      record("todo real progress and reading clearance", progress);
      await click("#todo-progress-content .ant-list-item"); assert.equal(await e("document.getElementById('todo-progress-body').classList.contains('expanded')"), true, "inside list preserves expansion");
      await click("#input-box"); assert.equal(await e("document.getElementById('todo-progress-toggle').getAttribute('aria-expanded')"), "false", "outside pointer closes");
      await click("#todo-progress-toggle");
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      assert.equal(await e("document.getElementById('todo-progress-toggle').getAttribute('aria-expanded')==='false' && document.activeElement===document.getElementById('todo-progress-toggle')"), true, "Escape closes and restores actual toggle focus");
      await e('p.todos([{content:"Next pending",status:"pending"},{content:"Later",status:"pending"}])');
      assert.equal(await e("document.getElementById('todo-progress-task').textContent"), "Next pending");
      await e('p.todos([{content:"Done",status:"completed"}])');
      assert.equal(await e("document.getElementById('todo-progress').classList.contains('hidden') && document.getElementById('todo-progress-body').classList.contains('hidden')"), true);
      await e("p.todos(null)");
      assert.equal(await e("document.getElementById('todo-progress').classList.contains('hidden') && !document.getElementById('todo-progress-body').classList.contains('expanded')"), true, "new turn retires the previous checklist");
      record("todo inside/outside/Escape and completed turn", { nativeFocusRestored: true, pendingFallback: true, completeHidden: true, newTurnHidden: true });

      await e("p.terminal()");
      assert.equal(await e("document.querySelectorAll('.wand-joystick-root').length"), 0);
      const row = await e(`(()=>{const h=document.getElementById('terminal-shortcuts'),r=h.getBoundingClientRect(),input=document.getElementById('input-box').getBoundingClientRect();return {count:document.querySelectorAll('#terminal-shortcuts').length,above:r.bottom<=input.top,singleLine:new Set([...h.querySelectorAll('button')].map(b=>b.getBoundingClientRect().top)).size===1,contained:r.left>=0&&r.right<=innerWidth,scrollable:h.scrollWidth>h.clientWidth};})()`);
      assert.equal(row.count, 1); assert.equal(row.above, true); assert.equal(row.singleLine, true); assert.equal(row.contained, true);
      if (mode === "390px") assert.equal(row.scrollable, true);
      await click("#input-box");
      const terminalStart = result.requests.length;
      const keys = ["escape", "tab", "shift_tab", "ctrl_c", "up", "down", "left", "right", "enter"];
      for (const key of keys) {
        await click(`[data-terminal-key="${key}"]`);
        await wait("p.state.messageQueue.length===0", "PTY key transport settled");
        assert.equal(await e("document.activeElement===document.getElementById('input-box')"), true, "shortcut preserves input focus");
      }
      const inputs = result.requests.slice(terminalStart).filter((operation: any) => operation.path.endsWith("/input"));
      assert.deepEqual(inputs.map((operation: any) => operation.body.shortcutKey), keys.map(key => key === "enter" ? "enter_text" : key));
      assert.deepEqual(inputs.map((operation: any) => operation.body.input), ["\u001b", "\t", "\u001b[Z", "\u0003", "\u001b[A", "\u001b[B", "\u001b[D", "\u001b[C", "\r"]);
      assert.ok(inputs.every((operation: any) => operation.body.view === "terminal"));
      record("PTY shortcuts stay in one input row and dispatch once without stealing focus", { ...row, keys });

      // Actual keyboard input uses the production input/IME handlers, not the shortcut callback.
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
      await e("document.querySelector('[data-terminal-key=tab]').focus();document.addEventListener('keydown',p.captureTerminalInput,true)");
      const keyboardStart = result.requests.length;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await wait("p.state.messageQueue.length===0", "keyboard shortcut activation settled");
      assert.deepEqual(result.requests.slice(keyboardStart).filter((op: any) => op.path.endsWith("/input")).map((op: any) => op.body.input), ["\t"]);
      await e("document.removeEventListener('keydown',p.captureTerminalInput,true)");
      record("PTY keyboard passthrough and IME remain single delivery", { typed, keyboardActivation: true });

      // A native touch tap must keep the composer and keyboard focused.
      await click("#input-box");
      await send("Emulation.setTouchEmulationEnabled", { enabled: true });
      const touch = await point('[data-terminal-key="escape"]');
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touch.x, y: touch.y }] });
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await e("p.frames()");
      assert.equal(await e("document.activeElement===document.getElementById('input-box')"), true);
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
      assert.equal(await e("document.querySelectorAll('[data-terminal-key]').length"), 9);
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

test("Ant composer panels preserve native queue, Todo, terminal and notice actions in five Chrome modes", { timeout: 360000, skip: process.env.WAND_CHAT_BROWSER !== "1" }, async () => {
  assert.equal((await runPanels()).ok, true);
});
