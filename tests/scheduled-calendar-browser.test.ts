import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { openPlushBrowser } from "./helpers/run-plush-avatar-browser-harness.mjs";
import { initialTasks, histories, employees, workspaces, PREVIEW_NOW, DISPLAY_ZONE } from "./helpers/scheduled-calendar-fixtures.js";
import { calendarData } from "../src/scheduled-task-calendar.js";
import { dateKey, addDateDays } from "../src/scheduled-task-activity.js";

// Isolated UI integration. Actual service/storage/ACL contracts have separate
// tests; this fixture accepts metadata edits only and can never dispatch a model.
test("production calendar navigation, snapshot, heatmap, editor, month/week and narrow canvas", { timeout: 180_000 }, async t => {
  const out = resolve("output/architecture-stage2/global-calendar-production/browser"); mkdirSync(out, { recursive: true });
  await build({ entryPoints: [resolve("tests/helpers/scheduled-calendar-browser.tsx")], outfile: join(out, "app.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic", target: "es2022", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
  await build({ entryPoints: [resolve("src/web-ui/react/avatars/renderer.ts")], outfile: join(out, "avatar.js"), bundle: true, platform: "browser", format: "iife", target: "es2022", minify: true });
  let tasks = initialTasks(); const requests: { path: string; method: string; query: string }[] = [];
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${readFileSync("src/web-ui/content/styles.css", "utf8")}html,body,#root{height:100%;margin:0}.fixture-shell{display:grid;grid-template-columns:56px minmax(0,1fr);height:100dvh}.fixture-shell>main{position:relative;min-width:0}.fixture-shell>nav{padding-top:12px}</style></head><body><div id="root" data-wand-ui-root></div><div id="wand-react-ui-portals" data-wand-ui-root></div><script>globalThis.__wandBrowserRuntime={plushAvatarChunkSrc:'/avatar.js'};</script><script src="/app.js"></script></body></html>`;
  const range = (from: string, to: string, timeZone: string) => ({ from, to, timeZone, limit: 1000, returned: 50, complete: true, truncated: false, invalidDates: 0 });
  const light = (run: any) => { const { prompt, requestId, receipt, ...fact } = run; return fact; };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1"), path = url.pathname; requests.push({ path, method: request.method!, query: url.search });
    response.setHeader("Cache-Control", "no-store");
    const json = (value: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
    if (path === "/") { response.setHeader("Content-Type", "text/html;charset=utf-8"); response.end(html); return; }
    if (path === "/app.js" || path === "/avatar.js") { response.setHeader("Content-Type", "text/javascript"); response.end(readFileSync(join(out, path.slice(1)))); return; }
    if (path === "/api/silicon-employees") return json({ employees: employees.map(employee => ({ ...employee, agents: [{ id: "fixture", provider: "pi", model: "fixture", enabled: true }], archivedAt: null })) });
    if (path === "/api/workspaces") return json({ workspaces: workspaces.map(workspace => ({ id: workspace.value, name: workspace.label, kind: "project", cwd: workspace.cwd })) });
    if (path === "/api/scheduled-tasks/calendar") {
      const from = url.searchParams.get("from")!, to = url.searchParams.get("to")!, zone = url.searchParams.get("timeZone")!;
      const projection = calendarData(tasks, histories, from, to, PREVIEW_NOW, zone);
      return json({ tasks, generatedAt: PREVIEW_NOW.toISOString(), range: range(from, to, zone), issues: projection.issues, entries: projection.entries.map(entry => {
        const { task, ...item } = entry; const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(entry.at));
        return { ...item, ...(entry.kind === "execution" ? { run: light(entry.run) } : {}), taskId: task.id, minuteOfDay: Number(parts.find(p => p.type === "hour")!.value) * 60 + Number(parts.find(p => p.type === "minute")!.value) };
      }) });
    }
    if (path === "/api/scheduled-tasks" && request.method === "GET") return json({ tasks });
    const match = path.match(/^\/api\/scheduled-tasks\/([^/]+)(?:\/(activity|runs)(?:\/(.+))?)?$/);
    if (match) {
      const id = decodeURIComponent(match[1]), task = tasks.find(item => item.id === id);
      if (!task) return json({ error: "not found" }, 404);
      if (request.method === "PATCH") {
        let raw = ""; for await (const chunk of request) raw += chunk;
        const patch = JSON.parse(raw); if (patch.revision !== task.revision) return json({ error: "conflict" }, 409);
        const next = { ...task, ...patch, revision: task.revision + 1 }; tasks = tasks.map(item => item.id === id ? next : item); return json({ task: next });
      }
      if (match[2] === "runs") { const run = histories[id]?.find(run => run.id === decodeURIComponent(match[3])); return run ? json({ run }) : json({ error: "missing" }, 404); }
      if (match[2] === "activity") {
        const today = dateKey(PREVIEW_NOW, DISPLAY_ZONE), date = new Date(today + "T12:00:00Z"), weekday = (date.getUTCDay() + 6) % 7;
        const from = addDateDays(today, -weekday - 77), to = addDateDays(from, 83);
        return json({ generatedAt: PREVIEW_NOW.toISOString(), range: range(from, to, DISPLAY_ZONE), runs: (histories[id] ?? []).map(light) });
      }
      return json({ task, runs: histories[id] ?? [] });
    }
    return json({ error: "fixture has no such endpoint" }, 404);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as any;
  const browser = await openPlushBrowser(1440, 1100, true, "no-preference"); t.after(() => browser.close());
  await browser.send("Emulation.setTimezoneOverride", { timezoneId: DISPLAY_ZONE });
  await browser.send("Page.navigate", { url: `http://127.0.0.1:${address.port}/?view=calendar` });
  await browser.wait("document.querySelectorAll('.scheduled-calendar-layer[data-active=true] .scheduled-calendar-event').length>0");
  const e = browser.evaluate, month = ".scheduled-calendar-layer[data-active=true]";
  assert.equal(await e("document.querySelector('h1').textContent"), "全局日历");
  assert.equal(await e("document.querySelectorAll('.scheduled-next-section').length"), 0);
  assert.equal(await e("document.querySelector('#global-calendar-button').getAttribute('aria-current')"), "page");
  assert.equal(await e(`new Set([...document.querySelectorAll('${month} .scheduled-calendar-face')].map(n=>n.dataset.employeeId)).size`), 3);
  assert.equal(requests.filter(r => r.path.includes("/activity")).length, 0, "history is lazy, not read per plan on entry");
  await browser.screenshot(join(out, "month.png"));
  const failed = `${month} .scheduled-calendar-event[data-date-key="2026-10-09"][data-state="failed"]`;
  await browser.click(failed); await browser.wait("!!document.querySelector('.scheduled-calendar-detail-popover .scheduled-latest-record')");
  await browser.wait("document.querySelector('.scheduled-calendar-detail-popover .scheduled-detail-prompt p')?.textContent.includes('设计预览中的示例执行')");
  assert.equal(await e("document.querySelectorAll('.scheduled-calendar-detail-popover .scheduled-latest-record li').length"), 1);
  assert.match(await e("document.querySelector('.scheduled-calendar-detail-popover .scheduled-latest-record time').textContent"), /10\/09/);
  assert.ok(requests.some(r => r.path.includes("/runs/")), "selected immutable snapshot is read, not guessed from current task");
  await browser.click(".scheduled-calendar-detail-popover .scheduled-history-toggle");
  await browser.wait("document.querySelectorAll('.scheduled-calendar-detail-popover .scheduled-heat-cell').length===84");
  await browser.screenshot(join(out, "heatmap.png"));
  await browser.key("Escape");
  assert.equal(await e("document.querySelector('.scheduled-calendar-detail-popover .scheduled-history-toggle').getAttribute('aria-expanded')"), "false");
  await browser.key("Escape");
  await browser.wait("![...document.querySelectorAll('.scheduled-calendar-detail-popover')].some(n=>n.getClientRects().length&&getComputedStyle(n).visibility==='visible')");
  await browser.click('[data-stretch-value="week"]');
  await browser.wait("document.querySelector('.scheduled-calendar-view')?.dataset.calendarMode==='week' && !document.querySelector('.scheduled-calendar-layer[data-active=true]').hidden");
  assert.equal(await e("new URLSearchParams(location.search).get('range')"), "week");
  await browser.wait("document.querySelectorAll('.scheduled-calendar-layer[data-active=true] .scheduled-calendar-event').length>0");
  assert.ok(await e("getComputedStyle(document.querySelector('.scheduled-calendar-layer[data-active=true] .scheduled-calendar-event')).transitionProperty.split(',').every(name=>!['all','left','top','width','height'].includes(name.trim()))"), "positioned production markers never interpolate geometry through their neighbours");
  await browser.screenshot(join(out, "week.png"));
  await browser.click("#scheduled-tasks-button"); await browser.wait("document.querySelector('h1')?.textContent==='定时任务'");
  await browser.wait("document.querySelectorAll('.scheduled-task-row').length===6");
  await browser.screenshot(join(out, "list.png"));
  await browser.click('.scheduled-task-row[data-task-id="changelog"] .scheduled-task-title-button');
  await browser.wait("document.querySelector('.scheduled-task-row[data-task-id=changelog] .scheduled-latest-record')?.textContent.includes('10/14')");
  await browser.click('[aria-label="新建定时任务"]');
  try { await browser.wait("document.activeElement?.id==='scheduled-task-name'"); }
  catch (failure) { await browser.screenshot(join(out, "form-focus-failure.png")); writeFileSync(join(out, "form-focus-failure.json"), JSON.stringify(await e("({active:document.activeElement?.outerHTML,form:document.querySelector('.scheduled-editor-shell')?.outerHTML,errors:document.querySelectorAll('[role=alert]').length})"), null, 2)); throw failure; }
  await browser.click('[aria-label="执行员工"]'); await browser.wait("!!document.querySelector('[role=option]')");
  await browser.click('[role=option]'); assert.equal(await e("document.querySelector('.scheduled-editor-shell').dataset.open"), "true");
  await browser.key("Escape");
  await browser.click("#global-calendar-button");
  await browser.wait("document.querySelector('h1')?.textContent==='全局日历'");
  assert.equal(await e("document.querySelector('[aria-label=搜索定时任务]').value"), "");
  for (const width of [390, 320]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 960, deviceScaleFactor: 1, mobile: false });
    await browser.settle();
    assert.equal(await e("document.documentElement.scrollWidth<=innerWidth+1"), true, `document fits ${width}`);
    await browser.screenshot(join(out, `narrow-${width}.png`));
  }
  assert.deepEqual(browser.errors, []);
  assert.equal(requests.filter(r => r.method !== "GET").length, 0, "viewing and opening forms never mutates schedules or runs");
  writeFileSync(join(out, "verification.json"), JSON.stringify({ cases: ["independent all-employee navigation", "no personal hero", "direct calendar bars", "lazy history", "exact immutable occurrence", "latest only by default", "12-week heatmap", "layered Escape", "week URL", "list rendering", "native select ownership", "390/320 canvas scrolling", "no mutations or models"], requests: requests.map(r => ({ ...r })), errors: browser.errors }, null, 2));
});
