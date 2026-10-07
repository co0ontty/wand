// Development-only synthetic fixtures; real dispatch panel/select/styles in Chrome.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const temp = mkdtempSync(join(tmpdir(), "wand-team-dispatch-"));
const root = resolve(import.meta.dirname, "../..");
const bundle = join(temp, "app.js");
await build({ entryPoints: [join(import.meta.dirname, "team-dispatch-browser-harness.tsx")],
  bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: bundle,
  define: { "process.env.NODE_ENV": '"production"' } });
const tailwind = join(temp, "tailwind.css");
execFileSync(process.execPath, [join(root, "node_modules/@tailwindcss/cli/dist/index.mjs"),
  "-i", join(root, "src/web-ui/css/appica.css"), "-o", tailwind], { cwd: root, stdio: "pipe" });

const plan = {
  members: [
    { employeeId: "e_a", name: "前端小美", duty: "Vue3 前端界面", tags: ["前端"], avatar: "", probability: 0.95, isLeader: true },
    { employeeId: "e_b", name: "测试小周", duty: "自动化测试与质量", tags: ["测试"], avatar: "", probability: 0.61, isLeader: false },
  ],
  bench: [{ employeeId: "e_c", name: "后端小强", duty: "Node.js 接口", tags: ["后端"], avatar: "", probability: 0.51, isLeader: false }],
  considered: 3, omitted: 0, threshold: 0.5, maxMembers: 3,
  note: "从 3 名候选里建议 2 人（1 次本地判断）。", decision: { calls: 1, model: "aac6fef/laya-multilingual-mlx", inputTokens: 120 }, experimental: true,
};
let planMode = "success";
let startMode = "success";
let planHolds = 0;
const planCalls = [];
const startCalls = [];

const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/team-dispatch/plan") {
    let raw = ""; for await (const chunk of req) raw += chunk;
    planCalls.push(JSON.parse(raw));
    if (planHolds > 0) planHolds -= 1;
    if (planMode === "reject") { res.statusCode = 400; res.end(JSON.stringify({ error: "本地决策未启用（localDecision.enabled=false），无法用决策模型选人。" })); return; }
    if (planMode === "slow") await new Promise((resolve) => setTimeout(resolve, 600));
    res.end(JSON.stringify(plan));
  } else if (req.url === "/api/team-dispatch/start") {
    let raw = ""; for await (const chunk of req) raw += chunk;
    startCalls.push(JSON.parse(raw));
    if (startMode === "reject") { res.statusCode = 400; res.end(JSON.stringify({ error: "团队开工至少需要 2 名员工（含负责人）。" })); return; }
    res.statusCode = 202;
    res.end(JSON.stringify({ teamId: "t_dispatch_fixture", taskId: "task_fixture", run: { id: "run_fixture", chatSessionId: "chat_fixture", status: "running" }, steps: [] }));
  } else if (req.url === "/app.js") {
    res.setHeader("Content-Type", "text/javascript"); res.end(readFileSync(bundle));
  } else if (req.url === "/styles.css" || req.url === "/tailwind.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(readFileSync(req.url === "/tailwind.css" ? tailwind : join(root, "src/web-ui/content/styles.css")));
  } else {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
      <link rel="stylesheet" href="/styles.css"/><link rel="stylesheet" href="/tailwind.css"/>
      <style>body{margin:0}#root{max-width:900px;margin:auto;padding:14px}
      header#bar{display:flex;justify-content:flex-end;gap:10px;padding:8px 0}</style></head>
      <body><div id="root" data-wand-ui-root></div><div id="overlay-root" data-wand-ui-root><div id="wand-react-ui-portals"></div></div><script src="/app.js"></script></body></html>`);
  }
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let chrome, socket;
const results = [];
const failures = [];
function check(name, ok, detail = "") {
  results.push(name);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  chrome = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0",
      `--user-data-dir=${temp}/profile`, "about:blank"], { stdio: "ignore" });
  const portFile = join(temp, "profile/DevToolsActivePort");
  for (let n = 0; n < 100 && !existsSync(portFile); n++) await sleep(50);
  assert.ok(existsSync(portFile), "Chrome CDP must be available");
  const tabs = await (await fetch(`http://127.0.0.1:${readFileSync(portFile, "utf8").split("\n")[0]}/json`)).json();
  socket = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl); await once(socket, "open");
  let seq = 0; const pending = new Map();
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Runtime.exceptionThrown") console.error("page exception:", msg.params.exceptionDetails?.text ?? "");
    const call = pending.get(msg.id); if (!call) return; pending.delete(msg.id);
    msg.error ? call.reject(Error("CDP failed")) : call.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression, label = expression) => {
    for (let n = 0; n < 120; n++) { if (await evaluate(expression)) return; await sleep(50); }
    throw Error(`condition missing: ${label}; body: ${await evaluate("document.body.textContent")}`);
  };
  const click = async (selector) => {
    await sleep(300);
    const pos = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('missing target ${selector}');n.scrollIntoView({block:'center',behavior:'instant'});const r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    assert.equal(await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return !n.disabled && (n.contains(document.elementFromPoint(${pos.x},${pos.y})) || document.elementFromPoint(${pos.x},${pos.y})?.closest("button") === n)})()`), true,
      `click target obscured: ${selector} ${JSON.stringify(pos)} ${await evaluate(`document.elementFromPoint(${pos.x},${pos.y})?.outerHTML.slice(0,200)`)}`);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...pos, button: "left", clickCount: 1 });
  };
  const text = async (selector, value) => {
    await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  };
  const escape = async () => {
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  };
  const trigger = ".wand-dispatch-body";
  // 同一个按钮依次承担 选人 → 开工（共享组件，标签与语义在原位切换）。
  const planButton = ".wand-dispatch-action";
  const startButton = ".wand-dispatch-action";
  const triggerButton = "button[aria-expanded]";

  await send("Runtime.enable"); await send("Page.enable");
  for (const mode of ["desktop", "390px", "reduce-motion"]) {
    const narrow = mode === "390px", reduced = mode === "reduce-motion";
    await send("Emulation.setDeviceMetricsOverride", { width: narrow ? 390 : 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" }] });
    planMode = "success"; startMode = "success"; planCalls.length = 0; startCalls.length = 0;
    await send("Page.navigate", { url: origin });
    await wait('!!document.querySelector("button[aria-expanded]")', "触发按钮");

    // 收起态：面板不可见、不可聚焦
    check(`[${mode}] 初始收起`, await evaluate(`document.querySelector(${JSON.stringify(triggerButton)}).getAttribute("aria-expanded") === "false"`));
    check(`[${mode}] 收起态面板 inert`, await evaluate(`!!document.querySelector("div[inert]")`));

    const before = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(triggerButton)}).getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()`);
    await click(triggerButton);
    await wait(`document.querySelector(${JSON.stringify(triggerButton)}).getAttribute("aria-expanded") === "true"`, "展开");
    await sleep(reduced ? 80 : 400);
    const after = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(triggerButton)}).getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()`);
    check(`[${mode}] 触发按钮不位移`, Math.abs(before.x - after.x) < 0.6 && Math.abs(before.y - after.y) < 0.6 && Math.abs(before.w - after.w) < 0.6 && Math.abs(before.h - after.h) < 0.6,
      `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    const focused = await (async () => {
      for (let n = 0; n < 60; n++) {
        if (await evaluate(`document.activeElement?.id === "wand-dispatch-note"`)) return true;
        await sleep(50);
      }
      return await evaluate(`document.activeElement?.outerHTML?.slice(0, 160) ?? "none"`);
    })();
    check(`[${mode}] 面板展开且聚焦输入`, focused === true, focused === true ? "" : `activeElement=${focused}`);
    const geometry = await evaluate(`(()=>{
      const t=document.querySelector(${JSON.stringify(triggerButton)}).getBoundingClientRect();
      const p=document.querySelector(${JSON.stringify(trigger)}).getBoundingClientRect();
      const chain=(el)=>{const out=[];let n=el;while(n&&n!==document.body){const r=n.getBoundingClientRect();const cls=typeof n.className==="string"?n.className.split(" ").slice(-2).join("."):"";out.push(n.tagName+"."+cls+"@"+Math.round(r.top));n=n.parentElement}return out};
      return {ok:p.top>=t.bottom-1, button:{top:t.top,bottom:t.bottom,height:t.height}, panel:{top:p.top},
        panelChain:chain(document.querySelector(${JSON.stringify(trigger)})),
        buttonChain:chain(document.querySelector(${JSON.stringify(triggerButton)}))};
    })()`);
    check(`[${mode}] 面板从按钮下方长出`, geometry.ok, JSON.stringify(geometry));
    check(`[${mode}] 展开后没把内容滚出视野`, await evaluate('document.querySelector(".wand-team-member-inner").scrollTop === 0'),
      await evaluate('String(document.querySelector(".wand-team-member-inner").scrollTop)'));
    if (reduced) {
      check(`[${mode}] reduce-motion 下网格过渡瞬时`, await evaluate(`getComputedStyle(document.querySelector(".wand-team-candidate-slot")).transitionDuration.split(",").every(d=>parseFloat(d)<1)`),
        await evaluate(`getComputedStyle(document.querySelector(".wand-team-candidate-slot")).transitionDuration`));
    }

    // 决策失败：原位报错，不弹 Toast、不跳到别处
    planMode = "reject";
    await text("#wand-dispatch-note", "做点事");
    await click(planButton);
    await wait('document.body.textContent.includes("本地决策未启用")', "决策未启用提示");
    check(`[${mode}] 决策不可用时就地报错`, await evaluate('document.body.textContent.includes("本地决策未启用")'));
    check(`[${mode}] 未产生开工请求`, startCalls.length === 0);
    check(`[${mode}] 面板仍开着`, await evaluate(`document.querySelector(${JSON.stringify(triggerButton)}).getAttribute("aria-expanded") === "true"`));

    // 决策成功：建议名单 + 概率 + 负责人 + 备选
    planMode = "success";
    await click(planButton);
    await wait('!!document.querySelector(".wand-dispatch-member")', "建议名单");
    check(`[${mode}] 名单展示概率与负责人`, await evaluate(`(()=>{const rows=[...document.querySelectorAll(".wand-dispatch-member")];return rows.length===3 && rows[0].textContent.includes("95%") && rows[0].textContent.includes("负责人")})()`));
    check(`[${mode}] 建议说明可见`, await evaluate('document.body.textContent.includes("从 3 名候选里建议 2 人")'));
    check(`[${mode}] 备选行给加入入口`, await evaluate('document.body.textContent.includes("点一下加入")'));

    // 取消一名成员 → 负责人顺延，按钮提示最少 2 人
    const secondRow = ".wand-dispatch-members .wand-dispatch-member:nth-child(2) input";
    await click(secondRow);
    await wait('document.body.textContent.includes("至少需要 2 名员工")', "人数下限提示");
    check(`[${mode}] 取消成员后就地提示人数下限`, await evaluate('document.body.textContent.includes("至少需要 2 名员工")'));
    await click(secondRow);
    await wait('!document.body.textContent.includes("至少需要 2 名员工")', "恢复 2 人");

    // 确认开工：回传名单（含负责人），完成后停留再前进
    await click(startButton);
    await wait('!!window.startedRun', "开工回执");
    check(`[${mode}] 开工请求带项目/说明/名单`, JSON.stringify(startCalls[0]?.members) === JSON.stringify([{ employeeId: "e_a", isLeader: true }, { employeeId: "e_b" }])
      && startCalls[0]?.workspaceId === "w1" && startCalls[0]?.note === "做点事", JSON.stringify(startCalls[0]).slice(0, 200));
    check(`[${mode}] 成功后交给调用方并收起`, await evaluate(`document.querySelector(${JSON.stringify(triggerButton)}).getAttribute("aria-expanded") === "false"`));

    // 关闭路径：Esc 与点面板外
    await click(triggerButton);
    await wait(`document.querySelector(${JSON.stringify(triggerButton)}).getAttribute("aria-expanded") === "true"`, "重新展开");
    await escape();
    await wait(`document.querySelector(${JSON.stringify(triggerButton)}).getAttribute("aria-expanded") === "false"`, "Esc 收起");
    check(`[${mode}] Esc 能收起`, true);
    await click(triggerButton);
    await wait(`document.querySelector(${JSON.stringify(triggerButton)}).getAttribute("aria-expanded") === "true"`, "再次展开");
    await click("#outside");
    await wait(`document.querySelector(${JSON.stringify(triggerButton)}).getAttribute("aria-expanded") === "false"`, "外点收起");
    check(`[${mode}] 点面板外能收起`, true);

    if (narrow) {
      check(`[${mode}] 窄屏字段不溢出`, await evaluate(`(()=>{const b=document.querySelector(".wand-dispatch-body");return b.scrollWidth <= b.clientWidth + 1})()`));
    }
  }
} finally {
  socket?.close(); chrome?.kill(); server.close();
  await sleep(200);
  rmSync(temp, { recursive: true, force: true });
  console.log(`\n=== ${results.length - failures.length}/${results.length} 通过 ===`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const item of failures) console.log(`- ${item}`);
    process.exitCode = 1;
  }
}
