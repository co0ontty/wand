import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openPlushBrowser } from "./helpers/run-plush-avatar-browser-harness.mjs";

test("task assignee browser keeps employee avatar and identity above execution tools", { timeout: 180_000, skip: process.env.WAND_TASK73_BROWSER !== "1" }, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-task73-browser-"));
  const output = join(root, "output/architecture-stage2/task-73/browser"); mkdirSync(output, { recursive: true });
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import React from "react"; import {createRoot} from "react-dom/client";
    import {WandUiProvider} from "./src/web-ui/react/theme";
    import {TaskBoardAgentChips} from "./src/web-ui/react/issues/task-executor-chips";
    import {TaskBoardCardDetail, TaskBoardAgentSessionList} from "./src/web-ui/react/issues/task-board-views";
    const base={provider:"pi",sessionKind:"structured",cwd:"/repo",model:"fixture",thinkingEffort:"off",title:"原执行记录",status:"running"};
    const assigned={provider:"pi",model:"fixture",mode:"managed",kind:"structured"};
    const subject={type:"employee",id:"e1"}; const assignee={id:"e1",name:"赛博虎妞",avatar:"cat:1"};
    const sessions=[{...base,id:"employee",employeeId:"e1"}];
    const task={id:"task",identifier:"TASK-73",title:"负责人展示",description:"任务说明",status:"doing",priority:"medium",labels:[],createdAt:"2026-10-21",updatedAt:"2026-10-21",sessions,agent:assigned,executionSubject:subject,assignedExecutor:assignee};
    window.qa={opened:[]};
    const chips=(id,s,a=assignee,sub=subject)=><section id={id}><h2>{id}</h2><TaskBoardAgentChips sessions={s} assigned={assigned} subject={sub} assignee={a}/></section>;
    createRoot(document.getElementById("root")).render(<WandUiProvider><main style={{maxWidth:900,padding:16,boxSizing:"border-box"}}>
      {chips("employee",sessions)}
      {chips("planned",[])}
      {chips("history",[{...base,id:"old",employeeId:"old",employeeName:"历史员工",employeeAvatar:"cat:3"},{...base,id:"cli"}])}
      {chips("long",[],{...assignee,name:"很长的员工负责人名称用于核对窄屏不会裁切头像或把名字误作工具"})}
      {chips("missing",[{...base,id:"missing",employeeId:"missing"}],null,null)}
      <section id="detail"><TaskBoardCardDetail task={task} open={true} childCount={0} onOpen={()=>{}} onCollapse={()=>{}} onOpenSession={id=>qa.opened.push(id)}/></section>
      <section id="records"><TaskBoardAgentSessionList sessions={sessions} assigned={assigned} subject={subject} assignee={assignee} onOpenSession={id=>qa.opened.push(id)}/></section>
    </main></WandUiProvider>);
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("content-type", "application/javascript"); res.end(readFileSync(join(temp, "app.js"))); }
    else if (req.url === "/styles.css") { res.setHeader("content-type", "text/css"); res.end(readFileSync(join(root, "src/web-ui/content/styles.css"))); }
    else if (req.url?.startsWith("/api/")) { res.setHeader("content-type", "application/json"); res.statusCode = 503; res.end('{"error":"fixture employee directory unavailable"}'); }
    else { res.setHeader("content-type", "text/html"); res.end('<!doctype html><html lang="zh"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><body style="margin:0;overflow:auto"><div id="root"></div><script src="/app.js"></script></body></html>'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object");
  const browser = await openPlushBrowser(); const cases = [];
  try {
    for (const mode of ["desktop", "390px", "native-shell", "reactUi=0"]) {
      await browser.send("Emulation.setDeviceMetricsOverride", { width: mode === "390px" ? 390 : 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
      await browser.send("Page.navigate", { url: `http://127.0.0.1:${address.port}/${mode === "reactUi=0" ? "?reactUi=0" : ""}` });
      await browser.wait("!!document.querySelector('#employee .wand-employee-avatar')");
      if (mode === "native-shell") await browser.evaluate("document.documentElement.classList.add('is-wand-app')");
      await browser.settle();
      for (const id of ["employee", "planned", "detail", "records"]) {
        const data = await browser.evaluate(`(()=>{const n=document.querySelector('#${id}');return {text:n.innerText,avatars:n.querySelectorAll('.wand-employee-avatar').length}})()`);
        assert.ok(data.text.includes("赛博虎妞"), id); assert.ok(data.text.includes("Pi"), id); assert.ok(data.avatars > 0, JSON.stringify({ id, ...data }));
      }
      const history = await browser.evaluate("document.querySelector('#history').innerText");
      assert.ok(history.includes("历史员工")); assert.ok(history.includes("Pi · 执行中"), "direct CLI remains a tool, not relabeled as current owner");
      assert.equal(await browser.evaluate("document.querySelector('#history [aria-label=任务执行者] .ant-tag').innerText.includes('赛博虎妞')"), true, "current owner remains first");
      assert.ok((await browser.evaluate("document.querySelector('#missing').innerText")).includes("员工（资料不可用）"));
      await browser.click("#records .task-board-agent-session");
      assert.deepEqual(await browser.evaluate("qa.opened"), ["employee"], "exact continuation target preserved");
      assert.equal(await browser.evaluate("document.documentElement.scrollWidth<=innerWidth"), true, mode + " overflow");
      await browser.screenshot(join(output, mode + ".png"));
      cases.push({ mode, ownerAndAvatar: true, toolSecondary: true, historyPreserved: true, overflow: false });
    }
    assert.deepEqual(browser.errors, []);
    writeFileSync(join(output, "result.json"), JSON.stringify({ ok: true, cases, fixture: true, employeeDirectory: "503" }, null, 2));
  } catch (error) {
    await browser.screenshot(join(output, "failure.png"));
    writeFileSync(join(output, "failure.json"), JSON.stringify({ error: String(error), cases, errors: browser.errors }, null, 2));
    throw error;
  } finally { await browser.close(); server.close(); rmSync(temp, { recursive: true, force: true }); }
});
