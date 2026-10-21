import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openPlushBrowser } from "./run-plush-avatar-browser-harness.mjs";

/** Real installed UI, normal App login; only local browser preferences are changed. */
export async function verifyInstalledQueueDirectory() {
  const out = "output/architecture-stage2/employee-queue-go-live/installed-ui";
  mkdirSync(out, { recursive: true });
  const connection = JSON.parse(readFileSync(join(process.env.HOME, ".wand/acceptance-connection.json"), "utf8"));
  const origin = new URL(connection.serverURL).origin;
  const decoded = Buffer.from(connection.connectionCode.replace(/\s/g, ""), "base64url").toString();
  const appToken = decoded.slice(decoded.lastIndexOf("#") + 1);
  const login = await fetch(origin + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appToken }) });
  assert.equal(login.status, 200, "normal configured App login");
  const cookies = login.headers.getSetCookie();
  const headers = { cookie: cookies.map(c => c.split(";")[0]).join("; ") };
  let b; const report = { ok: false, cases: [], mutations: 0, errors: [] };
  try {
    b = await openPlushBrowser(1440, 1000, true, "reduce");
    for (const raw of cookies) {
      const pair = raw.split(";")[0], at = pair.indexOf("=");
      await b.send("Network.setCookie", { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin,
        httpOnly: /HttpOnly/i.test(raw), secure: origin.startsWith("https:") });
    }
    await b.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem('wand.sidebar.displayMode','active');localStorage.setItem('wand-theme','graphite');` });
    for (const [mode, width, rollback] of [["desktop",1440,false],["narrow",390,false],["rollback",1440,true]]) {
      await b.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await b.send("Page.navigate", { url: origin + "/?view=workspace&sidebar=tasks&workspaceView=directory" + (rollback ? "&reactUi=0" : "") });
      await b.wait("!!document.querySelector('.workspace-task-main')", "installed workspace tree");
      const open = await b.evaluate(`(()=>{const n=document.querySelector('[aria-label="打开会话侧栏"]');return n&&n.getBoundingClientRect().width>0})()`);
      if (open) await b.click('[aria-label="打开会话侧栏"]');
      await b.settle();
      const facts = await b.evaluate(`(()=>{const sidebar=document.querySelector('#sessions-drawer');const rr=sidebar?.getBoundingClientRect();const rows=[...document.querySelectorAll('.workspace-task')].filter(n=>{const r=n.getBoundingClientRect();return r.height>0&&r.right>0&&r.left<innerWidth});return {sidebarWidth:rr?.width,sidebarVisible:!!rr&&rr.right>0&&rr.left<innerWidth,rows:rows.length,decorativePrefix:rows.reduce((n,r)=>n+r.querySelectorAll(':scope > [data-wand-icon="task"],:scope > [data-wand-icon="branch"]').length,0),zeroCounts:rows.filter(r=>r.querySelector('.workspace-task-count')?.textContent.trim()==='0').length,states:rows.flatMap(r=>{const n=r.querySelector('.sidebar-task-status');return n?[{label:n.textContent.trim(),height:n.getBoundingClientRect().height,whiteSpace:getComputedStyle(n).whiteSpace}]:[]}),overflow:document.documentElement.scrollWidth>innerWidth,repeatedHint:sidebar?.textContent.includes('子任务有执行记录 · 主目标待验收')??false}})()`);
      assert.ok(facts.sidebarVisible && facts.rows > 0, mode + " has real visible rows");
      assert.equal(facts.decorativePrefix, 0); assert.equal(facts.zeroCounts, 0); assert.equal(facts.repeatedHint, false);
      assert.ok(facts.states.length > 0, "installed asset includes the confirmed state layout");
      for (const state of facts.states) { assert.ok(state.height <= 20, mode + ": horizontal state"); assert.equal(state.whiteSpace, "nowrap"); }
      assert.equal(facts.overflow, false, mode + ": no document overflow");
      await b.screenshot(join(out, mode + ".png"));
      report.cases.push({ mode, width, ...facts });
    }
    const response = await fetch(origin + "/api/tasks?maxSessions=1", { headers }); assert.equal(response.status, 200);
    const data = await response.json(); const tasks = (Array.isArray(data) ? data : data.groups ?? []).flatMap(g => g.tasks ?? []);
    report.api = { tasks: tasks.length, queued: tasks.filter(t=>t.executionStatus==='queued').length,
      queuedWithoutSession: tasks.filter(t=>t.executionStatus==='queued' && t.sessions.length===0).length,
      running: tasks.filter(t=>t.executionStatus==='running').length };
    report.mutations = b.events.filter(e=>e.method==='Network.requestWillBeSent'&&!['GET','HEAD','OPTIONS'].includes(e.params.request.method)).length;
    assert.equal(report.mutations, 0, "opening the installed tree does not mutate tasks or dispatch work");
    assert.deepEqual(b.errors, []);
    report.ok = true;
    writeFileSync(join(out,"result.json"),JSON.stringify(report,null,2));
    return report;
  } catch (error) {
    report.error = String(error); report.errors = b?.errors ?? [];
    if(b) await b.screenshot(join(out,"failure.png"));
    writeFileSync(join(out,"failure.json"),JSON.stringify(report,null,2));
    throw error;
  } finally {
    await b?.close();
    await fetch(origin+"/api/logout",{method:"POST",headers}).catch(()=>{});
  }
}
if(process.argv[1]?.endsWith("installed-queue-directory.mjs")) console.log(JSON.stringify(await verifyInstalledQueueDirectory()));
