import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import { build } from "esbuild";

test("IM execution cards keep answers, approvals and stop bound to their source session", {
  skip: process.env.WAND_CONVERSATIONS_BROWSER !== "1", timeout: 180_000,
}, async t => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-im-activity-"));
  const evidence = process.env.WAND_CONVERSATION_EVIDENCE_DIR || join(root, "output/im-reference-20261007/activity-browser");
  mkdirSync(evidence, { recursive: true });
  const question = { type: "tool_use", id: "same-question", name: "request_user_input", input: {}, semantic: { kind: "question_request", questions: [
    { question: "在哪个环境执行？", multiSelect: false, options: [{ label: "测试环境" }, { label: "本机" }] },
  ] } };
  const sessions = Object.fromEntries(["A", "B", "C", "D"].map(id => [id, { id, status: "idle", sessionKind: "structured",
    structuredState: { inFlight: false, activeRequestId: null, runner: "pi-cli-json", lastError: null },
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: `${id}：检查环境与范围` }, question], author: { id, name: `员工 ${id}`, sessionId: id }, createdAt: "2026-10-07T10:00:00Z" }],
  }])) as Record<string, any>;
  sessions.B.pendingEscalation = { requestId: "permission-B", scope: "run_command", runner: "json", source: "tool_permission_request", reason: "只读检查本机状态", target: "pwd" };
  sessions.B.permissionBlocked = true;
  sessions.B.structuredState = { ...sessions.B.structuredState, inFlight: true, activeRequestId: "request-B", turnStartedAt: "2026-10-07T10:00:00Z" };
  sessions.D.messages.push({ role: "user", content: [{ type: "text", text: "已经开始新的话题" }] });
  const requests: { id: string; path: string; body: any }[] = [];
  const source = `
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import { WandUiProvider } from "./src/web-ui/react/theme";
    import { installReactUiStyles } from "./src/web-ui/react/styles";
    import { useConversationActivity } from "./src/web-ui/react/conversations/activity";
    import { ConversationMessages } from "./src/web-ui/react/ai-teams/team-chat-view";
    const question = ${JSON.stringify(question)};
    installReactUiStyles();
    function App() {
      const [id,setId]=React.useState("A");
      const detail=React.useMemo(()=>({id:"dm_"+id,title:"员工 "+id,kind:"dm",communicationSessionId:id,runDetails:[],messages:[{
        role:"assistant",messageId:id+":turn",author:{id,name:"员工 "+id,sessionId:id},createdAt:"2026-10-07T10:00:00Z",
        content:[{type:"thinking",thinking:id+"：检查环境与范围"},question]}]}),[id]);
      const activity=useConversationActivity({detail,active:true});
      return <div style={{height:"100dvh",display:"flex",flexDirection:"column",minWidth:0}}>
        <nav>{["A","B","C","D"].map(value=><button id={"open-"+value} onClick={()=>setId(value)} key={value}>员工 {value}</button>)}</nav>
        <div className="conversation-message-scroll" style={{overflow:"auto",flex:1,minHeight:0}}><ConversationMessages key={id} turns={detail.messages}
          taskLabels={{}} group={false} renderActivity={activity.renderActivity} onOpenConversation={()=>{}}/></div>
        {activity.controls}
      </div>;
    }
    createRoot(document.getElementById("root")).render(<WandUiProvider><App/></WandUiProvider>);
  `;
  await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, format: "iife", platform: "browser", jsx: "automatic",
    outfile: join(temp, "app.js"), logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } });
  const app = express(); app.use(express.json());
  app.get("/api/sessions/:id", (req, res) => res.json(sessions[req.params.id]));
  app.get("/api/sessions/:id/tool-content/:toolId", (req, res) => res.json({ input: { source: req.params.id }, content: `来自 ${req.params.id} 的结果`, is_error: false, pending: false }));
  app.post("/api/sessions/:id/*", (req, res) => {
    const id = req.params.id; requests.push({ id, path: req.path, body: req.body });
    if (id === "C") { res.status(503).json({ error: "测试未知送达" }); return; }
    if (req.path.endsWith("/input")) sessions[id].messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "same-question", content: req.body.input }] });
    if (req.path.includes("/escalations/")) { sessions[id].pendingEscalation = null; sessions[id].permissionBlocked = false; }
    if (req.path.endsWith("/stop")) { sessions[id].status = "stopped"; sessions[id].structuredState.inFlight = false; }
    res.status(202).json({ accepted: true });
  });
  app.get("/api/user-profile", (_req, res) => res.json({ name: "我" }));
  app.get("/app.js", (_req, res) => res.type("js").send(readFileSync(join(temp, "app.js"))));
  app.get("/styles.css", (_req, res) => res.type("css").send(readFileSync(join(root, "src/web-ui/content/styles.css"))));
  app.get("/tailwind.css", (_req, res) => res.type("css").send(readFileSync(join(root, "src/web-ui/content/tailwind.css"))));
  app.get("*", (_req, res) => res.type("html").send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"><div id="root"></div><script src="/app.js"></script>'));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${temp}/profile`, "about:blank"], { stdio: "ignore" });
  const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
  let socket: WebSocket | undefined;
  t.after(async () => { socket?.close(); chrome.kill(); server.close(); await pause(150); rmSync(temp, { recursive: true, force: true }); });
  for (let n = 0; n < 200 && !existsSync(join(temp, "profile/DevToolsActivePort")); n++) await pause(50);
  const port = readFileSync(join(temp, "profile/DevToolsActivePort"), "utf8").split("\n")[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as any[];
  socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl); await once(socket, "open");
  let sequence = 0; const pending = new Map<number, (result: any) => void>(); const errors: string[] = [];
  socket.addEventListener("message", event => { const value = JSON.parse(String(event.data));
    if (value.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(value.params));
    if (value.id) { pending.get(value.id)?.(value); pending.delete(value.id); } });
  const send = async (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise(resolve => {
    const id = ++sequence; pending.set(id, resolve); socket!.send(JSON.stringify({ id, method, params }));
  }).then((value: any) => { if (value.error) throw new Error(JSON.stringify(value.error)); return value.result; });
  const evaluate = async (expression: string): Promise<any> => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const wait = async (expression: string): Promise<void> => {
    for (let n = 0; n < 160; n++) { if (await evaluate(expression)) return; await pause(50); }
    throw new Error(`Timed out: ${expression}; ${await evaluate("document.body.innerText")}; ${errors.join("\n")}`);
  };
  const click = async (selector: string): Promise<void> => {
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
    let point: { x: number; y: number; hit: boolean } | null = null;
    for (let attempt = 0; attempt < 80; attempt++) {
      await pause(60);
      const next = await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});const r=node.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:node.contains(document.elementFromPoint(x,y))}})()`);
      if (point && next.hit && Math.abs(point.x - next.x) < 0.2 && Math.abs(point.y - next.y) < 0.2) { point = next; break; }
      point = next;
    }
    assert.ok(point?.hit, `visible click target ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    await pause(120);
  };
  const clickText = async (text: string): Promise<void> => {
    const selector = await evaluate(`(()=>{const node=[...document.querySelectorAll('button')].find(node=>node.textContent.trim()===${JSON.stringify(text)});if(!node)return null;node.dataset.testAction='current';return '[data-test-action="current"]'})()`);
    assert.ok(selector, `button ${text} exists`); await click(selector);
    await evaluate("document.querySelector('[data-test-action]')?.removeAttribute('data-test-action')");
  };
  const screenshot = async (name: string) => { const png = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(evidence, `${name}.png`), Buffer.from(png.data, "base64")); };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${address.port}` });
  await wait("!!document.querySelector('.conversation-question textarea')");
  await click('.conversation-question input[value="测试环境"]');
  await click(".conversation-question textarea"); await send("Input.insertText", { text: "只读检查" });
  await click("#open-B"); await wait("!!document.querySelector('[data-activity-session=" + '"B"' + "]')");
  assert.equal(await evaluate("document.querySelector('.conversation-question textarea').value"), "");
  await click("#open-A"); await wait("document.querySelector('.conversation-question textarea')?.value==='只读检查'");
  assert.equal(await evaluate("document.querySelector('.conversation-question input[value=\"测试环境\"]').checked"), true);
  await clickText("提交并继续"); await wait("!document.querySelector('.conversation-question')");
  assert.deepEqual(requests[0], { id: "A", path: "/api/sessions/A/input", body: { input: "测试环境；只读检查", view: "chat", respondImmediately: true } });
  await click(".conversation-turn-activity > .ant-collapse .ant-collapse-header");
  await wait("!!document.querySelector('.conversation-tool-activity .ant-collapse-header')");
  await click(".conversation-tool-activity .ant-collapse-header");
  await wait("document.body.innerText.includes('来自 A 的结果')");
  await screenshot("desktop-result");
  await click("#open-B"); await wait("!!document.querySelector('[data-activity-session=" + '"B"' + "]')");
  await clickText("批准本次"); await wait("document.body.innerText.includes('停止本轮')");
  assert.ok(requests.some(request => request.id === "B" && request.path === "/api/sessions/B/escalations/permission-B/resolve" && request.body.resolution === "approve_once"));
  await clickText("停止本轮"); await wait("!document.body.innerText.includes('停止本轮')");
  assert.ok(requests.some(request => request.id === "B" && request.path === "/api/sessions/B/stop"));
  await click("#open-C"); await wait("!!document.querySelector('.conversation-question textarea')");
  await click(".conversation-question textarea"); await send("Input.insertText", { text: "自定义回答" });
  await clickText("提交并继续"); await wait("document.body.innerText.includes('送达尚未确认')");
  await click("#open-D"); await pause(300); assert.equal(await evaluate("!!document.querySelector('.conversation-question')"), false);
  await click("#open-C"); await wait("document.body.innerText.includes('送达尚未确认')");
  assert.equal(await evaluate("[...document.querySelectorAll('.conversation-question button')].find(node=>node.textContent.includes('等待核对')).disabled"), true);
  assert.equal(requests.filter(request => request.id === "C").length, 1);
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await pause(300);
  assert.ok(await evaluate("document.documentElement.scrollWidth<=innerWidth"), "mobile card does not overflow horizontally");
  await screenshot("mobile-unknown-answer");
  assert.deepEqual(errors, []);
  writeFileSync(join(evidence, "verification.json"), JSON.stringify({ requests, exceptions: errors, answerPreserved: true, unknownNotResent: true, mobileWidth: 390 }, null, 2));
});
