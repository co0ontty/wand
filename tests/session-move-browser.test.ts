import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("shared move owner retries attachment without duplicate task creation or replaying an accepted move", {
  skip: process.env.WAND_SIDEBAR_UX_BROWSER !== "1", timeout: 60_000,
}, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-session-move-"));
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `import * as React from "react";
import { createRoot } from "react-dom/client";
import { useSessionMove } from "./src/web-ui/react/workspaces/session-move";
import { httpWorkspacesRepository } from "./src/web-ui/react/workspaces/repository";
import { configureWorkspacesRuntime } from "./src/web-ui/react/workspaces/controller";
window.counts={created:0,moved:0,accepted:0,refreshed:0};window.failMove=true;window.failRefresh=false;window.notices=[];
Object.assign(httpWorkspacesRepository,{
  listTaskGroups:async()=>({groups:[{workspaceName:"工程",tasks:[{id:"t1",name:"当前任务"},{id:"t2",name:"目标任务"}]}]}),
  createTask:async()=>{counts.created++;return{id:"created-task"}},
  moveSession:async(id)=>{counts.moved++;if(window.failMove)throw Error("移动被明确拒收");window.lastTarget=id;},
});
configureWorkspacesRuntime({refreshSessions:async()=>{counts.refreshed++;if(window.failRefresh)throw Error("刷新失败")},toast:(message,tone)=>notices.push({message,tone})});
function Harness(){window.move=useSessionMove({sessionId:"source-session",taskId:"t1",open:true,
  intoNewTask:{workspaceId:"workspace",workspaceCwd:"/tmp/fixture"},onMoved:()=>{counts.accepted++}});return <div>仅验证归属事务，不执行模型</div>}
createRoot(document.getElementById("root")).render(<Harness/>);` }, bundle: true, jsx: "automatic", format: "iife", platform: "browser", outfile: join(temp, "app.js"), define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((req, res) => {
    if (req.url === "/app.js") { res.setHeader("content-type", "application/javascript"); res.end(readFileSync(join(temp, "app.js"))); }
    else { res.setHeader("content-type", "text/html"); res.end('<div id="root"></div><script src="/app.js"></script>'); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const browser = await openBrowser("about:blank");
  try {
    await browser.send("Page.navigate", { url: `http://127.0.0.1:${address.port}` });
    await browser.wait("window.move?.targets.length===1 && !move.loading");
    assert.equal(await browser.evaluate("move.targets[0].id"), "t2", "the current task is never a destination");
    await browser.evaluate("move.summarize().then(()=>true)");
    await browser.wait("!move.busy && move.error.includes('明确拒收')");
    assert.equal(await browser.evaluate("counts.created"), 1);
    assert.match(await browser.evaluate("move.error"), /明确拒收/);
    assert.equal(await browser.evaluate("move.busy"), false);
    await browser.evaluate("window.failMove=false;move.summarize().then(()=>true)");
    await browser.wait("!move.busy && move.error === ''");
    assert.equal(await browser.evaluate("counts.created"), 1, "retry reuses the accepted task creation");
    assert.equal(await browser.evaluate("window.lastTarget"), "created-task");
    assert.equal(await browser.evaluate("counts.accepted"), 1);
    await browser.evaluate("window.failRefresh=true;move.move('t2').then(()=>true)");
    assert.equal(await browser.evaluate("counts.accepted"), 2, "a refresh failure does not change acceptance");
    assert.equal(await browser.evaluate("move.error"), "", "an accepted move is not offered as a failed move");
    await browser.evaluate("window.failRefresh=false;Promise.all([move.move('t2'),move.move('t2')]).then(()=>true)");
    const counts = await browser.evaluate("window.counts");
    assert.deepEqual(counts, { created: 1, moved: 4, accepted: 3, refreshed: 3 });
    assert.equal(await browser.evaluate("move.busy"), false);
    assert.deepEqual(browser.errors, []);
    const output = join(root, "output/architecture-stage2/sidebar-menu"); mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "move-transactions.json"), JSON.stringify({ ok: true, sourceFixtures: true, modelExecution: false, counts }, null, 2));
  } finally { await browser.close(); server.close(); server.closeAllConnections(); rmSync(temp, { recursive: true, force: true }); }
});
