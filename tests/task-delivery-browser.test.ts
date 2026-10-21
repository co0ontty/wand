import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openPlushBrowser } from "./helpers/run-plush-avatar-browser-harness.mjs";

test("task delivery browser preserves drafts, exact continuation and explicit acceptance", { timeout: 180_000, skip: process.env.WAND_TASK76_BROWSER !== "1" }, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-task76-browser-"));
  const output = join(root, "output/architecture-stage2/task-76/browser"); mkdirSync(output, { recursive: true });
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import React from "react"; import {createRoot} from "react-dom/client";
    import {WandUiProvider} from "./src/web-ui/react/theme";
    import {TaskSessionSummary} from "./src/web-ui/react/issues/task-session-summary";
    import {TaskAcceptanceEditor} from "./src/web-ui/react/issues/task-acceptance";
    const s={provider:"pi",sessionKind:"structured",cwd:"/repo",model:"fixture",thinkingEffort:"off"};
    window.qa={opened:[],parallel:0,saved:0,accepted:0};
    function App(){const [visible,setVisible]=React.useState(true); const [task,setTask]=React.useState({id:"qa-task",status:"doing",assignedExecutor:{id:"owner",name:"主负责人"},sessions:[{...s,id:"ended",title:"独立范围A",purpose:"实现并交付 output/report-a.md",status:"exited"},{...s,id:"waiting",title:"独立范围B",purpose:"部署核对与验收",status:"waiting-input"}],acceptance:null});
      qa.poll=()=>setTask(t=>({...t,sessions:t.sessions.map(s=>({...s}))}));
      return <main style={{maxWidth:900,padding:16,boxSizing:"border-box"}}><button id="toggle" onClick={()=>setVisible(x=>!x)}>切换详情</button><TaskSessionSummary task={task} onOpenSession={id=>qa.opened.push(id)} onNewParallel={()=>qa.parallel++}/>{visible&&<TaskAcceptanceEditor task={task} children={[]} busy={false} onSave={async acceptance=>{qa.saved++;if(acceptance.acceptedAt)qa.accepted++;setTask(t=>({...t,acceptance}));return true;}}/>}</main>;
    } createRoot(document.getElementById("root")).render(<WandUiProvider><App/></WandUiProvider>);
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("content-type", "application/javascript"); res.end(readFileSync(join(temp, "app.js"))); }
    else { res.setHeader("content-type", "text/html"); res.end('<!doctype html><html lang="zh"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="root"></div><script src="/app.js"></script></body></html>'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object");
  const browser = await openPlushBrowser(); const { evaluate, send, wait } = browser;
  const click = async (selector: string) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`); await browser.settle();
    const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`); assert.ok(point, selector);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 }); await browser.settle();
  };
  const button = (text: string) => `button[data-qa-action="${text}"]`;
  const markButton = async (text: string) => { await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)});if(b)b.dataset.qaAction=${JSON.stringify(text)}})()`); return button(text); };
  const cases = [];
  try {
    for (const mode of ["desktop", "390px", "reduced-motion"]) {
      await send("Emulation.setDeviceMetricsOverride", { width: mode === "390px" ? 390 : 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduced-motion" ? "reduce" : "no-preference" }] });
      await send("Page.navigate", { url: `http://127.0.0.1:${address.port}/` }); await wait("!!document.querySelector('[aria-label=多会话交付汇总]')");
      assert.equal(await evaluate("qa.accepted"), 0);
      assert.equal(await evaluate("document.body.innerText.includes('已结束 1 · 等待输入 1')"), true);
      await click(".ant-collapse-header"); await wait("!!document.querySelector('[aria-label=\"继续已有会话：独立范围A\"]')");
      await click('[aria-label="继续已有会话：独立范围A"]'); assert.deepEqual(await evaluate("qa.opened"), ["ended"]);
      const evidence = '[aria-label="交付证据与产物"]'; const blocker = '[aria-label="验收阻塞"]';
      await click(evidence); await send("Input.insertText", { text: "A: output/report-a.md；B: 等待部署核对" });
      await click(blocker); await send("Input.insertText", { text: "等待部署：尚未安装新版" });
      await evaluate("qa.poll()"); await browser.settle();
      assert.equal(await evaluate(`document.querySelector('${blocker}').value`), "等待部署：尚未安装新版");
      await click("#toggle"); await click("#toggle");
      assert.equal(await evaluate(`document.querySelector('${blocker}').value`), "等待部署：尚未安装新版");
      assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='确认验收通过').disabled"), true);
      await click(await markButton("保存交付与缺口")); await wait("qa.saved===1"); assert.equal(await evaluate("qa.accepted"), 0);
      await browser.screenshot(join(output, mode + "-blocked.png"));
      await click(blocker);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4, commands: ["selectAll"] });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4 });
      for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      await browser.settle();
      await click(await markButton("确认验收通过")); await wait("qa.accepted===1");
      assert.equal(await evaluate("document.body.innerText.includes('验收通过 · 已完成')"), true);
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
      await browser.screenshot(join(output, mode + "-accepted.png"));
      cases.push({ mode, noImplicitAcceptance: true, exactContinuation: true, blockerGate: true, draftPreserved: true, overflow: false });
    }
    assert.deepEqual(browser.errors, []); writeFileSync(join(output, "result.json"), JSON.stringify({ ok: true, cases }, null, 2));
  } catch (error) { await browser.screenshot(join(output, "failure.png")); writeFileSync(join(output, "failure.json"), JSON.stringify({ error: String(error), errors: browser.errors }, null, 2)); throw error; }
  finally { await browser.close(); server.close(); rmSync(temp, { recursive: true, force: true }); }
});
