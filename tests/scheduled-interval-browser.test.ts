import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import { build } from "esbuild";
import { ScheduledTaskService } from "../src/scheduled-task-service.js";
import { registerScheduledTaskRoutes } from "../src/server-scheduled-task-routes.js";
import { conversationHarness } from "./helpers/conversation-harness.js";

test("real interval form saves one plan through HTTP/storage and preserves interval, zone and next time", {
  skip: process.env.WAND_INTERVAL_BROWSER !== "1", timeout: 240_000,
}, async t => {
  const { chromium } = await import(process.env.WAND_PLAYWRIGHT_MODULE || "playwright");
  const h = conversationHarness(t);
  const service = new ScheduledTaskService({ storage: h.storage, conversations: h.service,
    getSession: id => h.sessions.get(id) ?? null });
  const root = resolve(import.meta.dirname, "..");
  const temporary = mkdtempSync(join(tmpdir(), "wand-interval-browser-"));
  const evidence = join(root, "output/task-78-interval/browser"); mkdirSync(evidence, { recursive: true });
  const source = `
    import * as React from "react"; import {createRoot} from "react-dom/client";
    import {WandUiProvider} from "./src/web-ui/react/theme";
    import {installReactUiStyles} from "./src/web-ui/react/styles";
    import {ScheduledTasksPage} from "./src/web-ui/react/scheduled-tasks/page";
    installReactUiStyles();createRoot(document.getElementById("root")).render(<WandUiProvider><ScheduledTasksPage visible onBack={()=>{}} onOpenSession={()=>{}}/></WandUiProvider>);
  `;
  await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, format: "iife", platform: "browser", jsx: "automatic",
        outfile: join(temporary, "app.js"), logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } });
  const app = express(); app.use(express.json());
  const requests: Array<{ method: string; url: string }> = [];
  app.use((req, _res, next) => { requests.push({ method: req.method, url: req.path }); next(); });
  app.get("/api/silicon-employees", (_req, res) => res.json({ employees: h.storage.listSiliconEmployees() }));
  app.get("/api/workspaces", (_req, res) => res.json([h.workspace]));
  registerScheduledTaskRoutes(app, service);
  app.get("/app.js", (_req, res) => res.type("js").send(readFileSync(join(temporary, "app.js"))));
  app.get("/styles.css", (_req, res) => res.type("css").send(readFileSync(join(root, "src/web-ui/content/styles.css"))));
  app.get("/", (_req, res) => res.type("html").send('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>body{margin:0}#root{height:100dvh;min-width:0}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>'));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address === "object");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const errors: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  try {
    page.setDefaultTimeout(30_000); page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
    const select = async (name: string, label: string, search?: string) => {
      await page.getByRole("combobox", { name, exact: true }).click();
      if (search) { const input = page.getByRole("searchbox", { name: search, exact: true }); await input.click(); await input.fill(label); }
      await page.getByRole("option", { name: label, exact: true }).click();
      assert.equal(await page.locator("#scheduled-task-prompt").isVisible(), true, "portal selection keeps parent form open");
    };
    const employee = h.storage.getSiliconEmployee("e_test_1")!;
    await select("执行员工", employee.name, "搜索员工"); await select("执行工作区", h.workspace.name, "搜索工作区");
    await page.locator("#scheduled-task-name").fill("单个每3小时计划");
    await page.locator("#scheduled-task-prompt").fill("测试计划：不调用真实模型");
    await select("执行计划", "每隔若干小时");
    const hours = page.getByRole("spinbutton", { name: "间隔小时数", exact: true });
    assert.equal(await hours.inputValue(), "3");
    await select("执行时区", "Asia/Tokyo", "搜索时区");
    const preview = page.getByRole("status", { name: "执行计划预览" });
    assert.match(await preview.innerText(), /每 3 小时[\s\S]*下次执行：[\s\S]*Asia\/Tokyo/);
    await page.getByRole("textbox", { name: "首次执行时间", exact: true }).click();
    await page.locator(".ant-picker-panel-container").waitFor({ state: "visible" }); await page.keyboard.press("Escape");
    assert.equal(await hours.inputValue(), "3");
    await page.getByRole("combobox", { name: "执行时区", exact: true }).click();
    await page.getByRole("searchbox", { name: "搜索时区", exact: true }).click();
    await page.locator("#scheduled-task-prompt").click();
    await page.getByRole("searchbox", { name: "搜索时区", exact: true }).waitFor({ state: "hidden" });
    await page.locator(".scheduled-task-form").screenshot({ path: join(evidence, "desktop-form.png"), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await preview.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(evidence, "mobile-form.png"), animations: "disabled" });
    const response = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/scheduled-tasks");
    await page.getByRole("button", { name: "创建定时任务", exact: true }).click();
    const saved = await response; assert.equal(saved.status(), 201);
    const { task } = await saved.json(); assert.equal(task.schedule.kind, "interval"); assert.equal(task.schedule.everyHours, 3); assert.equal(task.schedule.timeZone, "Asia/Tokyo");
    assert.equal(task.employeeId, employee.id); assert.equal(task.workspaceId, h.workspace.id);
    assert.equal(task.nextRunAt, task.schedule.startAt);
    assert.equal(service.list().length, 1); assert.equal(h.sent.length, 0);
    const row = page.locator(`[data-scheduled-task-id="${task.id}"]`); await row.waitFor();
    await row.getByRole("button", { name: /^展开/ }).click();
    await row.getByText("执行频率", { exact: true }).waitFor({ state: "visible" });
    assert.match(await row.locator(".scheduled-task-details").innerText(), /执行频率[\s\S]*每 3 小时[\s\S]*下次执行[\s\S]*Asia\/Tokyo/);
    await page.setViewportSize({ width: 1280, height: 1000 });
    await row.screenshot({ path: join(evidence, "saved-plan.png"), animations: "disabled" });
    const patchResponse = () => page.waitForResponse(r => r.request().method() === "PATCH" && new URL(r.url()).pathname.endsWith(task.id));
    let changed = patchResponse(); await row.getByRole("switch").click(); await changed; await row.getByRole("switch", { name: /^恢复/ }).waitFor(); assert.equal(service.get(task.id).task.enabled, false);
    changed = patchResponse(); await row.getByRole("switch").click(); await changed; await row.getByRole("switch", { name: /^暂停/ }).waitFor(); assert.equal(service.get(task.id).task.enabled, true);
    await row.getByRole("button", { name: "编辑任务", exact: true }).click();
    assert.equal(await hours.inputValue(), "3"); await hours.fill("1"); await hours.blur();
    assert.match(await preview.innerText(), /每 1 小时/);
    const [updated] = await Promise.all([
      page.waitForResponse(r => r.request().method() === "PATCH" && new URL(r.url()).pathname.endsWith(task.id)),
      page.getByRole("button", { name: "保存修改", exact: true }).click({ timeout: 5_000 }),
    ]);
    assert.equal(updated.status(), 200);
    const schedule = service.get(task.id).task.schedule; assert.equal(schedule.kind, "interval"); if (schedule.kind === "interval") assert.equal(schedule.everyHours, 1);
    await page.reload(); await row.waitFor(); assert.equal(service.list().length, 1); assert.equal(h.sent.length, 0);
    assert.deepEqual(errors, []);
    rmSync(join(evidence, "failure.json"), { force: true });
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: true, singlePlan: true, everyHours: [3, 1], pauseResume: true, reload: true, portals: true, noModelCalls: h.sent.length === 0, requests, errors }, null, 2));
  } catch (error) {
    writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), text: await page.locator("body").innerText(), requests,
      tasks: service.list().map(({ id, revision, enabled, schedule }) => ({ id, revision, enabled, schedule })) }, null, 2));
    throw error;
  } finally { await browser.close(); await service.dispose(); await new Promise<void>(done => server.close(() => done())); rmSync(temporary, { recursive: true, force: true }); }
});
