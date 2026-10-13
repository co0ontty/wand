import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Installed-service acceptance creates future-only, clearly labelled plans and
 * cancels its own plans before logout. No message or execution endpoint is used.
 * The private connection token stays in memory and outside artifacts/errors. */
export async function verifyInstalledScheduledTasks({ originOverride, evidenceDir = "output/architecture-stage2/scheduled-tasks-installed" } = {}) {
  const { chromium } = await import(process.env.WAND_PLAYWRIGHT_MODULE || "playwright");
  const connection = JSON.parse(readFileSync(path.join(process.env.HOME, ".wand/acceptance-connection.json"), "utf8"));
  const origin = originOverride ?? new URL(connection.serverURL).origin;
  const decoded = Buffer.from(connection.connectionCode.replace(/\s+/g, ""), "base64url").toString();
  const token = decoded.slice(decoded.lastIndexOf("#") + 1);
  const evidence = evidenceDir; mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const cases = [];
  try {
    for (const mode of ["desktop", "390px", "reactUi=0"]) {
      const context = await browser.newContext({ viewport: { width: mode === "390px" ? 390 : 1280, height: 900 } });
      const created = [];
      try {
        assert.equal((await context.request.post(origin + "/api/login", { data: { appToken: token } })).status(), 200, "scoped acceptance login succeeds");
        const employees = await (await context.request.get(origin + "/api/silicon-employees?includeArchived=1")).json();
        const employee = employees.employees.find(item => !item.archivedAt && item.agents?.length);
        assert.ok(employee, "Need one configured active employee for scheduled-task acceptance");
        const workspaceResponse = await context.request.get(origin + "/api/workspaces"); assert.equal(workspaceResponse.status(), 200);
        const workspaceBody = await workspaceResponse.json();
        const workspaces = (Array.isArray(workspaceBody) ? workspaceBody : workspaceBody.workspaces)
          .filter(item => item.kind !== "global" && item.id !== "wand-global" && item.cwd && existsSync(item.cwd));
        assert.ok(workspaces.length, "Need one configured existing project directory for scheduled-task acceptance");
        const workspace = workspaces[0], editedWorkspace = workspaces[1] ?? workspace;
        const page = await context.newPage(); page.setDefaultTimeout(20_000);
        const errors = [], executions = [];
        page.on("pageerror", error => errors.push(error.message.split(origin).join("<service>")));
        page.on("request", request => {
          const url = new URL(request.url());
          if (request.method() !== "GET" && /\/(?:input|send|execute|interrupt|runs)(?:\/|$)/.test(url.pathname)) executions.push(url.pathname.replace(/\/[A-Za-z0-9_-]{12,}/g, "/:id"));
        });
        await page.goto(origin + "/?view=schedules" + (mode === "reactUi=0" ? "&reactUi=0" : ""));
        await page.locator(".scheduled-tasks-page").waitFor({ state: "visible" });
        const runtime = await page.evaluate(() => ({ secureContext: isSecureContext, requestIdUnavailable: typeof crypto.randomUUID !== "function" }));
        // Navigate through the live shell rail as well as the deep link.
        if (mode !== "390px") {
          await page.locator("#scheduled-tasks-button").click();
          assert.ok(new URL(page.url()).searchParams.get("view") === "schedules");
        }
        const label = `定时任务验收-${mode}-${randomUUID().slice(0, 8)}`;
        const prompt = label + "\n验收计划：此计划只验证配置保存，不应实际执行。";
        await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
        await page.getByRole("combobox", { name: "执行员工", exact: true }).click();
        const search = page.getByRole("searchbox", { name: "搜索员工", exact: true });
        await search.click(); await search.fill(employee.name);
        await page.getByRole("option", { name: employee.name, exact: true }).click();
        assert.equal(await page.getByRole("combobox", { name: "执行员工", exact: true }).innerText(), employee.name);
        await page.getByRole("combobox", { name: "执行工作区", exact: true }).click();
        const workspaceSearch = page.getByRole("searchbox", { name: "搜索工作区", exact: true });
        await workspaceSearch.click(); await workspaceSearch.fill(workspace.id);
        await page.getByRole("option", { name: workspace.name, exact: true }).click();
        assert.equal(await page.locator(".scheduled-task-directory code").innerText(), workspace.cwd);
        await page.locator("#scheduled-task-prompt").fill(prompt);
        const date = page.getByRole("textbox", { name: "执行日期和时间", exact: true });
        await date.click(); await page.locator(".ant-picker-panel-container").waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !Array.from(document.querySelectorAll(".ant-picker-dropdown,.wand-ui-select-content"))
          .some(node => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden" && getComputedStyle(node).opacity !== "0"));
        assert.equal(await page.locator("#scheduled-task-prompt").inputValue(), prompt, "date portal closes while the parent draft stays open");
        // Default once time is one hour ahead. Confirm a future schedule before
        // writing and cancel within this same acceptance context.
        const scheduled = await date.inputValue(); assert.ok(scheduled.length > 10);
        await page.locator(".scheduled-tasks-page").screenshot({ path: path.join(evidence, mode + "-form.png") });
        const saveResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/scheduled-tasks" && response.request().method() === "POST");
        await page.getByRole("button", { name: "创建定时任务", exact: true }).click();
        const savedResponse = await saveResponse; assert.equal(savedResponse.status(), 201);
        const saved = await savedResponse.json(); const id = saved.task.id; created.push(id);
        assert.equal(saved.task.employeeId, employee.id); assert.equal(saved.task.prompt, prompt);
        assert.equal(saved.task.workspaceId, workspace.id); assert.equal(saved.task.workspaceCwd, workspace.cwd);
        assert.ok(Date.parse(saved.task.nextRunAt) > Date.now() + 20 * 60_000, "the acceptance plan cannot execute during this test");
        let row = page.locator(`[data-scheduled-task-id="${id}"]`); await row.waitFor();
        await row.getByRole("button", { name: /^编\s*辑$/ }).click();
        await page.getByRole("combobox", { name: "执行工作区", exact: true }).click();
        await workspaceSearch.click(); await workspaceSearch.fill(editedWorkspace.id);
        await page.getByRole("option", { name: editedWorkspace.name, exact: true }).click();
        await page.locator("#scheduled-task-prompt").fill(prompt + "\n编辑验收：保留原任务身份。");
        const editResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/scheduled-tasks/" + id && response.request().method() === "PATCH");
        await page.getByRole("button", { name: "保存修改", exact: true }).click();
        const editedResponse = await editResponse; assert.equal(editedResponse.status(), 200);
        const edited = await editedResponse.json(); assert.equal(edited.task.workspaceId, editedWorkspace.id); assert.equal(edited.task.workspaceCwd, editedWorkspace.cwd);
        await row.waitFor();
        const pauseResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/scheduled-tasks/" + id && response.request().method() === "PATCH");
        await row.getByRole("button", { name: /^暂\s*停$/ }).click(); assert.equal((await pauseResponse).status(), 200);
        await row.getByText("已暂停", { exact: true }).waitFor();
        await row.getByRole("button", { name: "取消计划", exact: true }).click();
        const cancelResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/scheduled-tasks/" + id && response.request().method() === "PATCH");
        await row.getByRole("button", { name: "确认取消", exact: true }).click(); assert.equal((await cancelResponse).status(), 200);
        await row.getByText("已取消", { exact: true }).waitFor();
        await row.screenshot({ path: path.join(evidence, mode + "-cancelled-plan.png") });
        await row.getByRole("button", { name: "执行记录", exact: true }).click();
        await page.getByText("还没有执行记录。到达计划时间后会显示在这里。", { exact: true }).waitFor();
        await page.locator(".scheduled-tasks-page").screenshot({ path: path.join(evidence, mode + "-history.png") });
        const detailResponse = await context.request.get(origin + "/api/scheduled-tasks/" + id);
        assert.equal(detailResponse.status(), 200); const detail = await detailResponse.json();
        assert.ok(detail.task.cancelledAt); assert.equal(detail.runs.length, 0, "no scheduled employee execution ran");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "live mobile and desktop fit the viewport");
        assert.deepEqual(executions, []); assert.deepEqual(errors, []);
        cases.push({ mode, ...runtime, employeeSelected: true, workspaceSelected: true, editedWorkspaceVerified: true,
          datePortalEscape: true, createEditPauseCancel: true, historyReachable: true, scheduledInFuture: true, modelExecution: false, noPageErrors: true });
      } finally {
        // Only IDs created by this probe are touched. Preserve cancelled rows and
        // their history; cancellation never stops an unrelated execution.
        for (const id of created) {
          const read = await context.request.get(origin + "/api/scheduled-tasks/" + id);
          if (read.status() === 200) {
            const detail = await read.json();
            if (!detail.task.cancelledAt) assert.equal((await context.request.patch(origin + "/api/scheduled-tasks/" + id,
              { data: { revision: detail.task.revision, cancelled: true } })).status(), 200, "probe cleanup cancels its own future plan");
          }
        }
        assert.equal((await context.request.post(origin + "/api/logout")).status(), 200); await context.close();
      }
    }
    const result = { installed: true, cases, modelExecution: false, scopedFuturePlansCancelled: true };
    writeFileSync(path.join(evidence, "result.json"), JSON.stringify(result, null, 2));
    return result;
  } finally { await browser.close(); }
}
