import { cssEvidenceCapture } from "./helpers/antd-css-evidence.js";
import { runChatExperience } from "./helpers/chat-experience-cases.js";
// Source-only real Chrome + real renderer, synthetic HTTP/turns. Never installed-service acceptance.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

export const modes = ["desktop", "390px", "native-shell", "reactUi=0", "reduce-motion", "390px-native-reduce"];
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
export async function runFocusBrowser({ root = resolve(import.meta.dirname, ".."), matrix = modes,
  coreOnly = false, geometryProbe = false, controlsOnly = false, touchOnly = false, thinkingOnly = false, experienceOnly = false, output } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wand-focus-source-"));
  const result = { ok: false, evidence: "production source + synthetic HTTP data + real Chrome; no installed service, Shell login or device", cases: [], cssEvidence: [], exceptions: [], errors: [], requests: [], otherRequests: [] };
  const responsePlans = []; const deferred = []; let browser, socket, server, diagnosticEval;
  try {
    const bundle = join(dir, "app.js");
    await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
      import "./tests/helpers/realtime-refresh-focus-harness.ts";
      import * as React from "react";
      import { createRoot } from "react-dom/client";
      import { flushSync } from "react-dom";
      import { mountComposerSender } from "./src/web-ui/browser/composer-sender-adapter";
      import { autoResizeInput, updateInteractiveControls, flashComposerSending, flashComposerDone, flashComposerFailed } from "./src/web-ui/browser/input";
      import { mountLoginControls } from "./src/web-ui/browser/login-controls-adapter";
      import { mountBrowserButtons } from "./src/web-ui/browser/library-buttons";
      import { ComposerAttachmentList } from "./src/web-ui/react/composer-attachments/host";
      import { renderAppShell } from "./src/web-ui/browser/render";
      import { composer, state } from "./src/web-ui/browser/state";
      import { installReactUiStyles } from "./src/web-ui/react/styles";
      installReactUiStyles();
      window.chatLane = { phase(value) {
        const session=state.sessions.find(s=>s.id===state.selectedId), box=document.getElementById("input-box");
        if (value==="sending") { flashComposerSending("正在发送…"); return; }
        if (value==="sent") { flashComposerDone("已发送"); return; }
        if (value==="failed") { flashComposerFailed("本地拒收"); return; }
        session.status=value==="idle"?"completed":"running";
        session.structuredState={inFlight:value!=="idle"};
        box.value=value==="running"?"":"owned draft";
        composer.edit(state.selectedId,{text:box.value}); updateInteractiveControls();
      }, mountComposerSender: () => mountComposerSender(autoResizeInput), mountLoginControls, mountBrowserButtons, renderAppShell,
        shell() {
          const root = document.createElement("div"); root.id = "shell-probe"; document.body.appendChild(root);
          root.innerHTML = renderAppShell();
          mountBrowserButtons(root); mountComposerSender(autoResizeInput);
          return root;
        },
        attachments() {
          const node = document.createElement("div"); node.id="test-attachments"; document.body.appendChild(node);
          const root = createRoot(node);
          const file = new File(["fixture"],"fixture.txt");
          composer.edit(state.selectedId,{addAttachment:{file,name:file.name,size:file.size}});
          const render = () => flushSync(() => root.render(<ComposerAttachmentList items={composer.read(state.selectedId).attachments.map((item,index)=>({index,name:item.name,size:item.size,sizeLabel:"7 B",previewUrl:null}))} onRemove={index=>composer.edit(state.selectedId,{removeAttachment:index})}/>));
          composer.subscribe(render); render();
        }
      };
    ` }, bundle: true,
      platform: "browser", format: "iife", outfile: bundle, define: { "process.env.NODE_ENV": '"production"' } });
    server = createServer((req, res) => {
      const path = new URL(req.url, "http://fixture.test").pathname;
      const files = { "/app.js": [bundle, "text/javascript"],
        "/styles.css": [join(root, "src/web-ui/content/styles.css"), "text/css"],
        "/tailwind.css": [join(root, "src/web-ui/content/tailwind.css"), "text/css"] };
      if (files[path]) { res.setHeader("Content-Type", files[path][1]); res.end(readFileSync(files[path][0])); return; }
      if (/^\/api\/sessions\/focus-[AB]\/tool-content\//.test(path)) {
        result.requests.push(path);
        const plan = responsePlans.shift() || { input: { file_path: "fixture.txt" }, content: "AAAA", pending: false, resultAvailable: true };
        const reply = () => { res.writeHead(plan.error ? 500 : 200, { "Content-Type": "application/json" }); res.end(JSON.stringify(plan.error ? { error: plan.error } : plan)); };
        if (plan.defer) deferred.push(reply); else reply(); return;
      }
      if (path.startsWith("/api/")) { result.otherRequests.push(req.method + " " + path); res.writeHead(404); res.end(); return; }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width,initial-scale=1"/>
        <link rel="stylesheet" href="/tailwind.css"/><link rel="stylesheet" href="/styles.css"/>
        <style>#chat-output { height:480px; display:flex; } .chat-messages { overflow-y:auto; }
        #input-box { width:240px; height:44px; }</style></head><body>
        <div id="chat-output"></div><div data-composer-sender><textarea id="input-box"></textarea></div><script src="/app.js"></script></body></html>`);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${dir}/profile`, origin], { stdio: "ignore" });
    const activePortFile = join(dir, "profile/DevToolsActivePort");
    for (let i = 0; i < 100 && !existsSync(activePortFile); i++) await sleep(50);
    assert.ok(existsSync(activePortFile), "Chrome/CDP required; missing browser is a failure, not a skip");
    const cdpPort = readFileSync(activePortFile, "utf8").split("\n")[0];
    const tabs = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const page = tabs.find(tab => tab.type === "page" && tab.url.startsWith(origin)); assert.ok(page);
    socket = new WebSocket(page.webSocketDebuggerUrl); await once(socket, "open");
    let id = 0; const pending = new Map();
    socket.addEventListener("message", event => {
      const response = JSON.parse(event.data);
      if (response.method === "Runtime.exceptionThrown") result.exceptions.push(response.params.exceptionDetails.exception?.description || response.params.exceptionDetails.text);
      if (response.method === "Runtime.consoleAPICalled" && response.params.type === "error") result.errors.push(response.params.args.map(arg => arg.value || arg.description).join(" "));
      const request = pending.get(response.id); if (!request) return; pending.delete(response.id);
      clearTimeout(request.timer);
      if (response.error) request.reject(new Error(JSON.stringify(response.error))); else request.resolve(response.result);
    });
    const send = (method, params = {}) => new Promise((resolveSend, reject) => {
      result.lastOperation = { method, expression: params.expression?.slice(0, 150) };
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("CDP deadline: " + JSON.stringify(result.lastOperation))); }, 15_000);
      pending.set(requestId, { resolve: resolveSend, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    const captureCss = cssEvidenceCapture("chat");
    const evaluate = async expression => {
      if (expression.includes("h.watch(") || /^window\.\w+\s*=/.test(expression)) expression += ";void 0";
      if (expression === "h.frames()") await send("Page.bringToFront");
      const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      await captureCss(send);
      return response.result.value;
    };
    diagnosticEval = evaluate;
    const wait = async (expression, description) => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(20); }
      throw new Error("Fixture condition not reached: " + description);
    };
    // A real user cannot click a control that is still clipped by an in-flight
    // expand/collapse animation (grid-template-rows: 0fr→1fr leaves the child at
    // zero height), and a moving target would also make the dispatched pointer miss:
    // the coordinates are probed one CDP round-trip before the click lands. Wait for
    // the point to hit-test to the target *and* stay put across two frames first.
    const click = async selector => {
      // Finish the previous disclosure before scrolling to its newly revealed
      // row. Scrolling a still-growing, clipped target records the wrong point.
      await evaluate("focusRefreshHarness.frames()");
      // Library cards can exceed this deliberately short fixture viewport. A user
      // scrolls to the next control before clicking; keep geometry assertions for
      // the actual disclosure/update after that navigation.
      await evaluate(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); const scroller=n?.closest(".chat-messages"); if(!n||!scroller)return; const r=n.getBoundingClientRect(), b=scroller.getBoundingClientRect(); if(r.top<b.top||r.bottom>b.bottom)n.scrollIntoView({block:"center",inline:"nearest"}); })()`);
      await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
      let previous = null;
      for (let i = 0; i < 200; i++) {
        const state = await evaluate(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); if(!n || !n.getClientRects().length) throw Error(${JSON.stringify("real visible control absent: " + selector)}); const r=n.getBoundingClientRect(); const x=r.x+r.width/2, y=r.y+r.height/2; const hit=document.elementFromPoint(x,y); return {x,y,hit:n===hit||n.contains(hit)}; })()`);
        const settled = previous && Math.abs(previous.x - state.x) < 0.5 && Math.abs(previous.y - state.y) < 0.5;
        if (state.hit && settled) {
          await send("Input.dispatchMouseEvent", { type: "mousePressed", x: state.x, y: state.y, button: "left", clickCount: 1 });
          await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: state.x, y: state.y, button: "left", clickCount: 1 });
          return;
        }
        previous = state;
        // Let the pending grid-row transition advance before re-probing.
        await evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
      }
      throw new Error("click target never became hit-testable and settled: " + selector + " " + await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});let a=n;const result=[];while(a){result.push({tag:a.tagName,cls:a.className,rect:a.getBoundingClientRect().toJSON(),display:getComputedStyle(a).display});a=a.parentElement;}const r=n.getBoundingClientRect();return JSON.stringify({ancestors:result,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,600)});})()`));
    };
    const key = async (name, type = "both", shift = false) => {
      const code = name === " " ? "Space" : name;
      const windowsVirtualKeyCode = { " ": 32, Enter: 13, Escape: 27, Tab: 9, ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35 }[name];
      const args = { key: name, code, windowsVirtualKeyCode, modifiers: shift ? 8 : 0 };
      const text = name === "Enter" ? "\r" : name === " " ? " " : undefined;
      if (type !== "up") await send("Input.dispatchKeyEvent", { type: "keyDown", ...args, text });
      if (type !== "down") await send("Input.dispatchKeyEvent", { type: "keyUp", ...args });
    };
    await send("Runtime.enable");
    await send("Page.bringToFront");
    await wait("Boolean(window.focusRefreshHarness)", "production harness boot");
    if (touchOnly) {
      await send("Emulation.setDeviceMetricsOverride", { width:390,height:900,deviceScaleFactor:1,mobile:true });
      await send("Emulation.setTouchEmulationEnabled", { enabled:true,configuration:"mobile" });
      await evaluate("window.__wandFixtureBeforeNavigation = true");
      await send("Page.navigate", {url:origin});
      await wait("!window.__wandFixtureBeforeNavigation && document.readyState==='complete' && !!window.focusRefreshHarness", "fresh touch fixture");
      assert.equal(await evaluate("matchMedia('(pointer:coarse)').matches"),true,"actual coarse-pointer media");
      await evaluate(`(async()=>{window.h=window.focusRefreshHarness;await h.fresh([{role:'user',uuid:'touch-copy',content:[{type:'text',text:'Nonsecret touch copy fixture'}]}]);document.querySelector('.chat-message').scrollIntoView({block:'center'});})()`);
      assert.equal(await evaluate("document.querySelectorAll('.msg-copy-btn.ant-btn').length"),1,"one library touch-copy control");
      const point=await evaluate("(()=>{const r=document.querySelector('.chat-message-text,.chat-message-content').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
      await send("Input.dispatchTouchEvent", {type:"touchStart",touchPoints:[{...point,radiusX:1,radiusY:1,force:1}]});
      await wait("document.querySelector('.msg-copy-btn').classList.contains('visible')","real long press reveals copy");
      await send("Input.dispatchTouchEvent", {type:"touchEnd",touchPoints:[]});
      await evaluate("h.frames()");
      const visible=await evaluate("getComputedStyle(document.querySelector('.msg-copy-btn')).display!=='none'");
      assert.equal(visible,true,"long-press release keeps the copy control available");
      await send("Browser.grantPermissions", {origin,permissions:["clipboardReadWrite","clipboardSanitizedWrite"]});
      await click(".msg-copy-btn");
      await wait("document.querySelector('.msg-copy-btn').textContent==='已复制'","copy feedback settles through the same library instance");
      assert.equal(await evaluate("navigator.clipboard.readText()"),"Nonsecret touch copy fixture");
      result.cases.push({mode:"390px-coarse-pointer",name:"real touch long press, library copy and clipboard result",libraryControls:1});
      result.ok=true;return result;
    }
    for (const mode of matrix) {
      if (controlsOnly && mode !== matrix[0]) {
        await evaluate("window.__wandFixtureBeforeNavigation = true");
      await send("Page.navigate", { url: origin + (mode === "reactUi=0" ? "/?reactUi=0" : "/") });
      await wait("!window.__wandFixtureBeforeNavigation && document.readyState === 'complete'");
        await wait("Boolean(window.focusRefreshHarness)", "production controls fixture reboot");
        await send("Page.bringToFront");
      }
      await send("Emulation.setDeviceMetricsOverride", { width: mode.includes("320px") ? 320 : mode.includes("390px") ? 390 : 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode.includes("reduce") ? "reduce" : "no-preference" }] });
      await evaluate(`document.documentElement.classList.toggle("is-wand-app", ${mode.includes("native")}); history.replaceState(null,"",${JSON.stringify(mode === "reactUi=0" ? "/?reactUi=0" : "/")});`);
      if (thinkingOnly) {
        await runThinkingFeedback({ evaluate, send, click, wait, mode, result });
        continue;
      }
      if (experienceOnly) {
        await runChatExperience({ evaluate, send, click, key, wait, mode, result, responsePlans, output });
        continue;
      }
      await evaluate(`(async () => {
        window.h = window.focusRefreshHarness;
        window.focusTurns = [{role:"assistant",uuid:"focus-row",createdAt:"2026-09-30T00:00:00Z",content:[
          {type:"thinking",thinking:"fixture thought"},
          {type:"tool_use",id:"focus-read",name:"Bash",input:{},activity:{kind:"run_command",fileKey:"fixture-file"}},
          {type:"tool_result",tool_use_id:"focus-read",content:""}]}];
        await h.fresh(focusTurns);
      })()`);
      if (controlsOnly) {
        await evaluate("window.ownedInput=document.getElementById('input-box'); h.composer.edit(h.state.selectedId,{text:'owned draft'}); chatLane.mountComposerSender(); void 0");
        await wait("!!document.querySelector('.ant-sender')", "production Sender mounted");
        assert.equal(await evaluate("ownedInput===document.getElementById('input-box') && ownedInput.value==='owned draft'"), true);
        await click("#input-box"); await send("Input.insertText", { text: " revision" });
        await wait("h.composer.read(h.state.selectedId).text===ownedInput.value", "native draft owner updated");
        const before = await evaluate("({value:ownedInput.value,revision:h.composer.read(h.state.selectedId).revision})");
        await evaluate("ownedInput.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));void 0");
        const requestsBeforeIme = result.otherRequests.length;
        await key("Enter");
        assert.equal(result.otherRequests.length, requestsBeforeIme, "candidate Enter does not submit");
        assert.equal(await evaluate("h.composer.read(h.state.selectedId).text.startsWith(" + JSON.stringify(before.value) + ")"), true, "IME does not clear the captured draft");
        await evaluate("ownedInput.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));void 0");
        await evaluate("h.frames()");
        await evaluate("h.state.sessions[0].sessionKind='pty';chatLane.mountComposerSender();void 0");
        assert.equal(await evaluate("!document.querySelector('.ant-sender') && ownedInput===document.getElementById('input-box') && ownedInput===document.activeElement"), true, "PTY restores exact focused native input");
        await evaluate("h.state.sessions[0].sessionKind='structured';chatLane.mountComposerSender();chatLane.attachments();void 0");
        await wait("!!document.querySelector('.ant-attachment,.ant-attachments')", "X attachment list mounted");
        const removeSelector = await evaluate("(()=>{const n=document.querySelector('#test-attachments [aria-label*=Remove],#test-attachments [aria-label*=移除],#test-attachments .ant-file-card-list-remove');if(!n)throw Error(document.getElementById('test-attachments').outerHTML);n.id='remove-fixture';return '#remove-fixture';})()");
        await click(removeSelector); await wait("h.composer.read(h.state.selectedId).attachments.length===0", "real attachment removal callback");
        await evaluate("document.getElementById('test-attachments').remove();document.querySelector('[data-composer-sender]').remove();document.getElementById('chat-output').remove();const login=document.createElement('div');login.dataset.loginControls='';login.dataset.checking='false';document.body.appendChild(login);chatLane.mountLoginControls();void 0");
        await wait("!!document.querySelector('.ant-input-password') && !!document.querySelector('#login-button.ant-btn')", "library login controls");
        assert.equal(await evaluate("document.querySelectorAll('#password').length===1 && document.querySelectorAll('#toggle-password-button').length===0"), true, "one password control with library visibility action");
        result.cssEvidence.push(await evaluate(`({mode:${JSON.stringify(mode)},state:"login",oldPasswordFields:document.querySelectorAll(".password-input,.password-toggle,#toggle-password-button").length,antPassword:document.querySelectorAll(".ant-input-password").length})`));
        // Real generated composer/terminal shell markup: every ordinary control becomes one library
        // control with its stable id and label, and the native textarea stays Sender's own input.
        await evaluate("chatLane.shell()");
        await wait("!!document.getElementById('send-input-button')?.classList.contains('ant-btn')", "library composer shell controls");
        const shellControls = await evaluate(`(async () => {
          const ids = ["send-input-button","attach-btn","voice-record-btn","prompt-optimize-btn","terminal-scale-down-top","terminal-scale-up-top","page-refresh-btn","terminal-jump-bottom","chat-unread-bubble","todo-progress-toggle"];
          const host = document.getElementById("send-input-button");
          document.documentElement.classList.add("no-transition");
          const phase = async value => {
            chatLane.phase(value);
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            return { icon: host.querySelector("svg")?.innerHTML || "", loading: host.classList.contains("ant-btn-loading"),
              danger: host.classList.contains("ant-btn-dangerous"), primary: host.classList.contains("ant-btn-primary"),
              disabled: host.disabled, background: getComputedStyle(host).backgroundColor };
          };
          const phases = {};
          for (const value of ["idle", "running", "queue", "sending", "sent", "failed"]) phases[value] = await phase(value);
          document.documentElement.classList.remove("no-transition");
          return {
            unlabelled: ids.filter(id => { const n=document.getElementById(id); return !n || (!n.getAttribute("aria-label")&&!n.textContent.trim()&&!n.title); }),
            plainButtons: ids.filter(id => !document.getElementById(id)?.classList.contains("ant-btn")),
            nested: document.querySelectorAll("#shell-probe button button, #shell-probe button [role=button]").length,
            nativeInput: document.getElementById("input-box")?.tagName === "TEXTAREA" && !!document.getElementById("input-box").closest(".ant-sender"), phases
          };
        })()`);
        result.shellControls = shellControls;
        assert.deepEqual(shellControls.unlabelled, [], "generated controls preserve accessible names");
        assert.deepEqual(shellControls.plainButtons, [], "generated controls use Ant buttons");
        assert.equal(shellControls.nested, 0, "controls never nest interactive controls");
        assert.equal(shellControls.nativeInput, true, "Sender owns the exact native textarea");
        const phases = shellControls.phases;
        assert.notEqual(phases.idle.icon, phases.running.icon, "running replaces the arrow with stop");
        assert.notEqual(phases.idle.icon, phases.sent.icon, "success replaces the arrow with a check");
        assert.equal(phases.sending.loading, true, "sending uses Ant loading");
        assert.equal(phases.sent.loading, false, "settled success clears loading");
        assert.equal(phases.running.danger, true, "stop is destructive");
        assert.equal(phases.failed.danger, true, "failure remains visible");
        assert.equal(phases.queue.primary, false, "queue is visually secondary");
        assert.equal(phases.sent.disabled, false, "loading does not leave the next submission locked");
        assert.equal(phases.idle.primary, true);
        result.shellControls = shellControls;
        result.cases.push({ mode, name: "Sender exact native input, draft/IME, PTY focus, X attachment callback, library login, shell controls" });
        continue;
      }
      const summary = "button.chat-process-summary";
      const entry = '.chat-call[data-tool-ids] button.chat-call-button';
      if (geometryProbe) {
        // Observational repair/baseline comparison only, never a B01/matrix pass.
        responsePlans.push({defer:true,input:{file_path:"fixture.txt"},pending:true,resultAvailable:false});
        await evaluate('h.fresh([{role:"assistant",uuid:"pending",content:[{type:"thinking",thinking:""},{type:"tool_use",id:"pending-read",name:"Bash",input:{},activity:{kind:"run_command",fileKey:"same-file"}}]}],{status:"running",structuredState:{inFlight:true}})');
        await click(summary);await click(entry);await wait('!!document.querySelector(".chat-activity-loading")',"probe loading");await evaluate("h.frames()");
        const snapshot='(()=>{const n=document.querySelector(".chat-call[data-tool-ids] button.chat-call-button"),r=document.querySelector(".chat-messages");return {rect:n.getBoundingClientRect().toJSON(),text:n.textContent,scrollTop:r.scrollTop,clientHeight:r.clientHeight,scrollHeight:r.scrollHeight,flexDirection:getComputedStyle(r).flexDirection,activeTag:document.activeElement.tagName,documentScroll:document.scrollingElement.scrollTop}})()';
        const before=await evaluate(snapshot);await evaluate('window.probeEntry=document.querySelector(".chat-call[data-tool-ids] button.chat-call-button");');
        assert.equal(deferred.length,1);deferred.shift()();await wait('!!document.querySelector(".chat-activity-pending-detail")',"probe pending");await evaluate("h.frames()");
        const after=await evaluate(snapshot);
        result.cases.push({id:"geometry-observation",mode,before,after,deltaY:after.rect.y-before.rect.y,sameInstance:await evaluate('probeEntry===document.querySelector(".chat-call[data-tool-ids] button.chat-call-button")')});
        continue;
      }
      await click(summary); await click(entry);
      await wait('document.querySelector(".chat-activity-detail-section:last-child pre")?.textContent === "AAAA"', "exact on-demand tool result AAAA");
      await evaluate("h.frames()");
      // Focus through actual keyboard navigation without toggling the already-open menu.
      for (let step = 0; step < 30 && !await evaluate('document.activeElement === document.querySelector("button.chat-process-summary")'); step++) await key("Tab");
      await evaluate(`window.observation=h.watch(${JSON.stringify(summary)});`);
      responsePlans.push({ input: { file_path: "fixture.txt" }, content: "BBBB", resultAvailable: true, pending: false });
      await evaluate(`(async()=>{await h.acceptDetail("focus-read"); focusTurns[0].content[0].thinking="new fixture thought"; h.publish(focusTurns); h.doRenderChat(false); await h.frames();})()`);
      const observed = await evaluate(`({ ...observation.result(), exactResult: document.querySelector(".chat-activity-detail-section:last-child pre")?.textContent,
        menuOpen: document.querySelector(".chat-activity")?.dataset.expanded==="true", entryOpen: document.querySelector(".chat-call[data-tool-ids]")?.dataset.expanded==="true" })`);
      result.cases.push({ id: "A01", mode, ...observed });
      assert.equal(observed.exactResult, "BBBB", `${mode}: exact tool body must update (not whole row text)`);
      for (const name of ["focusedBefore", "focusedAfter", "originalConnected", "chainContinuous", "glyphSame", "menuOpen", "entryOpen"]) assert.equal(observed[name], true, `${mode}: A01 ${name}: ${JSON.stringify(observed)}`);
      assert.equal(observed.blurCount, 0);
      for (const axis of ["x", "y", "width", "height"]) assert.ok(Math.abs(observed.rectAfter[axis] - observed.rectBefore[axis]) <= 1, `A01 geometry ${axis}`);
      assert.ok(Math.abs(observed.scrollAfter - observed.scrollBefore) <= 1);
      const thinkingRowContract = await evaluate(`(() => { const row = document.querySelector('.chat-call[data-thinking-entry="true"]'); return { controls: row.querySelectorAll("button").length, aria: row.querySelector("button").getAttribute("aria-expanded"), expanded: row.getAttribute("data-expanded") }; })()`);
      assert.deepEqual(thinkingRowContract, { controls: 1, aria: "false", expanded: "false" }, "thinking row keeps one control that reports its own row state");
      result.thinkingRowContract = thinkingRowContract;
      await key(" ");
      result.animationsAfterSpace = await evaluate('document.getAnimations().map(a=>({state:a.playState,timing:a.effect?.getComputedTiming(),target:a.effect?.target?.className}))');
      await evaluate("h.frames()");
      assert.equal(await evaluate('document.querySelector(".chat-activity").dataset.expanded'), "false", "real Space closes exactly once");
      await key("Enter"); await evaluate("h.frames()");
      assert.equal(await evaluate('document.querySelector(".chat-activity").dataset.expanded'), "true", "real Enter reopens");
      await key("Tab");
      assert.equal(await evaluate('document.activeElement.matches(".chat-call-button")'), true, "real Tab enters actual category");
      result.cssEvidence.push(await evaluate(`({mode:${JSON.stringify(mode)},state:"open tool group and call, keyboard close/reopen",native:document.documentElement.classList.contains("is-wand-app"),rollback:location.search,selectors:Object.fromEntries([".chat-message-bubble",".chat-activity-entry",".chat-activity-entry-button",".chat-activity-entry-detail",".tool-use-card",".password-input",".attachment-pill"].map(selector=>[selector,document.querySelectorAll(selector).length])),library:{bubble:document.querySelectorAll(".ant-bubble").length,thoughtChain:document.querySelectorAll(".ant-thought-chain").length}})`));
      if (!coreOnly) await runExtended({ evaluate, send, click, key, wait, mode, result, responsePlans, deferred });
    }
    assert.deepEqual(result.exceptions, []);
    result.ok = !geometryProbe;
    if (geometryProbe) result.verdict = "source_layout_observation_only_not_b01_or_matrix_pass";
    return result;
  } catch (error) {
    if (diagnosticEval) {
      try { result.failureDiagnostic = await diagnosticEval('({visible:!document.hidden,front:document.hasFocus(),active:document.activeElement?.outerHTML?.slice(0,300),activity:document.querySelector(".chat-activity")?.textContent,activityOpen:document.querySelector(".chat-activity")?.dataset.expanded,layout:Array.from(document.querySelectorAll(".chat-activity, .chat-activity-menu, .chat-activity-menu-inner, .chat-activity-timeline, .chat-call, .chat-call-button")).map(n=>({cls:n.className,rect:n.getBoundingClientRect().toJSON(),display:getComputedStyle(n).display,overflow:getComputedStyle(n).overflow,grid:getComputedStyle(n).gridTemplateRows,hit:(()=>{let r=n.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.className})()})),activeOwner:document.activeElement?.closest(".chat-message")?.dataset.chatOwner,selected:h.state.selectedId,view:h.state.currentView,cache:h.state.toolContentCache,projected:h.state.currentMessages,animations:document.getAnimations().map(a=>({state:a.playState,timing:a.effect?.getComputedTiming(),target:a.effect?.target?.className}))})'); }
      catch (diagnosticError) { result.failureDiagnostic = String(diagnosticError); }
    }
    result.failure = String(error.stack || error); throw Object.assign(error, { focusResult: result });
  } finally {
    if (output) writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
    try { socket?.close(); } catch { /* own CDP */ }
    if (browser && browser.exitCode === null) { browser.kill("SIGKILL"); await once(browser, "exit"); }
    for (const reply of deferred.splice(0)) reply();
    if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
async function runThinkingFeedback({ evaluate: e, send, click, wait, mode, result }) {
  await send("Emulation.setEmulatedMedia", { features: [
    { name: "prefers-reduced-motion", value: mode.includes("reduce") ? "reduce" : "no-preference" },
    { name: "prefers-color-scheme", value: mode.includes("dark") ? "dark" : "light" },
  ] });
  await e(`(async()=>{
    window.h=focusRefreshHarness;
    window.thinkingTurns=[{role:"assistant",uuid:"timed-thinking",content:[{type:"thinking",thinking:"",
      occurredAt:new Date(Date.now()-120000).toISOString(),lastActivityAt:new Date(Date.now()-90000).toISOString()}]}];
    await h.fresh(thinkingTurns,{status:"running",structuredState:{inFlight:true}});
    window.thinkingSummary=document.querySelector("button.chat-process-summary");
    window.thinkingClock=document.querySelector('[data-activity-kind="thinking"]');
  })()`);
  assert.equal(await e('thinkingSummary.textContent.includes("正在思考") && thinkingClock.textContent.includes("无新进展")'), true);
  const clock = await e('thinkingClock.textContent');
  assert.equal(await e('thinkingClock.getBoundingClientRect().right <= innerWidth'), true, "waiting feedback remains inside the viewport");
  await wait(`thinkingClock.textContent !== ${JSON.stringify(clock)}`, "thinking clock ticks without a new server event");
  await click("button.chat-process-summary");
  await e("h.frames()");
  assert.equal(await e('document.querySelector(".chat-activity").dataset.expanded'), "true");
  await click('.chat-call[data-thinking-entry="true"] button.chat-call-button');
  await e("h.frames()");
  assert.equal(await e('document.querySelector(".chat-activity-thinking-content").textContent'), "模型未提供可显示的思考正文。");
  await e(`(async()=>{
    thinkingTurns[0].content[0].lastActivityAt=new Date().toISOString();
    h.publish(thinkingTurns);h.doRenderChat(false);await h.frames();
  })()`);
  assert.equal(await e('document.querySelector("button.chat-process-summary")===thinkingSummary'), true, "activity metadata updates retain the original trigger");
  assert.equal(await e('document.querySelector(".chat-activity").dataset.expanded'), "true", "activity update retains open state");
  assert.equal(await e('document.querySelector(".chat-activity-meta").textContent.includes("无新进展")'), false, "new observed thinking clears silence feedback");
  await e(`(async()=>{
    thinkingTurns[0].content.push({type:"tool_use",id:"thinking-command",name:"Bash",input:{},activity:{kind:"run_command",occurredAt:new Date().toISOString()}});
    h.publish(thinkingTurns);h.doRenderChat(false);await h.frames();
  })()`);
  assert.equal(await e('!!document.querySelector(".chat-activity.is-command-running") && !document.querySelector(".chat-activity.is-thinking-running [data-activity-kind=thinking]")'), true, "command execution takes over live status");
  await e(`(async()=>{
    thinkingTurns[0].content.push({type:"tool_result",tool_use_id:"thinking-command",content:"done"});
    h.publish(thinkingTurns,{status:"idle",structuredState:{inFlight:false}});h.doRenderChat(false);await h.frames();
  })()`);
  assert.equal(await e('document.querySelectorAll(".chat-activity.is-thinking-running,.chat-activity.is-command-running,[data-activity-kind=thinking]").length'), 0, "completion retires reasoning and command timers");
  await e('h.fresh([{role:"assistant",uuid:"legacy-thinking",content:[{type:"thinking",thinking:""}]}],{status:"running",structuredState:{inFlight:true}})');
  assert.equal(await e('document.querySelector(".chat-activity-meta").textContent.includes("正在思考")'), true);
  assert.equal(await e('document.querySelectorAll("[data-activity-kind=thinking]").length'), 0, "legacy messages do not invent timestamps");
  result.cases.push({ mode, name: "empty reasoning, real timer, silence recovery, stable disclosure, execution transition and completion", ok: true });
}

async function runExtended({ evaluate: e, send, click, key, wait, mode, result, responsePlans: plans, deferred }) {
  const record = (id, name, data = {}) => { result.cases.push({ id, name, mode, ...data }); };
  const checkStable = observation => {
    for (const field of ["focusedAfter", "originalConnected", "chainContinuous", "glyphSame"]) assert.equal(observation[field], true, field + ": " + JSON.stringify(observation));
    assert.equal(observation.blurCount, 0); assert.equal(observation.replayCount, 0);
    for (const axis of ["x","y","width","height"]) assert.ok(Math.abs(observation.rectAfter[axis]-observation.rectBefore[axis])<=1, "same trigger geometry: " + axis + " " + JSON.stringify(observation));
  };
  const focusTab = async selector => {
    for (let step = 0; step < 50 && !await e(`document.activeElement.matches(${JSON.stringify(selector)})`); step++) await key("Tab");
    assert.equal(await e(`document.activeElement.matches(${JSON.stringify(selector)})`), true, "Tab must reach " + selector);
  };
  const summary = "button.chat-process-summary";
  const entry = '.chat-call[data-tool-ids] button.chat-call-button';
  const exact = '.chat-activity-detail-section:last-child pre';
  const openRead = async () => {
    await click(summary); await click(entry); await wait(`!!document.querySelector(${JSON.stringify(exact)})`, "real tool details"); await e("h.frames()");
  };
  const freshRead = async (patch = {}) => {
    await e(`h.fresh(focusTurns,${JSON.stringify(patch)})`); await openRead();
  };
  // The thinking row inside the timeline stays one real control that opens only its own body:
  // X's Think owns the visual, so no second disclosure tier is added around it.
  await e('window.thinkingRow=document.querySelector(".chat-call[data-thinking-entry=\\"true\\"]");void 0');
  const thinkingSelector = '.chat-call[data-thinking-entry="true"] button.chat-call-button';
  assert.equal(await e('thinkingRow?.querySelectorAll("button").length'), 1, "thinking row keeps exactly one control");
  await click(thinkingSelector); await e("h.frames()");
  assert.equal(await e('thinkingRow.getAttribute("data-expanded")'), "true", "real thinking row opens");
  assert.equal(await e('thinkingRow.querySelector("button").getAttribute("aria-expanded")'), "true", "thinking control reports its own open state");
  await click(thinkingSelector); await e("h.frames()");
  const thinkingRow = await e('({expanded:thinkingRow.getAttribute("data-expanded"),controls:thinkingRow.querySelectorAll("button").length})');
  assert.deepEqual(thinkingRow, { expanded: "false", controls: 1 }, "real thinking row closes to exactly one control");
  record("A02", "thinking row owns exactly one toggle", thinkingRow);

  await click(entry); await e("h.frames()");
  await e(`window.o=h.watch(${JSON.stringify(entry)});`);
  plans.push({ input: { file_path: "fixture.txt" }, content: "CCCC", pending: false });
  await e('(async()=>{await h.acceptDetail("focus-read");focusTurns[0].content[0].thinking="another thought";h.publish(focusTurns);h.doRenderChat(false);await h.frames();})()');
  let observed = await e(`({...o.result(),body:document.querySelector(${JSON.stringify(exact)})?.textContent})`);
  assert.equal(observed.body, "CCCC"); checkStable(observed); record("A02", "actual entry toggle", observed);

  // Real legacy terminal/diff/tool headers and Markdown copy, not fake message controls.
  await e(`(async()=>{
    window.controls=[{role:"assistant",uuid:"headers",content:[
      {type:"text",text:"\\\`\\\`\\\`txt\\nAAAA\\n\\\`\\\`\\\`"},
      {type:"tool_use",id:"bash-fixture",name:"Bash",input:{command:"fixture command"}},
      {type:"tool_result",tool_use_id:"bash-fixture",content:"AAAA"},
      {type:"tool_use",id:"edit-fixture",name:"Edit",input:{file_path:"fixture.txt",old_string:"AAAA",new_string:"BBBB"}},
      {type:"tool_result",tool_use_id:"edit-fixture",content:"done"},
      {type:"tool_use",id:"generic-fixture",name:"FixtureTool",input:{arg:"AAAA"}},
      {type:"tool_result",tool_use_id:"generic-fixture",content:"AAAA"},
      {type:"tool_use",id:"decision-fixture",name:"decision_evaluate",input:{command:"wand decision"},semantic:{kind:"decision"}},
      {type:"tool_result",tool_use_id:"decision-fixture",content:"AAAA",semantic:{kind:"decision"},_truncated:true}]}];
    window.copied=[]; Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{copied.push(text);}}});
    await h.fresh(controls);
  })()`);
  for (const [selector, index, bodySelector] of [[".term-header", 2, ".term-output"], [".diff-header", 4, ".diff-body"], [".chat-tool-card:not(.ask-user) .chat-tool-header", 6, ".tool-use-result"], [".decision-tool-card .chat-tool-header", 8, ".decision-tool-card .tool-use-result"]]) {
    await click(selector); await e("h.frames()");
    await e(`window.o=h.watch(${JSON.stringify(selector)});`);
    await e(`(async()=>{controls[0].content[${index}].content="BBBB";h.publish(controls);h.doRenderChat(false);await h.frames();})()`);
    observed = await e("o.result()"); checkStable(observed);
    assert.ok(await e(`document.querySelector(${JSON.stringify(bodySelector)})?.textContent.includes("BBBB")`), "updated actual internal tool body");
    await key(" "); await key("Enter"); await e("h.frames()");
    record("A02", selector, observed);
  }
  // The local-decision header control and its own on-demand result control must be
  // siblings: a load control nested inside the header also re-fired the header toggle
  // and left an interactive button inside another button.
  assert.equal(await e('document.querySelectorAll(".decision-tool-card button button, .decision-tool-card button [role=button]").length'), 0, "decision header owns no nested interactive control");
  assert.equal(await e('!!document.querySelector(".decision-tool-card .chat-tool-header .decision-tool-details")'), false, "decision details are not inside their header control");
  if (await e('document.querySelector(".decision-tool-card").classList.contains("collapsed")')) { await click(".decision-tool-card .chat-tool-header"); await e("h.frames()"); }
  assert.equal(await e('document.querySelector(".decision-tool-card").classList.contains("collapsed")'), false, "decision card stays open for its own result control");
  plans.push({input:{command:"wand decision"},content:"DECISION-BBBB",pending:false,resultAvailable:true});
  assert.equal(await e(`(()=>{const n=document.querySelector(".decision-result-load");if(!n)return false;n.id="decision-load-fixture";return true;})()`), true, "truncated decision result exposes one real load control");
  await click("#decision-load-fixture");
  await wait('document.querySelector(".decision-tool-card .tool-use-result")?.textContent.includes("DECISION-BBBB")', "loaded decision result");
  assert.equal(await e('document.querySelector(".decision-tool-card").classList.contains("collapsed")'), false, "loading the full decision result must not collapse its own card");
  record("A02", "decision header and its own load control", { collapsed: false });
  // One interactive control per control: the library buttons replace generated markup, so no
  // migrated control may end up containing another button or a nested role=button node.
  assert.equal(await e('document.querySelectorAll(".chat-messages button button, .chat-messages button a[href], .chat-messages button [role=button]").length'), 0, "no migrated control nests another interactive control");
  assert.deepEqual(await e('Array.from(document.querySelectorAll(".chat-messages button")).filter(node=>!node.getAttribute("aria-label")&&!node.textContent.trim()&&!node.closest("[aria-hidden=true]")).length'), 0, "every icon-only library button keeps an accessible name");
  await focusTab(".code-copy");
  // The library press ripple fades for two seconds, so any wait for motion to settle outlives the
  // 2s confirmation window. Sample the visible confirmation from the real click instead.
  await e('window.copyStarted=performance.now();window.copyFeedback=0;window.feedbackPoll=setInterval(()=>{const n=document.querySelector(".code-copy");if(!window.copyFeedback&&n&&n.textContent==="\u5df2\u590d\u5236")window.copyFeedback=performance.now()-copyStarted;},16);');
  await key("Enter");
  await wait("window.copyFeedback>0", "visible copy confirmation after the real click");
  result.copyConfirmDelay = await e("window.copyFeedback");
  assert.ok(await e("window.copyFeedback<1000"), "copy confirmation is immediate");
  assert.deepEqual(await e('copied.map(text=>text.trim())'), ["AAAA"]);
  await e('clearInterval(window.feedbackPoll);');
  assert.ok(await e(`(async()=>{const started=performance.now();while(performance.now()-started<6000){const node=document.querySelector(".code-copy");if(node&&node.textContent==="\u590d\u5236"&&!node.classList.contains("copied"))return Math.round(performance.now()-started);await new Promise(resolve=>setTimeout(resolve,50));}throw new Error("copy confirmation never reverted");})()`) >= 1500, "confirmation reverts on its own window");
  // Same-view full paint of the Markdown body keeps the real control instance, focus and reading anchor.
  await e('window.o=h.watch(".code-copy");');
  await e('(async()=>{controls[0].content[0].text="```txt\\nBBBB\\n```";h.publish(controls);h.doRenderChat(true);await h.frames();})()');
  observed = await e('({...o.result(),code:document.querySelector(".code-block code").textContent,copied:copied.slice()})');
  result.copyObservation = observed;
  checkStable(observed); assert.equal(observed.code.trim(), "BBBB");
  await key("Enter"); assert.deepEqual(await e('copied.map(text=>text.trim())'), ["AAAA", "BBBB"]); record("A02", "idempotent copy uses latest own source", observed);
  await click(".assistant-reply-disclosure"); await e("h.frames()");
  await e('window.reply=document.querySelector(".assistant-reply-disclosure");window.o=h.watch(".assistant-reply-disclosure");');
  await e('(async()=>{controls[0].content[0].text="```txt\\nCCCC\\n```";h.publish(controls);h.doRenderChat(true);await h.frames();})()');
  observed=await e('({...o.result(),collapsed:reply.getAttribute("aria-expanded")==="false"})');checkStable(observed);assert.equal(observed.collapsed,true);record("A04","reply stays collapsed in same-view full paint",observed);
  await key("Enter"); await e("h.frames()"); assert.equal(await e('reply.getAttribute("aria-expanded")'),"true");

  // Real multi-Agent tabs, native details and process summary; source-owned hidden turns count.
  await e(`(async()=>{
    window.metaA={taskId:"agent-a",agentType:"Explore",taskDescription:"fixture A"};
    window.metaB={taskId:"agent-b",agentType:"Explore",taskDescription:"fixture B"};
    window.agentTurns=[{role:"assistant",uuid:"dispatch",content:[
      {type:"tool_use",id:"agent-a",name:"Task",input:{subagent_type:"Explore",description:"fixture A"},__subagent:metaA},
      {type:"tool_use",id:"agent-b",name:"Task",input:{subagent_type:"Explore",description:"fixture B"},__subagent:metaB}]},
      {role:"assistant",uuid:"agent-child-a",content:[{type:"thinking",thinking:"process A",__subagent:metaA},{type:"text",text:"AAAA",__subagent:metaA}]},
      {role:"assistant",uuid:"agent-child-b",content:[{type:"thinking",thinking:"process B",__subagent:metaB},{type:"text",text:"AAAA",__subagent:metaB}]}];
    await h.fresh(agentTurns,{status:"running",structuredState:{inFlight:true}});
  })()`);
  if (await e('document.querySelector(".agent-run").dataset.expanded!=="true"')) await click(".agent-run-summary");
  await click('.agent-run-agent[data-agent-task-id="agent-b"]');await e("h.frames()");
  const agentLibrary = await e('({cards:document.querySelectorAll(".agent-run .ant-card").length,collapse:document.querySelectorAll(".agent-run .ant-collapse").length,timeline:document.querySelectorAll(".agent-run .ant-timeline").length,retired:document.querySelectorAll(".agent-run-summary-icon,.agent-run-agent-marker,.agent-run-step-marker,.agent-run-result-label").length})');
  assert.ok(agentLibrary.cards>0);assert.ok(agentLibrary.collapse>0);assert.ok(agentLibrary.timeline>0);assert.equal(agentLibrary.retired,0);record("migration","Agent chrome belongs to Ant Card/Collapse/Timeline",agentLibrary);
  await e('window.o=h.watch(".agent-run-agent[data-agent-task-id=\\\"agent-b\\\"]");');
  await e('(async()=>{agentTurns[2].content[1].text="BBBB";h.publish(agentTurns);h.doRenderChat(true);await h.frames();})()');
  observed=await e('({...o.result(),selected:document.querySelector(".agent-run-agent[data-agent-task-id=\\\"agent-b\\\"]").getAttribute("aria-selected"),body:document.querySelector(".agent-run-detail-panel.is-selected").textContent})');checkStable(observed);assert.equal(observed.selected,"true");assert.ok(observed.body.includes("BBBB"));record("A04","selected actual Agent survives full paint",observed);
  await key("ArrowLeft");assert.equal(await e('document.activeElement.getAttribute("data-agent-task-id")'),"agent-a");await key("End");assert.equal(await e('document.activeElement.getAttribute("data-agent-task-id")'),"agent-b");
  await click('.agent-run-detail-panel.is-selected .agent-run-process-summary');await e("h.frames()");
  if (await e('document.querySelector(".agent-run-detail-panel.is-selected .agent-run-process").dataset.expanded!=="true"')) {await key("Enter");await e("h.frames()");}
  await e('window.o=h.watch(".agent-run-detail-panel.is-selected .agent-run-process-summary");window.nativeDetails=document.querySelector(".agent-run-detail-panel.is-selected .agent-run-process");');
  await e('(async()=>{agentTurns[2].content[1].text="CCCC";h.publish(agentTurns);h.doRenderChat(false);await h.frames();})()');
  observed=await e('({...o.result(),detailsOpen:nativeDetails.dataset.expanded==="true",sameDetails:nativeDetails===document.querySelector(".agent-run-detail-panel.is-selected .agent-run-process")})');checkStable(observed);assert.equal(observed.detailsOpen,true);assert.equal(observed.sameDetails,true);record("A02","Ant Collapse process disclosure retains state and original header",observed);
  await focusTab('.agent-run-agent[data-agent-task-id="agent-b"]');await e('window.runSummary=document.querySelector(".agent-run-summary");');
  await e('(async()=>{h.publish([{...agentTurns[0],content:[agentTurns[0].content[0]]},agentTurns[1]]);h.doRenderChat(true);await h.frames();})()');
  assert.equal(await e('document.activeElement===runSummary'),true);record("A10","retired Agent tab goes to same run, not another Agent");

  // Confirmed raw structured coordinate: prepend, hidden owned source turns and block cursor.
  await e(`(async()=>{
    window.rawFocus=JSON.parse(JSON.stringify(focusTurns)); delete rawFocus[0].uuid;
    await h.fresh(rawFocus,{messageOffset:5,leadingBlockOffset:0});
  })()`); await openRead();
  await focusTab(summary); await e(`window.o=h.watch(${JSON.stringify(summary)});window.rawRow=o.row;`);
  await e(`(async()=>{h.publish([{role:"user",content:[{type:"text",text:"earlier source"}]}].concat(rawFocus),{messageOffset:4,leadingBlockOffset:0});h.doRenderChat(true);await h.frames();})()`);
  observed=await e('({...o.result(),sameOwner:rawRow===document.querySelector(".chat-message[data-msg-index=\\\"1\\\"]"),open:document.querySelector(".chat-activity").dataset.expanded==="true"})');
  checkStable(observed);assert.equal(observed.sameOwner,true);assert.equal(observed.open,true);record("A04","prepend uses source coordinate, not local DOM index",observed);
  // Partial first-turn block fill, from offset3 to0, still includes the old group anchor.
  await e(`h.fresh(rawFocus,{messageOffset:5,leadingBlockOffset:3})`);await openRead();await focusTab(entry);await e(`window.o=h.watch(${JSON.stringify(entry)});`);
  await e('(async()=>{h.publish([{...rawFocus[0],content:[{type:"thinking",thinking:"prefix0"},{type:"thinking",thinking:"prefix1"},{type:"thinking",thinking:"prefix2"}].concat(rawFocus[0].content)}],{messageOffset:5,leadingBlockOffset:0});h.doRenderChat(true);await h.frames();})()');
  observed=await e('o.result()');checkStable(observed);record("A04","block-fill retains original source group",observed);

  // Native key lifecycle: preserve the keydown target and let its default click happen once.
  await freshRead();await focusTab(summary);
  await e(`window.o=h.watch(${JSON.stringify(summary)}); window.clicks=0;o.node.addEventListener("click",()=>clicks++);`);
  await key(" ","down");
  plans.push({input:{file_path:"fixture.txt"},content:"DDDD",pending:false});
  await e('(async()=>{await h.acceptDetail("focus-read");focusTurns[0].content[0].thinking="held key thought";h.publish(focusTurns);h.doRenderChat(false);await h.frames();})()');
  observed=await e(`({...o.result(),body:document.querySelector(${JSON.stringify(exact)})?.textContent})`);checkStable(observed);assert.equal(observed.body,"DDDD");
  await key(" ","up");await e("h.frames()");assert.equal(await e("clicks"),1);assert.equal(await e('document.querySelector(".chat-activity").dataset.expanded'),"false");
  await key("Enter");await e("h.frames()");await key("Tab");await key("Tab","both",true);assert.equal(await e('document.activeElement===document.querySelector("button.chat-process-summary")'),true);
  record("A05","Space down→refresh→up exactly one click; Tab/Shift+Tab",observed);

  // Loading → pending → cross-turn result, genuinely on-demand; same file deduplicates.
  const requestsBefore=result.requests.length;
  plans.push({defer:true,input:{file_path:"fixture.txt"},pending:true,resultAvailable:false});
  await e(`(async()=>{window.pendingTurns=[{role:"assistant",uuid:"pending",content:[{type:"thinking",thinking:""},{type:"tool_use",id:"pending-read",name:"Bash",input:{},activity:{kind:"run_command",fileKey:"same-file"}}]}];await h.fresh(pendingTurns,{status:"running",structuredState:{inFlight:true}});})()`);
  assert.equal(result.requests.length,requestsBefore,"unopened entries do not prefetch");
  await click(summary);await click(entry);await wait('document.querySelector(".chat-activity-loading")?.textContent.includes("加载详情")',"loading state");
  await e("h.frames()");await e(`window.o=h.watch(${JSON.stringify(entry)});`);assert.equal(deferred.length,1);deferred.shift()();
  await wait('!!document.querySelector(".chat-activity-pending-detail")',"pending detail");await e("h.frames()");
  observed=await e('o.result()');record("A06-observation","loading→pending mandatory geometry observation",observed);checkStable(observed);record("A06","loading→pending retains actual entry",observed);
  plans.push({input:{file_path:"fixture.txt"},content:"CROSS-RESULT",pending:false,resultAvailable:true});
  await e(`window.o=h.watch(${JSON.stringify(entry)}); h.publish(pendingTurns.concat([{role:"user",content:[{type:"tool_result",tool_use_id:"pending-read",content:""}]}]));h.doRenderChat(false);`);
  await wait(`document.querySelector(${JSON.stringify(exact)})?.textContent==="CROSS-RESULT"`,"cross-turn actual result");await e("h.frames()");
  observed=await e(`({...o.result(),body:document.querySelector(${JSON.stringify(exact)}).textContent})`);checkStable(observed);record("A06","cross-message result fetches open detail once",observed);
  await e(`(async()=>{pendingTurns[0].content.push({type:"tool_use",id:"pending-read-2",name:"Bash",input:{},activity:{kind:"run_command",fileKey:"same-file"}});h.publish(pendingTurns);h.doRenderChat(false);await h.frames();})()`);
  assert.equal(await e('document.querySelectorAll(".chat-call[data-tool-ids]").length'),2);record("A15","separate invocations remain separate; compact inputs remain empty",{requests:result.requests.length-requestsBefore});

  // Error survives unrelated/full paints. Retry retires to its own ORIGINAL entry.
  plans.push({error:"fixture failure"});await e("h.fresh(focusTurns)");await click(summary);await click(entry);
  await wait('!!document.querySelector(".chat-activity-retry")',"actual retry");await e("h.frames()");
  await focusTab(".chat-activity-retry");await e('window.o=h.watch(".chat-activity-retry");window.entryNode=document.querySelector(".chat-call[data-tool-ids] button.chat-call-button");');
  await e('(async()=>{focusTurns[0].content[0].thinking="error remains";h.publish(focusTurns);h.doRenderChat(true);await h.frames();})()');
  observed=await e('({...o.result(),error:document.querySelector(".chat-activity-feedback").textContent})');checkStable(observed);assert.match(observed.error,/fixture failure/);record("A07","real retry instance survives full paint",observed);
  const retryRequestCount=result.requests.length;plans.push({input:{file_path:"fixture.txt"},content:"RETRIED",pending:false});
  await key("Enter");await wait(`document.querySelector(${JSON.stringify(exact)})?.textContent==="RETRIED"`,"retry result");await e("h.frames()");
  assert.equal(result.requests.length-retryRequestCount,1);assert.equal(await e('document.activeElement===entryNode'),true);record("A07","one retry request; exact same-entry retirement fallback",{requests:1});

  // New composer focus, selection and real CDP IME: old render must do zero JS focus.
  await e('window.focusCalls=[];window.nativeFocus=HTMLElement.prototype.focus;HTMLElement.prototype.focus=function(...args){focusCalls.push(this.className||this.id);return nativeFocus.apply(this,args);};');
  await focusTab("#input-box");
  await e('const box=document.querySelector("#input-box");box.value="draft untouched";box.setSelectionRange(2,8,"backward");h.composer.edit(h.state.selectedId,{text:box.value});window.composerNode=box;');
  await e('h.publish(focusTurns);h.renderChat();');await e("h.frames()");
  assert.deepEqual(await e('({same:document.activeElement===composerNode,value:composerNode.value,start:composerNode.selectionStart,end:composerNode.selectionEnd,direction:composerNode.selectionDirection})'),{same:true,value:"draft untouched",start:2,end:8,direction:"backward"});assert.deepEqual(await e("focusCalls"),[]);
  await send("Input.imeSetComposition",{text:"输入",selectionStart:0,selectionEnd:2});
  const imeBefore=await e('({value:composerNode.value,start:composerNode.selectionStart,end:composerNode.selectionEnd})');
  await e('(async()=>{focusTurns[0].content[0].thinking="IME surrounding refresh";h.publish(focusTurns);h.doRenderChat(false);await h.frames();})()');
  assert.deepEqual(await e('({value:composerNode.value,start:composerNode.selectionStart,end:composerNode.selectionEnd})'),imeBefore);assert.equal(await e('document.activeElement===composerNode'),true);assert.deepEqual(await e("focusCalls"),[]);
  const sendsBefore=result.otherRequests.length;
  await key("Enter");await send("Input.insertText",{text:"输入"});assert.equal(result.otherRequests.length,sendsBefore,"candidate Enter never submits");
  record("A13","real composer selection/IME not replaced or stolen",{selection:imeBefore,messageTextEditor:"N/A: renderer has no free text editor"});
  await e('HTMLElement.prototype.focus=nativeFocus;');

  // Source-controlled real canonical image preview, not a fabricated dialog control.
  await freshRead();await e("h.openRealImagePreview()");await wait('!!document.querySelector("[data-testid=image-viewer-dialog]")',"real preview host");await e("h.frames()");
  await e('window.previewNode=document.activeElement;window.previewFocus=0;window.nativeFocus=HTMLElement.prototype.focus;HTMLElement.prototype.focus=function(...args){previewFocus++;return nativeFocus.apply(this,args);};');
  plans.push({input:{file_path:"fixture.txt"},content:"PREVIEW-RESULT",pending:false});
  await e('(async()=>{await h.acceptDetail("focus-read");focusTurns[0].content[0].thinking="preview update";h.publish(focusTurns);h.doRenderChat(true);await h.frames();})()');
  assert.equal(await e('document.activeElement===previewNode'),true);assert.equal(await e("previewFocus"),0);assert.equal(await e(`document.querySelector(${JSON.stringify(exact)})?.textContent`),"PREVIEW-RESULT");
  await e('HTMLElement.prototype.focus=nativeFocus;');await key("Escape");await wait('!h.imageViewerController.isOpen()',"inner preview Escape");await e("h.frames()");
  assert.equal(await e('document.querySelector(".chat-activity").dataset.expanded'),"true", "inner Escape does not close background activity");record("A09","real preview keeps its focus; inner Escape has priority");

  // Escape is scope/intent/composition-aware. External focus never reverts to summary.
  await focusTab("#input-box");await key("Escape");assert.equal(await e('document.activeElement.id'),"input-box");assert.equal(await e('document.querySelector(".chat-activity").dataset.expanded'),"true");
  await focusTab(entry);await e('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",isComposing:true,bubbles:true}));');assert.equal(await e('document.querySelector(".chat-activity").dataset.expanded'),"true");
  await key("Escape");await e("h.frames()");assert.equal(await e('document.activeElement.matches(".chat-call-button")'),true);assert.equal(await e('document.querySelector(".chat-activity").dataset.expanded'),"true");
  await key("Escape");await e("h.frames()");assert.equal(await e('document.activeElement===document.querySelector("button.chat-process-summary")'),true);assert.equal(await e('document.querySelector(".chat-activity").dataset.expanded'),"false");
  await key("Tab");assert.equal(await e('document.activeElement.matches(".chat-call-button")'),false,"hidden entries out of Tab order");record("A08-M3","scope Escape, composition ignored, hidden Tab chain, external Escape");
  await freshRead();await click("#input-box");assert.equal(await e('document.querySelector(".chat-activity").dataset.expanded'),"true");assert.equal(await e('document.activeElement.id'),"input-box");record("A08-M3","outside pointer preserves inline reading without stealing new focus");

  // Question choice belongs to the existing store; soft reset must not wipe it.
  await e(`(async()=>{window.askTurns=[{role:"assistant",uuid:"ask",content:[{type:"tool_use",id:"ask-fixture",name:"AskUserQuestion",input:{questions:[{question:"fixture question",options:[{label:"A"},{label:"B"}]}]}}]}];await h.fresh(askTurns);})()`);
  await click('.ask-user-option[data-option-index="1"]');await e('window.o=h.watch(".ask-user-option[data-option-index=\\\"1\\\"]");');
  await e('(async()=>{h.resetChatRenderCache({preserveStickState:true});h.publish(askTurns);h.doRenderChat(true);await h.frames();})()');
  observed=await e('({...o.result(),chosen:h.state.askUserSelections["ask-fixture"][0],selected:o.node.classList.contains("selected")})');checkStable(observed);assert.deepEqual(observed.chosen,[1]);assert.equal(observed.selected,true);record("A04","same-view soft-reset retains real question choice",observed);
  await e('(async()=>{window.askReply=document.querySelector(".assistant-reply-disclosure");h.publish(askTurns.concat([{role:"user",content:[{type:"tool_result",tool_use_id:"ask-fixture",content:"B"}]}]));h.doRenderChat(false);await h.frames();})()');
  assert.equal(await e('document.activeElement===askReply'),true);assert.equal(await e('document.querySelectorAll("button.ask-user-option").length'),0);record("A10","answered/read-only question falls back to same reply, not a div");
  // Schema changes retire choices and active options, not reassign them by option index.
  await e("h.fresh(askTurns)");await click('.ask-user-option[data-option-index="1"]');
  await e('(async()=>{askTurns[0].content[0].input.questions[0].question="different question";h.publish(askTurns);h.doRenderChat(true);await h.frames();})()');
  assert.equal(await e('document.activeElement.matches(".assistant-reply-disclosure")'),true);assert.equal(await e('!!h.state.askUserSelections["ask-fixture"]'),false);record("A10","new question schema does not inherit old choice/control");

  // True retirement: entry → summary; group → reply; entire source/empty → root anchor.
  await freshRead();await focusTab(entry);await e('window.fallbackSummary=document.querySelector("button.chat-process-summary");');
  await e('(async()=>{h.publish([{...focusTurns[0],content:[focusTurns[0].content[0]]}]);h.doRenderChat(false);await h.frames();})()');
  assert.equal(await e('document.activeElement===fallbackSummary'),true);record("A10","entry removed falls back to original same-group summary");
  await focusTab(summary);await e('window.replyNode=document.querySelector(".assistant-reply-disclosure");');
  await e('(async()=>{h.publish([{...focusTurns[0],content:[{type:"text",text:"retired activity"}]}]);h.doRenderChat(false);await h.frames();})()');
  assert.equal(await e('replyNode===null && document.activeElement.matches(".chat-messages[tabindex=\\"-1\\"]")'),true);record("A10","activity-only reply has no outer control; retirement falls back to existing root");
  await e('(async()=>{h.publish([]);h.doRenderChat(false);await h.frames();})()');
  assert.equal(await e('document.activeElement.matches(".chat-messages[tabindex=\\\"-1\\\"]")'),true);record("A10","empty source goes to existing programmatic message anchor");

  // ABA and close/reopen leases: older success/failure cannot write current detail/cache/UI.
  for (const scenario of ["ABA", "close-reopen", "terminal", "Home", "root-unmount", "pagehide"]) {
    plans.push({defer:true,error: scenario==="close-reopen" ? "late error" : undefined,input:{file_path:"fixture.txt"},content:"LATE-OLD",pending:false});
    await e("h.fresh(focusTurns)");await click(summary);await click(entry);await wait('!!document.querySelector(".chat-activity-loading")',"deferred detail");
    assert.equal(deferred.length,1);
    if (scenario==="close-reopen") { await click(entry);plans.push({input:{file_path:"fixture.txt"},content:"NEW-CURRENT",pending:false});await click(entry); }
    else if (scenario==="root-unmount") await e('document.querySelector(".chat-messages").remove();');
    else if (scenario==="pagehide") await e('window.dispatchEvent(new PageTransitionEvent("pagehide"));');
    else {
      await e(`h.state.currentView=${JSON.stringify(scenario==="terminal" ? "terminal" : "chat")};h.state.selectedId=${scenario==="Home" ? "null" : '"focus-B"'};h.clearActivityDetailState();h.resetChatRenderCache();h.publish([{role:"assistant",uuid:"other-view",content:[{type:"text",text:"other view"}]}]);h.doRenderChat(true);`);
    }
    if (scenario==="ABA" || scenario==="close-reopen") {
      if (scenario==="ABA") { await e('h.state.currentView="chat";h.state.selectedId="focus-A";h.clearActivityDetailState();h.resetChatRenderCache();h.publish(focusTurns);h.doRenderChat(true);');await click(summary); }
      // Close-reopen has started the new request; ABA opens it here.
      if (scenario==="ABA") { plans.push({input:{file_path:"fixture.txt"},content:"NEW-CURRENT",pending:false});await click(entry); }
      await wait(`document.querySelector(${JSON.stringify(exact)})?.textContent==="NEW-CURRENT"`,"new incarnation result");await e("h.frames()");
      await focusTab(entry);await e(`window.o=h.watch(${JSON.stringify(entry)});`);
    }
    deferred.shift()();await e("h.frames()");
    if (scenario==="ABA" || scenario==="close-reopen") {
      observed=await e(`({...o.result(),body:document.querySelector(${JSON.stringify(exact)})?.textContent})`);checkStable(observed);assert.equal(observed.body,"NEW-CURRENT");
    } else assert.equal(await e('document.querySelector("#chat-output")?.textContent.includes("LATE-OLD")'),false);
    record("A11",scenario,observed);
    // Clean own fixture lifecycle; no installed navigation or session is claimed.
    await e('h.state.currentView="chat";h.state.selectedId="focus-A";');
  }

  // Real DOM fault injection: stage throw, partial writes, post-write throw → R06 repair.
  for (const fault of ["stage","partial","post-write"]) {
    await freshRead();await focusTab(summary);await e(`window.o=h.watch(${JSON.stringify(summary)});`);
    await e(`(async()=>{
      window.faultOld=h.turns()[0].content[0].thinking;window.faultFailed=false;
      if(${JSON.stringify(fault)}==="stage"){
        const descriptor=Object.getOwnPropertyDescriptor(focusTurns[0].content[0],"thinking");
        Object.defineProperty(focusTurns[0].content[0],"thinking",{configurable:true,get(){throw Error("injected focus stage failure");}});
        try{h.doRenderChat(true);}catch{faultFailed=true;}
        Object.defineProperty(focusTurns[0].content[0],"thinking",descriptor);
      } else if(${JSON.stringify(fault)}==="partial"){
        const original=Node.prototype.insertBefore;let count=0;
        Node.prototype.insertBefore=function(...args){const result=original.apply(this,args);if(this.closest?.(".chat-messages")&&++count===1)throw Error("injected focus partial failure");return result;};
        focusTurns[0].content.push({type:"text",text:"partial addition"});h.publish(focusTurns);
        try{h.doRenderChat(false);}catch{faultFailed=true;}finally{Node.prototype.insertBefore=original;focusTurns[0].content.pop();}
      }else{
        const original=h.state.chatRenderCache.commit;h.state.chatRenderCache.commit=function(){throw Error("injected focus post-write failure");};
        focusTurns[0].content[0].thinking="mutated before post failure";h.publish(focusTurns);
        try{h.doRenderChat(true);}catch{faultFailed=true;}finally{h.state.chatRenderCache.commit=original;focusTurns[0].content[0].thinking=faultOld;}
      }
      h.publish(focusTurns);h.renderChat();await h.frames();
    })()`);
    assert.equal(await e("faultFailed"),true,"fault must actually execute");observed=await e('({...o.result(),pending:h.state.renderPending,body:document.querySelector(".chat-activity-detail-section:last-child pre")?.textContent})');checkStable(observed);assert.equal(observed.pending,false);assert.equal(observed.body,"AAAA");record("A12",fault,observed);
  }

  // Long/short/early+tail dirty frames, unchanged nodes and historical reading anchor.
  await e(`(async()=>{
    const text=(i)=>({role:"assistant",uuid:"history-"+i,createdAt:"2026-09-30T00:00:00Z",content:[{type:"text",text:"history "+i+"\\n"+"reading fixture\\n".repeat(12)}]});
    window.historyTurns=Array.from({length:12},(_,i)=>text(i));historyTurns[8]={...focusTurns[0],uuid:"historical-focus"};
    await h.fresh(historyTurns);document.querySelector(".chat-messages").scrollTop=-1200;await h.frames();
  })()`);
  await e('document.querySelector(".chat-process-summary").scrollIntoView({block:"center"})');await e('h.frames()');
  await openRead();await focusTab(summary);await e(`window.o=h.watch(${JSON.stringify(summary)});window.unchanged=document.querySelector('.chat-message[data-msg-index="5"]');window.total=document.querySelector(".chat-messages");`);
  const performanceSamples=[];
  for (const text of ["LONG ".repeat(400),"Z"]) {
    plans.push({input:{file_path:"fixture.txt"},content:text,pending:false});
    const frame=await e(`(async()=>{await h.acceptDetail("focus-read");const before=o.node.getBoundingClientRect().top-total.getBoundingClientRect().top;historyTurns[0].content[0].text="EARLY ${text.length}";historyTurns[11].content[0].text="TAIL ${text.length}";historyTurns[8].content[0].thinking="historical ${text.length}";h.publish(historyTurns);const started=performance.now();h.doRenderChat(false);const elapsed=performance.now()-started;await h.frames();return {body:document.querySelector(${JSON.stringify(exact)})?.textContent,early:document.querySelector('.chat-message[data-msg-index="0"] .chat-message-content')?.textContent,tail:document.querySelector('.chat-message[data-msg-index="11"] .chat-message-content')?.textContent,unchanged:unchanged===document.querySelector('.chat-message[data-msg-index="5"]'),delta:o.node.getBoundingClientRect().top-total.getBoundingClientRect().top-before,elapsed,scroll:total.scrollTop};})()`);
    result.historicalFrame = frame;
    assert.equal(frame.body,text);assert.ok(frame.early.includes("EARLY "+text.length));assert.ok(frame.tail.includes("TAIL "+text.length));assert.equal(frame.unchanged,true);assert.ok(Math.abs(frame.delta)<=1,"same-owner historical anchor " + frame.delta);assert.ok(frame.scroll<0,"historical focus never snaps to latest");performanceSamples.push(frame.elapsed);record("A03",text.length===1?"short":"long + early/tail",{...frame,bodyLength:frame.body.length,body:undefined});
  }
  observed=await e('o.result()');checkStable(observed);record("A14-M2","historical same-owner anchor and unchanged row",observed);
  plans.push({input:{file_path:"fixture.txt"},content:"line\n".repeat(100),pending:false});
  await e('(async()=>{await h.acceptDetail("focus-read");historyTurns[8].content[0].thinking="long inner result";h.publish(historyTurns);h.doRenderChat(false);await h.frames();window.innerPre=document.querySelector(".chat-activity-timeline");innerPre.scrollTop=120;window.innerBefore=innerPre.scrollTop;})()');
  plans.push({input:{file_path:"fixture.txt"},content:"Z",pending:false});
  const inner=await e(`(async()=>{await h.acceptDetail("focus-read");historyTurns[8].content[0].thinking="inner scroll update";h.publish(historyTurns);h.doRenderChat(false);await h.frames();const next=document.querySelector(".chat-activity-timeline");return {same:innerPre===next,before:innerBefore,after:next.scrollTop,max:next.scrollHeight-next.clientHeight};})()`);
  assert.equal(inner.same,true);assert.equal(inner.after,Math.min(inner.before,inner.max));record("A14-M2","detail scrolling legitimately clamps for shorter result",inner);
  const perf=await e(`(async()=>{const samples=[];const rows=Array.from(document.querySelectorAll(".chat-message"));const mutations=[];const obs=new MutationObserver(r=>mutations.push(...r));obs.observe(total,{childList:true,subtree:true});for(let i=0;i<30;i++){historyTurns[8].content[0].thinking="local update "+i;h.publish(historyTurns);const start=performance.now();h.doRenderChat(false);samples.push(performance.now()-start);}await h.frames();obs.disconnect();return {samples,unchanged:rows.filter(row=>row.getAttribute("data-msg-index")!=="8").every(row=>row.isConnected),outsideTarget:mutations.some(r=>!r.target.closest?.('.chat-message[data-msg-index="8"]')&&r.target!==total)};})()`);
  assert.equal(perf.unchanged,true);assert.equal(perf.outsideTarget,false);record("performance","single-dirty mutation scope",perf);

  // Required mandatory/debt split. Actual results above feed these, never whole-item N/A.
  record("A08-M1","equal-body summary/entry/header geometry",{checkedBy:"A01 and A02; long/short anchor in A03",toleranceCssPx:1});
  record("A08-M2","same original/glyph/ancestor and zero refresh replay",{checkedBy:"A01/A02/A04/A12",replays:0});
  record("A08-M4","real native keys and original glyph host",{checkedBy:"A01/A02/A05",nativeKeyActions:true});
  record("A14-M1","mode interaction conjunction",{reduced:mode.includes("reduce"),checkedBy:"A01-A13 actual results"});
  record("A14-M3","source viewport and document scroll",await e('({width:innerWidth,native:document.documentElement.classList.contains("is-wand-app"),reduce:matchMedia("(prefers-reduced-motion:reduce)").matches,documentScroll:document.scrollingElement.scrollTop,visualViewportTop:visualViewport?.offsetTop||0})'));
  record("A14-M4","no new motion; stable refresh has no new playback",{sourceMotionAdded:0,stableReplays:0,debt:"F07 A08-D1/D2/D3 and A14-D1 intentionally not repaired/not passed"});
}

import { test } from "node:test";
import { mkdirSync } from "node:fs";
test("Ant X production chat retains tool identity, lazy details, focus and reading leases", { timeout: 180_000, skip: process.env.WAND_CHAT_BROWSER !== "1" }, async () => {
  const artifact = resolve(import.meta.dirname, "../output/web-ui-library-migration/chat");
  mkdirSync(artifact, { recursive: true });
  const result = await runFocusBrowser({ matrix: ["desktop", "390px", "native-shell", "reactUi=0", "reduce-motion"], coreOnly: true, output: join(artifact, "chat-browser.json") });
  assert.equal(result.ok, true);
});
test("Ant X production chat preserves pagination, source scopes, retries and late-result invalidation", { timeout: 180_000, skip: process.env.WAND_CHAT_BROWSER !== "1" }, async () => {
  const artifact = resolve(import.meta.dirname, "../output/web-ui-library-migration/chat");
  mkdirSync(artifact, { recursive: true });
  const result = await runFocusBrowser({ matrix: ["desktop"], coreOnly: false, output: join(artifact, "chat-extended-browser.json") });
  assert.equal(result.ok, true);
});

test("Ant X composer and Ant login preserve native input, IME and attachment callbacks", { timeout: 180_000, skip: process.env.WAND_CHAT_BROWSER !== "1" }, async () => {
  const artifact = resolve(import.meta.dirname, "../output/web-ui-library-migration/chat");
  mkdirSync(artifact, { recursive: true });
  const result = await runFocusBrowser({ matrix: ["desktop", "390px", "native-shell", "reactUi=0", "reduce-motion"], controlsOnly: true, output: join(artifact, "composer-login-browser.json") });
  assert.equal(result.ok, true);
});

 test("Ant mobile message copy keeps real touch disclosure and clipboard feedback", {timeout:60_000,skip:process.env.WAND_CHAT_BROWSER!=="1"},async()=>{
  const artifact=resolve(import.meta.dirname,"../output/web-ui-library-migration/chat");mkdirSync(artifact,{recursive:true});
  const result=await runFocusBrowser({touchOnly:true,matrix:["390px"],output:join(artifact,"chat-touch-copy-browser.json")});
  assert.equal(result.ok,true);
});
