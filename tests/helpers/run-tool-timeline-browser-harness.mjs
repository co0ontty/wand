import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { runLiveTimelineCases } from "./tool-timeline-live-cases.mjs";

const root = resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(join(tmpdir(), "wand-tool-timeline-"));
const output = process.env.WAND_TIMELINE_OUTPUT;
const report = { ok: false, cases: [], requests: [], errors: [], removedSelectorHits: [] };
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
let browser, socket, server;
try {
  const bundle = join(temp, "app.js");
  await build({ entryPoints: [join(root, "tests/helpers/tool-timeline-browser-harness.ts")],
    bundle: true, platform: "browser", format: "iife", outfile: bundle,
    define: { "process.env.NODE_ENV": '"production"' } });
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://fixture.test").pathname;
    if (path === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(readFileSync(bundle)); return; }
    if (path === "/style.css") { res.setHeader("Content-Type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); return; }
    if (path.startsWith("/api/sessions/timeline-fixture/tool-content/")) {
      const toolId = path.split("/").pop();
      report.requests.push(toolId);
      const attempt = report.requests.filter(id => id === toolId).length;
      res.setHeader("Content-Type", "application/json");
      if (toolId === "retry-command" && attempt === 1) {
        res.writeHead(503); res.end(JSON.stringify({error:"fixture unavailable"})); return;
      }
      if (toolId === "pending-command" && attempt === 1) {
        res.end(JSON.stringify({input:{command:"npm test"},pending:true,resultAvailable:false})); return;
      }
      const reply = () => res.end(JSON.stringify({ input: { file_path: "src/main.ts" }, content: "DETAIL_ONLY",
        pending: false, resultAvailable: true }));
      if (toolId === "late-command") setTimeout(reply, 200); else reply();
      return;
    }
    if (path.startsWith("/api/")) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<link rel="stylesheet" href="/style.css"><style>#chat-output{height:600px;display:flex}.chat-messages{overflow-y:auto}</style>' +
      '</head><body><div id="chat-output"></div><button id="outside">外部</button><script src="/app.js"></script></body></html>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0",
      `--user-data-dir=${temp}/profile`, origin], { stdio: "ignore" });
  const portFile = join(temp, "profile/DevToolsActivePort");
  for (let n = 0; n < 100 && !existsSync(portFile); n++) await sleep(50);
  assert.ok(existsSync(portFile), "real Chrome required");
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const tab = tabs.find(tab => tab.type === "page" && tab.url.startsWith(origin));
  socket = new WebSocket(tab.webSocketDebuggerUrl); await once(socket, "open");
  const pending = new Map(); let sequence = 0;
  socket.addEventListener("message", event => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Runtime.exceptionThrown") report.errors.push(msg.params.exceptionDetails.text);
    const call = pending.get(msg.id); if (!call) return;
    pending.delete(msg.id); clearTimeout(call.timer);
    if (msg.error) call.reject(Error(JSON.stringify(msg.error))); else call.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolveSend, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error("CDP timeout: " + method)); }, 15000);
    pending.set(id, { resolve: resolveSend, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const e = async expression => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async expression => {
    for (let n = 0; n < 100; n++) { if (await e(expression)) return; await sleep(25); }
    throw Error("condition missing: " + expression);
  };
  const click = async selector => {
    const rect = await e(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:"nearest"});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...rect, button: "left", clickCount: 1 });
  };
  await send("Runtime.enable"); await send("Page.bringToFront");
  await wait("!!window.toolTimelineHarness");
  const modes = process.env.WAND_TIMELINE_MODES?.split(",") || ["desktop", "390px", "native-shell", "reactUi=0", "reduce-motion", "390px-native-reduce"];
  for (const mode of modes) {
    await send("Emulation.setDeviceMetricsOverride", { width: mode.includes("390px") ? 390 : 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode.includes("reduce") ? "reduce" : "no-preference" }] });
    await e(`document.documentElement.classList.toggle("is-wand-app",${mode.includes("native")});history.replaceState(null,"",${JSON.stringify(mode === "reactUi=0" ? "/?reactUi=0" : "/")});`);
    await e(`(async()=>{window.h=toolTimelineHarness;window.resourceTurns=[{role:"user",content:[{type:"text",text:"绘制接口图"}]},{role:"assistant",uuid:"resource-choice",content:[],resourceSelection:{status:"selecting",label:"正在自动选择 Skills / MCP…",skills:[],mcpServers:[]}}];await h.fresh(resourceTurns)})()`);
    assert.equal(await e('document.querySelector(".chat-resource-selection")?.textContent'), '正在自动选择 Skills / MCP…', 'selection progress is a small message, not a blocking composer flow');
    await e(`(()=>{resourceTurns[1]={...resourceTurns[1],content:[{type:"text",text:"正在处理这轮请求"}],resourceSelection:{status:"selected",label:'本轮选择 · Skills：mermaid <img src=x>',skills:["mermaid"],mcpServers:[]}};h.publish(resourceTurns,true)})()`);
    await e('h.settle()');
    assert.equal(await e('document.querySelectorAll(".chat-resource-selection").length'), 1);
    assert.equal(await e('document.querySelector(".chat-resource-selection").textContent'), '本轮选择 · Skills：mermaid <img src=x>');
    assert.equal(await e('document.querySelectorAll(".chat-resource-selection img").length'), 0, 'resource names are escaped');
    assert.equal(await e('parseFloat(getComputedStyle(document.querySelector(".chat-resource-selection")).fontSize) <= parseFloat(getComputedStyle(document.body).fontSize)'), true, 'resource selection uses small text');
    await e('(()=>{resourceTurns[1]={...resourceTurns[1],resourceSelection:{status:"fallback",label:"自动选择超时，沿用手选",skills:[],mcpServers:[]}};h.publish(resourceTurns,true)})()');
    await e('h.settle()');
    assert.equal(await e('document.querySelector(".chat-resource-selection").textContent'), '自动选择超时，沿用手选', 'metadata-only updates repaint the selection label');
    await e('(()=>{resourceTurns[1]={...resourceTurns[1],content:[],resourceSelection:{status:"cancelled",label:"本轮自动选择已取消",skills:[],mcpServers:[]}};h.publish(resourceTurns,false)})()');
    await e('h.settle()');
    assert.equal(await e('document.querySelector(".chat-resource-selection").textContent'), '本轮自动选择已取消');
    assert.equal(await e('document.querySelectorAll(".typing-indicator").length'), 0, 'cancelled resource preparation cannot remain in a loading state');
    report.cases.push({ mode, case: "automatic-resource-notice", ok: true });
    await e(`(async()=>{window.h=toolTimelineHarness;window.fixture=[{role:"assistant",uuid:"timeline-row",content:Array.from({length:40},(_,i)=>({type:"tool_use",id:"call-"+i,name:"Bash",input:{},preview:"npm run check",activity:{kind:"run_command",label:"运行命令 · Bash",occurredAt:"2026-09-30T12:00:"+String(i).padStart(2,"0")+"Z"}}))}];await h.fresh(fixture)})()`);
    assert.equal(await e('document.querySelectorAll(".assistant-reply-disclosure,.chat-avatar").length'), 0, "no outer reply card/avatar");
    const expectedHeight = await e('Math.round(Math.max(120,Math.min(240,document.querySelector(".chat-messages").clientHeight/3)))');
    const initialRequests = report.requests.length;
    const before = await e('document.querySelector("button.chat-process-summary").getBoundingClientRect().toJSON()');
    await e(`(()=>{window.revealFrames=[];const g=document.querySelector('.chat-activity');const menu=g.querySelector('.chat-disclosure-body');const summary=g.querySelector('button.chat-process-summary');function frame(){revealFrames.push({height:menu.getBoundingClientRect().height,y:summary.getBoundingClientRect().y});if(revealFrames.length<24)requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(frame,0)))}requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(frame,0)))})()`);
    // 抽帧只能证明「抓到过中间帧」，机器忙时会漏帧而误报（历史 flaky）。
    // 改成读披露体自己的过渡状态：同 tick 读 getAnimations() 会强制样式更新，
    // 过渡是否真实存在、是否在跑、进度是否 <1 都是确定性的。
    const reveal = await e(`(()=>{
      const g=document.querySelector('.chat-activity');
      const menu=g.querySelector('.chat-disclosure-body');
      const summary=g.querySelector('button.chat-process-summary');
      const read=()=>({height:Math.round(menu.getBoundingClientRect().height),
        transitions:menu.getAnimations().map(a=>({state:a.playState,progress:a.effect?Number(a.effect.getComputedTiming().progress):null}))});
      summary.click();
      return read();
    })()`);
    await e("h.settle()");
    const openedHeight=await e('Math.round(document.querySelector(".chat-activity .chat-disclosure-body").getBoundingClientRect().height)');
    const frames=await e('revealFrames');
    assert.ok(frames.every(f=>Math.abs(f.y-before.y)<=1),"trigger remains fixed during the entire reveal: "+JSON.stringify({before,frames}));
    if(mode.includes('reduce')){
      assert.ok(reveal.transitions.every(a=>a.state!=='running'),'reduced motion has no geometry tween: '+JSON.stringify(reveal));
      assert.ok(reveal.height>=expectedHeight-1,'reduced motion reaches the final height at once: '+JSON.stringify(reveal));
      assert.ok(openedHeight>=expectedHeight-1,'reduced motion keeps the settled height');
    } else {
      assert.ok(reveal.transitions.some(a=>a.state==='running'&&a.progress!==null&&a.progress<1),
        'including the native shell, reveal uses a real reversible height animation: '+JSON.stringify(reveal));
      assert.ok(reveal.height<expectedHeight-1,'the reveal starts from the collapsed height: '+JSON.stringify(reveal));
      assert.ok(openedHeight>=expectedHeight-1,'the reveal settles at the full height');
    }
    assert.equal(report.requests.length, initialRequests, "timeline expansion must not fetch any detail");
    assert.equal(await e('document.querySelectorAll(".chat-call").length'), 40);
    assert.deepEqual(await e('Array.from(document.querySelectorAll(".chat-call[data-tool-ids]")).map(n=>JSON.parse(n.dataset.toolIds))'), Array.from({length:40},(_,i)=>["call-"+i]));
    const metrics = await e('(()=>{const n=document.querySelector(".chat-activity-timeline");return{height:n.clientHeight,overflow:n.scrollHeight>n.clientHeight,detail:!!n.querySelector("pre,.tool-use-card,.inline-diff,.inline-terminal"),summary:document.querySelector("button.chat-process-summary").getBoundingClientRect().toJSON(),wide:document.documentElement.scrollWidth>innerWidth}})()');
    assert.equal(metrics.height, expectedHeight); assert.equal(metrics.overflow, true); assert.equal(metrics.detail, false); assert.equal(metrics.wide, false);
    // 安卓行内顺序是「时钟 + 标签」同行：时钟在前、标签在后，且每行时钟落在同一列。
    const clockLayout = await e(`(()=>{const rows=[...document.querySelectorAll("button.chat-call-button")];
      const clocks=rows.map(row=>row.querySelector("time")).filter(Boolean);
      return {count:clocks.length,
        before:rows.every(row=>{const clock=row.querySelector("time"),label=row.querySelector(".chat-call-label");
          return !clock||!label||clock.getBoundingClientRect().right<=label.getBoundingClientRect().left+1}),
        aligned:new Set(clocks.map(node=>Math.round(node.getBoundingClientRect().left))).size<=1}})()`);
    assert.ok(clockLayout.count>0,"rows carry a clock");
    assert.equal(clockLayout.before,true,"the clock stays before the readable title");
    assert.equal(clockLayout.aligned,true,"every row keeps its clock in the same column");
    for (const axis of ["x","y","width","height"]) assert.ok(Math.abs(metrics.summary[axis]-before[axis])<=1, "summary stays in place: " + axis);
    if (output && (mode === "desktop" || mode === "390px")) {
      mkdirSync(output,{recursive:true});
      const shot = await send("Page.captureScreenshot",{format:"png"}); writeFileSync(join(output,`timeline-summary-${mode}.png`),Buffer.from(shot.data,"base64"));
    }
    report.removedSelectorHits.push({ mode, groups: await e('document.querySelectorAll(".chat-activity-group,.chat-activity-group-title").length'), oldAnimation: await e('document.getAnimations().filter(a=>a.animationName==="activity-menu-in").length') });
    await e('window.entryNode=document.querySelector("button.chat-call-button");entryNode.scrollIntoView({block:"nearest"})');
    await e('h.settle()');
    await e('window.entryRect=entryNode.getBoundingClientRect().toJSON()');
    await click('.chat-call:nth-child(1) button.chat-call-button');
    await wait('document.querySelector(".chat-call-detail")?.textContent.includes("DETAIL_ONLY")'); await e("h.settle()");
    assert.equal(await e('entryNode===document.querySelector("button.chat-call-button")'),true);
    const entryDelta=await e('(()=>{const r=entryNode.getBoundingClientRect();return ["x","y","width","height"].map(k=>r[k]-entryRect[k])})()');
    assert.ok(entryDelta.every(v=>Math.abs(v)<=1),"entry trigger remains fixed: "+JSON.stringify(entryDelta));
    assert.equal(await e('document.querySelectorAll(".chat-call-detail .tool-use-card,.chat-call-detail .inline-terminal,.chat-call-detail .inline-tool-call").length'),0,"no third disclosure level");
    assert.deepEqual(report.requests.slice(initialRequests), ["call-0"], "only the explicitly opened call is loaded");
    assert.equal(await e('document.querySelector(".chat-activity-timeline").clientHeight'), expectedHeight, "details cannot grow the window");
    await click('.chat-call:nth-child(3) button.chat-call-button');
    await wait('document.querySelectorAll(".chat-call[data-expanded=true]").length===2 && [...document.querySelectorAll(".chat-activity-detail-section pre")].filter(n=>n.textContent==="DETAIL_ONLY").length===2');
    assert.deepEqual(report.requests.slice(initialRequests), ["call-0", "call-2"], "opening a call never batch-loads other invocations");
    await e("h.settle()");
    for (let n=0;n<80 && !await e('document.activeElement.matches("button.chat-process-summary")');n++) {
      await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9,modifiers:8});
      await send("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9,modifiers:8});
    }
    assert.equal(await e('document.activeElement.matches("button.chat-process-summary")'),true);
    await e('window.originalSummary=document.activeElement;window.originalGlyph=originalSummary.querySelector("svg");document.querySelector(".chat-activity-timeline").scrollTop=180');
    const top = await e('document.querySelector(".chat-activity-timeline").scrollTop');
    await e('(async()=>{fixture[0].content.push({...fixture[0].content[0],id:"call-40"});h.publish(fixture);await h.settle()})()');
    assert.equal(await e('document.activeElement===originalSummary && originalSummary.isConnected && originalSummary.contains(originalGlyph)'),true,"actual keyboard-focused summary/glyph survives streaming");
    assert.equal(await e('document.querySelector(".chat-activity-timeline").scrollTop'), top, "streaming keeps inner scroll position");
    assert.equal(report.requests.length, initialRequests+2);
    if (output && (mode === "desktop" || mode === "390px")) {
      mkdirSync(output,{recursive:true});
      const shot = await send("Page.captureScreenshot",{format:"png"}); writeFileSync(join(output,`timeline-${mode}.png`),Buffer.from(shot.data,"base64"));
    }
    await click("button.chat-process-summary"); await e("h.settle()");
    assert.equal(await e('document.querySelector(".chat-activity > div > .chat-disclosure-body").getBoundingClientRect().height'), 0);
    assert.equal(await e('document.querySelector(".chat-activity-menu").inert'), true);
    await click("button.chat-process-summary"); await e("h.settle()");
    await send("Input.dispatchKeyEvent", { type:"keyDown", key:"Escape", code:"Escape", windowsVirtualKeyCode:27 });
    await send("Input.dispatchKeyEvent", { type:"keyUp", key:"Escape", code:"Escape", windowsVirtualKeyCode:27 });
    await e("h.settle()"); assert.equal(await e('document.querySelector(".chat-activity").dataset.expanded'),"false");
    await click("button.chat-process-summary"); await click("#outside"); await e("h.settle()");
    assert.equal(await e('document.querySelector(".chat-activity").dataset.expanded'),"true","inline reading is not dismissed by an unrelated pointer");
    // Body-bearing replies retain their existing disclosure and regular copy/identity.
    await e('(async()=>{fixture[0].content.push({type:"text",text:"正式回复"});await h.fresh(fixture)})()');
    assert.equal(await e('document.querySelectorAll(".assistant-reply-disclosure").length'),1);
    // Decisions stay independent but their own details start closed, regardless of general tool defaults.
    const decisionRequestsBefore = report.requests.length;
    await e(`(async()=>{h.state.config={...(h.state.config||{}),cardDefaults:{terminal:true,editCards:true}};window.decisionSummary={mode:"mixed",questions:3,preview:"订单被重复扣款",outcome:"category=billing 84%",label:"category=billing 84% · 3 题 · 订单被重复扣款"};window.decisionUse={type:"tool_use",id:${JSON.stringify('decision-'+mode)},name:"Bash",input:{command:"wand decide --stdin"},semantic:{kind:"decision",summary:decisionSummary},activity:{kind:"run_command",label:"stale metadata"}};window.decisionResult={type:"tool_result",tool_use_id:decisionUse.id,semantic:{kind:"decision",summary:decisionSummary},content:JSON.stringify({runtime:"laya-mlx",experimental:true,answers:{department:{choice:"billing"},unsafe:"<img src=x onerror='globalThis.injected=true'>"}})};await h.fresh([{role:"assistant",uuid:"decision-call",content:[decisionUse]}]);h.publish(h.turns(),true);await h.settle()})()`);
    assert.equal(await e('document.querySelectorAll(".decision-tool-card").length'),1);
    assert.equal(await e('!!document.querySelector(".decision-tool-card").closest(".chat-activity")'),false);
    assert.equal(await e('document.querySelector(".decision-tool-card .chat-tool-header").getAttribute("aria-expanded")'),"false");
    // 收起态就要看得到服务端投影：结论 + 题数 + 被判定内容，两端渲染同一份 label。
    const decisionHead = await e('document.querySelector(".decision-tool-card .decision-tool-summary").textContent');
    assert.ok(decisionHead.includes("category=billing 84% · 3 题 · 订单被重复扣款"), "collapsed decision card shows the projected summary: " + decisionHead);
    assert.ok(decisionHead.endsWith("· 实验性 · 判断中"), "summary stays ahead of the experimental and status labels: " + decisionHead);
    assert.equal(await e('document.querySelector(".decision-tool-card .decision-tool-summary").getAttribute("role")'),"status");
    // 两行卡头：箭头留在标题行右侧（窄屏也不换行到下一行左侧）。
    const decisionHeadBox = await e('(()=>{const h=document.querySelector(".decision-tool-card .chat-tool-header");const toggle=h.querySelector(".chat-disclosure-chevron");const hb=h.getBoundingClientRect();const tb=toggle.getBoundingClientRect();return{sameRow:(tb.top+tb.height/2)<=hb.top+hb.height/2+1,rightGap:hb.right-tb.right}})()');
    assert.equal(decisionHeadBox.sameRow,true,"decision toggle stays on the header's first row: "+JSON.stringify({mode,...decisionHeadBox}));
    assert.ok(decisionHeadBox.rightGap>=0&&decisionHeadBox.rightGap<=20,"decision toggle stays at the trailing edge: "+JSON.stringify({mode,...decisionHeadBox}));
    assert.equal(await e('document.querySelector(".decision-tool-card .chat-tool-body").getAttribute("aria-hidden")'),"true");
    assert.equal(await e('document.querySelector(".decision-tool-card .chat-tool-body").inert'),true);
    assert.equal(await e('document.querySelector(".decision-tool-card .chat-disclosure-body").getBoundingClientRect().height'),0);
    assert.equal(await e('document.querySelector(".decision-tool-card").textContent.includes("判断中")'),true);
    await e('window.decisionHeader=document.querySelector(".decision-tool-card .chat-tool-header");window.decisionArrow=decisionHeader.querySelector(".chat-disclosure-chevron svg");decisionHeader.scrollIntoView({block:"nearest"})');await e('h.settle()');
    const headerBefore=await e('decisionHeader.getBoundingClientRect().toJSON()');
    if(output&&(mode==="desktop"||mode==="390px")){const shot=await send("Page.captureScreenshot",{format:"png"});writeFileSync(join(output,`decision-collapsed-${mode}.png`),Buffer.from(shot.data,"base64"));}
    await click(".decision-tool-card .chat-tool-header");await e('h.settle()');
    assert.equal(await e('document.querySelector(".decision-tool-card").classList.contains("collapsed")'),false);
    assert.equal(await e('decisionHeader===document.querySelector(".decision-tool-card .chat-tool-header")&&decisionHeader.contains(decisionArrow)'),true);
    const headerAfter=await e('decisionHeader.getBoundingClientRect().toJSON()');
    for(const axis of ["x","y","width","height"])assert.ok(Math.abs(headerBefore[axis]-headerAfter[axis])<=1,"decision header stays in place: "+axis+" "+JSON.stringify({mode,before:headerBefore,after:headerAfter}));
    assert.equal(await e('document.querySelector(".decision-tool-card .chat-tool-body").inert'),false);
    await e('(async()=>{h.publish([{role:"assistant",uuid:"decision-call",content:[decisionUse]},{role:"assistant",uuid:"decision-result",content:[decisionResult]}]);await h.settle()})()');
    assert.equal(await e('document.querySelectorAll(".decision-tool-card").length'),1,"late result updates the invocation, not a second card");
    assert.equal(await e('document.querySelector(".decision-tool-card .tool-use-result-content").textContent.includes("billing")'),true);
    assert.equal(await e('document.querySelectorAll(".decision-tool-card img").length'),0,"result text cannot inject HTML");
    assert.equal(report.requests.length,decisionRequestsBefore,"decision disclosure must not prefetch details");
    assert.equal(await e('document.querySelector(".decision-tool-card").classList.contains("collapsed")'),false,"late results preserve explicit expansion");
    await click('.decision-tool-card .chat-tool-header');await e('h.settle()');
    await e('(async()=>{h.publish(h.turns());await h.settle()})()');
    assert.equal(await e('document.querySelector(".decision-tool-card").classList.contains("collapsed")'),true,"refresh preserves explicit collapse");
    assert.equal(await e('document.activeElement===decisionHeader'),true,'decision header keeps keyboard focus after refresh');
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await e('h.settle()');
    assert.equal(await e('document.querySelector(".decision-tool-card").classList.contains("collapsed")'),false,"keyboard opens the same disclosure");
    if(output && (mode==="desktop" || mode==="390px")){const shot=await send("Page.captureScreenshot",{format:"png"});writeFileSync(join(output,`decision-${mode}.png`),Buffer.from(shot.data,"base64"));}
    await e('(async()=>{await h.fresh([{role:"assistant",uuid:"decision-orphan",content:[decisionResult]}])})()');
    assert.equal(await e('document.querySelectorAll(".decision-tool-card").length'),1,"a results-only page stays visible");
    // 迟到的结果页只有结果块：摘要必须从它自己的投影里读出来，没有投影才退回通用文案。
    assert.equal(await e('document.querySelector(".decision-tool-card .decision-tool-summary").textContent.startsWith("category=billing 84%")'),true);
    await e('(async()=>{await h.fresh([{role:"assistant",uuid:"decision-legacy",content:[{...decisionResult,semantic:{kind:"decision"}}]}])})()');
    assert.equal(await e('document.querySelector(".decision-tool-card .decision-tool-summary").textContent.startsWith("选择 / 评分 / 是非判断")'),true,"no projection falls back without inventing a result");
    await e('(async()=>{await h.fresh([{role:"assistant",uuid:"decision-error",content:[{...decisionUse,id:decisionUse.id+"-error"},{...decisionResult,tool_use_id:decisionUse.id+"-error",is_error:true,content:"CONTEXT_LIMIT"}]}])})()');
    assert.equal(await e('!!document.querySelector(".decision-tool-card.error.collapsed")'),true,"new errors keep the collapsed default");
    await click('.decision-tool-card .chat-tool-header');await e('h.settle()');
    assert.equal(await e('!!document.querySelector(".decision-tool-card.error:not(.collapsed)")'),true);
    assert.equal(await e('document.querySelector(".decision-tool-card").textContent.includes("CONTEXT_LIMIT")'),true);
    assert.equal(await e('document.documentElement.scrollWidth > innerWidth'),false);
    await e('(async()=>{await h.fresh([{role:"assistant",uuid:"decision-truncated",content:[decisionUse,{...decisionResult,content:"SHORT_PART",_truncated:true}]}]);window.decisionButton=document.querySelector(".decision-result-load")})()');
    if(await e('document.querySelector(".decision-tool-card").classList.contains("collapsed")'))await click('.decision-tool-card .chat-tool-header');await e('decisionButton.scrollIntoView({block:"nearest"})');await e('h.settle()');
    const loadBounds=await e('decisionButton.getBoundingClientRect().toJSON()');
    await click('.decision-result-load');await wait('document.querySelector(".decision-tool-card").textContent.includes("DETAIL_ONLY")');await e('h.settle()');
    assert.equal(await e('decisionButton===document.querySelector(".decision-result-load")'),true,"detail loading keeps the same feedback button");
    const loadedBounds=await e('decisionButton.getBoundingClientRect().toJSON()');
    for(const axis of ["x","y","width","height"])assert.ok(Math.abs(loadBounds[axis]-loadedBounds[axis])<=1,"decision load feedback stays in place: "+axis+" "+JSON.stringify({mode,before:loadBounds,after:loadedBounds}));
    await e('(async()=>{h.publish([{role:"assistant",uuid:"decision-truncated",content:[decisionUse,{...decisionResult,content:"NEW_LIVE_RESULT"}]}]);await h.settle()})()');
    assert.equal(await e('document.querySelector(".decision-tool-card").textContent.includes("NEW_LIVE_RESULT")'),true,"late full result wins over cached detail");
    report.cases.push({ mode, panelHeight:expectedHeight, rows:40, requestCount:2, stableScroll:true, closePaths:true, decisionIndependent:true, decisionPendingErrorAndOrphan:true, decisionFeedbackStable:true, decisionDefaultCollapsed:true, decisionHeaderStable:true });
    await runLiveTimelineCases({ e, send, click, wait, mode, report });
  }
  // 收起态行首时间：没有展开时也能一眼看到「什么时候跑的」，位置在分类计数之前。
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await e('document.documentElement.classList.remove("is-wand-app")');
  await e('(async()=>{window.h=toolTimelineHarness;await h.fresh([{role:"assistant",uuid:"summary-time",content:[{type:"thinking",thinking:"planning"},{type:"tool_use",id:"cmd-1",name:"Bash",input:{},activity:{kind:"run_command",label:"运行命令 · Bash",occurredAt:"2026-09-30T12:03:10Z"}}]}])})()');
  const lead = await e('(()=>{const s=document.querySelector("button.chat-process-summary");const meta=s.querySelector(".chat-activity-meta");const clock=meta&&meta.firstElementChild;const first=meta&&meta.querySelector(".chat-activity-meta-item");return{tag:clock&&clock.tagName,clock:clock&&clock.textContent.trim(),first:first&&first.textContent,expanded:s.getAttribute("aria-expanded"),before:!!clock&&!!first&&clock.getBoundingClientRect().right<=first.getBoundingClientRect().left}})()');
  assert.equal(lead.tag, "TIME", "collapsed summary starts with the command time");
  assert.match(lead.clock ?? "", /^\d{2}:\d{2}:\d{2}$/, "collapsed summary shows a real clock");
  assert.equal(lead.first, "深度思考", "the time precedes the thinking/count text");
  assert.equal(lead.expanded, "false", "the time is visible while the timeline stays closed");
  assert.equal(lead.before, true, "collapsed summary renders the time before its summary items");
  report.cases.push({ mode: "collapsed-summary-time", clock: lead.clock, first: lead.first });
  if (output) {
    mkdirSync(output,{recursive:true});
    const shot = await send("Page.captureScreenshot",{format:"png"});
    writeFileSync(join(output,"collapsed-summary-time.png"),Buffer.from(shot.data,"base64"));
  }
  // Compact data must remain useful before any detail request is made.
  await e(`(async()=>{await h.fresh([{role:"assistant",uuid:"preview-row",content:[
    {type:"tool_use",id:"preview-call",name:"Bash",input:{},preview:"npm run check",activity:{kind:"run_command",label:"运行命令 · Bash"}},
    {type:"tool_result",tool_use_id:"preview-call",content:"",_truncated:true,is_error:true,preview:"退出码 1 · TypeError: missing element"}
  ]}])})()`);
  const previewRequests = report.requests.length;
  assert.doesNotMatch(await e('document.querySelector("button.chat-process-summary").textContent'), /npm run check|退出码 1/);
  assert.equal(await e('document.querySelector(".chat-activity > div > .chat-disclosure-body").getBoundingClientRect().height'), 0);
  await click('button.chat-process-summary'); await e('h.settle()');
  // 输入与结果各占一行（对齐安卓的摘录行）：输入看 .chat-call-preview，结果看 .chat-call-result。
  assert.match(await e('document.querySelector(".chat-call-preview").textContent'), /npm run check/);
  assert.match(await e('document.querySelector(".chat-call-result").textContent'), /TypeError/);
  assert.equal(report.requests.length, previewRequests, 'summary and timeline do not fetch bodies');
  assert.equal(await e('document.querySelector(".chat-call").dataset.status'), 'error');
  report.cases.push({mode:'compact-preview',collapsedOverviewOnly:true,inputVisible:true,resultVisible:true,noDetailFetch:true});
  // Pending -> complete hydrates once; retries and stale responses never reopen a closed row.
  for (const kind of ["pending-command", "retry-command", "late-command"]) {
    await e(`(async()=>{await h.fresh([{role:"assistant",uuid:${JSON.stringify(kind)},content:[
      {type:"tool_use",id:${JSON.stringify(kind)},name:"Bash",input:{},preview:"npm test",activity:{kind:"run_command",label:"运行命令 · Bash"}}
    ]}])})()`);
    await click('button.chat-process-summary'); await click('button.chat-call-button');
    if (kind === "pending-command") {
      await wait('!!document.querySelector(".chat-activity-pending-detail")');await e('h.settle()');
      await e('window.pendingHeader=document.querySelector("button.chat-call-button");window.pendingBounds=pendingHeader.getBoundingClientRect().toJSON()');
      await e('h.turns()[0].content.push({type:"tool_result",tool_use_id:"pending-command",content:"",_truncated:true,preview:"tests passed"});h.publish(h.turns())');
      await wait('document.querySelector(".chat-activity-detail-content").textContent.includes("DETAIL_ONLY")');await e('h.settle()');
      assert.equal(report.requests.filter(id=>id===kind).length,2);
      assert.equal(await e('pendingHeader===document.querySelector("button.chat-call-button")'),true);
      assert.ok(await e('["x","y","width","height"].every(k=>Math.abs(pendingHeader.getBoundingClientRect()[k]-pendingBounds[k])<=1)'),"late result keeps the exact trigger rectangle");
    } else if (kind === "retry-command") {
      await wait('!!document.querySelector(".chat-activity-retry")');await e('h.settle()');
      await click('.chat-activity-retry');
      await wait('document.querySelector(".chat-activity-detail-content").textContent.includes("DETAIL_ONLY")');
      assert.equal(report.requests.filter(id=>id===kind).length,2);
    } else {
      await wait('!!document.querySelector(".chat-activity-loading")');
      await click('button.chat-call-button'); await sleep(300); await e('h.settle()');
      assert.equal(await e('document.querySelector(".chat-call").dataset.expanded'),"false");
      assert.equal(await e('document.querySelector(".chat-call-detail").inert'),true);
    }
    report.cases.push({mode:kind,ok:true});
  }
  // File actions stay lazy and describe the CURRENT file, not an old invocation result.
  await e(`(async()=>{await h.fresh([{role:"assistant",uuid:"file",content:[
    {type:"tool_use",id:"file-only",name:"Read",input:{},activity:{kind:"read_file",label:"查看文件",fileKey:"opaque"}}
  ]}]);h.state.sessions[0].cwd="/repo";window.openedPath=null;window.__openFilePreview=p=>{window.openedPath=p}})()`);
  const fileRequests=report.requests.length;
  await click('button.chat-process-summary');await click('button.chat-call-button');await e('h.settle()');
  assert.equal(report.requests.length,fileRequests);
  assert.equal(await e('document.querySelectorAll(".chat-activity-file-open").length'),1);
  await click('.chat-activity-file-open');await wait('openedPath==="/repo/src/main.ts"');await e('h.settle()');
  assert.equal(report.requests.length,fileRequests+1);
  await e('document.querySelector("button.chat-call-button").focus({preventScroll:true})');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await e('h.settle()');
  assert.equal(await e('document.querySelector(".chat-call").dataset.expanded'),"false");
  assert.equal(await e('document.querySelector(".chat-activity").dataset.expanded'),"true","Escape closes the innermost disclosure first");
  report.cases.push({mode:'file-action',lazy:true,currentFile:true,innerEscape:true});
  assert.deepEqual(report.errors, []); assert.ok(report.removedSelectorHits.every(x=>x.groups===0 && x.oldAnimation===0));
  report.ok = true; console.log(JSON.stringify(report));
} catch (error) {
  report.failure=String(error.stack||error); throw error;
} finally {
  if (output) { mkdirSync(output,{recursive:true}); writeFileSync(join(output,"browser-results.json"),JSON.stringify(report,null,2)); }
  socket?.close();
  if (browser && browser.exitCode===null) { browser.kill("SIGKILL"); await once(browser,"exit"); }
  if (server?.listening) await new Promise(resolveClose=>server.close(resolveClose));
  rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
