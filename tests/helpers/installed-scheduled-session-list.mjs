import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** One owned timer run exercises all three UI cases. The unique, unavailable
 * SDK selector fails in local model resolution before a stream or CLI starts.
 * The two-character prompt is below the session-topic generation threshold.
 * No interception, manual send, timer endpoint, or other employee is used. */
export async function verifyInstalledScheduledSessionList({ evidenceDir = "output/architecture-stage2/scheduled-session-list-installed" } = {}) {
  const { chromium } = await import(process.env.WAND_PLAYWRIGHT_MODULE || "playwright");
  const connection = JSON.parse(readFileSync(path.join(process.env.HOME, ".wand/acceptance-connection.json"), "utf8"));
  const origin = new URL(connection.serverURL).origin;
  const decoded = Buffer.from(connection.connectionCode.replace(/\s+/g, ""), "base64url").toString();
  const token = decoded.slice(decoded.lastIndexOf("#") + 1);
  const redact = value => [token, connection.connectionCode, decoded, origin].reduce((text, secret) => secret ? text.split(secret).join("<private>") : text, String(value));
  const repoCwd = path.resolve(import.meta.dirname, "../..");
  const model = "wand-scheduled-acceptance/" + randomUUID();
  const label = "定时会话验收-" + randomUUID().slice(0, 8);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const client = context.request;
  const cases = [], cleanupErrors = [];
  let employeeId, taskId, sessionId, authenticated = false, result, failure;
  const getJson = async pathname => {
    const response = await client.get(origin + pathname);
    assert.equal(response.status(), 200, "read acceptance resource " + pathname);
    return response.json();
  };
  const attemptCleanup = async (name, operation) => {
    try { await operation(); } catch { cleanupErrors.push(name); }
  };
  try {
    assert.equal((await client.post(origin + "/api/login", { data: { appToken: token } })).status(), 200, "scoped acceptance login succeeds");
    authenticated = true;
    const workspaceBody = await getJson("/api/workspaces");
    const workspace = (Array.isArray(workspaceBody) ? workspaceBody : workspaceBody.workspaces)
      .find(item => item.kind !== "global" && item.id !== "wand-global" && item.cwd && path.resolve(item.cwd) === repoCwd);
    assert.ok(workspace, "Need the configured Wand workspace with this exact repository directory");
    const employeeResponse = await client.post(origin + "/api/silicon-employees", { data: {
      name: label, duty: "本地无效模型的定时会话验收", prompt: "仅用于定时会话验收。", avatar: "", tags: [],
      agents: [{ provider: "pi", model, thinkingEffort: "off", mode: "default", kind: "structured", engine: "sdk" }],
    } });
    assert.equal(employeeResponse.status(), 201);
    const employee = await employeeResponse.json(); employeeId = employee.id;
    assert.equal(employee.agents.length, 1); assert.equal(employee.agents[0].model, model); assert.equal(employee.agents[0].engine, "sdk");
    const runAt = new Date(Date.now() + 30_000).toISOString();
    const saveResponse = await client.post(origin + "/api/scheduled-tasks", { data: {
      requestId: randomUUID(), title: label, employeeId, workspaceId: workspace.id, prompt: "验收", schedule: { kind: "once", runAt },
    } });
    assert.equal(saveResponse.status(), 201);
    const saved = await saveResponse.json(); taskId = saved.task.id;
    assert.equal(saved.task.workspaceId, workspace.id); assert.equal(saved.task.workspaceCwd, workspace.cwd);
    assert.equal(saved.task.lastRun, null, "persisting a future plan does not execute it");
    const page = await context.newPage(); page.setDefaultTimeout(25_000);
    const pageErrors = [], manualExecutionRequests = [];
    page.on("pageerror", error => pageErrors.push(redact(error.message)));
    page.on("request", request => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() !== "GET" && /\/(?:input|send|execute|interrupt|runs|messages)(?:\/|$)/.test(pathname)) manualExecutionRequests.push(pathname);
    });
    await page.goto(origin + "/?view=schedules");
    const ownRow = page.locator(`[data-scheduled-task-id="${taskId}"]`);
    await ownRow.waitFor({ state: "visible" });
    assert.equal(await ownRow.getByRole("button", { name: "查看会话", exact: true }).count(), 0);
    let detail;
    const deadline = Date.now() + 95_000;
    while (Date.now() < deadline) {
      detail = await getJson("/api/scheduled-tasks/" + taskId);
      sessionId = detail.runs[0]?.sessionId;
      if (sessionId && detail.runs[0].executionStatus === "failed") break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(detail.runs.length, 1, "the actual installed timer claims exactly one occurrence");
    assert.ok(sessionId, "the timer creates a durable real session");
    assert.equal(detail.runs[0].executionStatus, "failed");
    assert.equal(detail.runs[0].workspaceId, workspace.id); assert.equal(detail.runs[0].cwd, workspace.cwd);
    assert.equal(detail.task.lastRun.sessionId, sessionId);
    // Metadata-only detail intentionally omits messages. Request the same chat
    // projection as the real renderer; this owned session has only two turns.
    const session = await getJson("/api/sessions/" + sessionId + "?format=chat&output=omit");
    assert.equal(session.sessionSource, "automation"); assert.equal(session.title, label);
    assert.equal(session.workspaceId, workspace.id); assert.equal(session.cwd, workspace.cwd);
    assert.equal(session.provider, "pi"); assert.equal(session.selectedModel, model);
    assert.equal(session.structuredState?.engine, "core"); assert.equal(session.status, "failed");
    assert.match(session.structuredState?.lastError ?? "", /core 引擎找不到可用模型/);
    assert.equal(session.claudeSessionId ?? null, null, "no native model resume ID was allocated");
    assert.ok(Array.isArray(session.messages), "chat-format detail returns the actual stored transcript");
    assert.equal(session.messageOffset, 0, "the complete owned transcript is present");
    assert.equal(session.messageTotal, session.messages.length);
    const blocks = session.messages.flatMap(turn => turn.content ?? []);
    assert.ok(session.messages.some(turn => turn.role === "user" && turn.content?.filter(block => block.type === "text").map(block => block.text).join("") === "验收"), "the actual session transcript retains the exact scheduled prompt");
    assert.equal(blocks.some(block => block.type === "tool_use" || block.type === "tool_result"), false, "no tool calls or external work ran");
    assert.equal((session.messages ?? []).some(turn => (turn.usage?.inputTokens ?? 0) > 0 || (turn.usage?.outputTokens ?? 0) > 0), false);
    const sessionsBody = await getJson("/api/sessions");
    assert.ok((Array.isArray(sessionsBody) ? sessionsBody : sessionsBody.sessions).some(item => item.id === sessionId && item.workspaceId === workspace.id));
    const groupsBody = await getJson("/api/tasks?workspaceId=" + encodeURIComponent(workspace.id));
    const groups = Array.isArray(groupsBody) ? groupsBody : groupsBody.groups;
    assert.ok(groups.some(group => group.workspaceId === workspace.id && group.standaloneSessions.some(item => item.id === sessionId)), "exact workspace API list includes the actual session");
    mkdirSync(evidenceDir, { recursive: true });
    for (const mode of ["desktop", "390px", "reactUi=0"]) {
      await page.setViewportSize({ width: mode === "390px" ? 390 : 1280, height: 900 });
      if (mode !== "desktop") await page.goto(origin + "/?view=schedules" + (mode === "reactUi=0" ? "&reactUi=0" : ""));
      await ownRow.waitFor({ state: "visible" });
      const drawer = page.locator("#sessions-drawer");
      // Desktop sidebar preference persists across this context. A mobile
      // overlay inherited on reload must close through the actual shell action.
      if (mode === "390px" && await drawer.evaluate(node => node.classList.contains("open") && node.getAttribute("aria-modal") === "true")) {
        await drawer.getByRole("button", { name: "关闭侧栏", exact: true }).click();
        await page.waitForFunction(() => {
          const node = document.getElementById("sessions-drawer");
          if (!node || node.classList.contains("open") || node.getAttribute("aria-modal") === "true") return false;
          const bounds = node.getBoundingClientRect();
          return !node.checkVisibility() || bounds.right <= 0 || bounds.left >= innerWidth;
        });
      }
      const open = ownRow.getByRole("button", { name: "查看会话", exact: true });
      await open.waitFor({ state: "visible" });
      assert.equal(await open.count(), 1);
      await open.scrollIntoViewIfNeeded();
      await page.waitForFunction(id => {
        const row = document.querySelector(`[data-scheduled-task-id="${id}"]`);
        const button = Array.from(row?.querySelectorAll("button") ?? []).find(node => node.textContent.trim() === "查看会话");
        if (!button) return false;
        const bounds = button.getBoundingClientRect(), x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 2;
        const hit = document.elementFromPoint(x, y);
        return bounds.width > 0 && bounds.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && (hit === button || button.contains(hit));
      }, taskId);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await ownRow.screenshot({ path: path.join(evidenceDir, mode + "-plan-row.png") });
      await open.click();
      await page.waitForFunction(id => localStorage.getItem("wand-selected-session") === id, sessionId);
      const chat = page.locator("#chat-output");
      // Legacy rows own role/identity in both reactUi modes; their canonical Ant
      // bubbles are children, so anchor to the role row instead of bubble chrome.
      const userPrompt = chat.locator('.chat-message[data-role="user"]').getByText("验收", { exact: true });
      await userPrompt.waitFor({ state: "visible" });
      await page.waitForFunction(() => Array.from(document.querySelectorAll('#chat-output .chat-message[data-role="assistant"]'))
        .some(node => node.checkVisibility() && node.innerText.includes("core 引擎找不到可用模型")));
      assert.ok((await page.locator(".topbar-session-title").innerText()).includes(label));
      await chat.screenshot({ path: path.join(evidenceDir, mode + "-own-chat.png") });
      // The real navigation switches the existing tree to workspace mode. Only
      // the owned session row is captured; neighbouring user sessions stay out.
      const workspaceNavigation = drawer.getByRole("button", { name: "工作区", exact: true });
      const navigationInteractive = await drawer.evaluate(drawer => {
        const node = drawer.querySelector('.conversation-navigation button[aria-label="工作区"]');
        if (!node) return false;
        const bounds = node.getBoundingClientRect(), x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 2;
        const hit = document.elementFromPoint(x, y);
        return bounds.width > 0 && bounds.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && (hit === node || node.contains(hit));
      });
      const toggle = page.locator("#sessions-toggle-button");
      if (!navigationInteractive && await toggle.count() && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
      await page.waitForFunction(() => {
        const drawer = document.getElementById("sessions-drawer");
        const node = drawer?.querySelector('.conversation-navigation button[aria-label="工作区"]');
        if (!drawer || !node) return false;
        const panel = drawer.getBoundingClientRect(), bounds = node.getBoundingClientRect();
        const x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 2, hit = document.elementFromPoint(x, y);
        return panel.left >= -1 && panel.right <= innerWidth + 1 && bounds.width > 0 && bounds.height > 0
          && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && (hit === node || node.contains(hit));
      });
      await workspaceNavigation.click();
      await drawer.getByRole("radiogroup", { name: "会话组织方式", exact: true }).getByText("按工作区", { exact: true }).click();
      const directory = drawer.locator(`[data-sidebar-tree-directory-id="${workspace.id}"]`);
      await directory.waitFor({ state: "visible" });
      assert.equal(await directory.evaluate(node => node.classList.contains("active-workspace")), true, "direct open restores the chosen workspace context");
      const disclosure = directory.locator(".workspace-row-main").first();
      if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
      const sidebarRow = directory.locator(`[data-session-id="${sessionId}"]`).first();
      await sidebarRow.waitFor({ state: "visible" });
      assert.ok((await sidebarRow.innerText()).includes(label));
      await sidebarRow.screenshot({ path: path.join(evidenceDir, mode + "-own-sidebar-row.png") });
      await sidebarRow.locator(".workspace-session-main").click();
      await page.waitForFunction(id => localStorage.getItem("wand-selected-session") === id, sessionId);
      if (mode === "390px") await page.waitForFunction(() => {
        const drawer = document.getElementById("sessions-drawer");
        if (!drawer || drawer.classList.contains("open") || drawer.getAttribute("aria-modal") === "true") return false;
        const bounds = drawer.getBoundingClientRect();
        return !drawer.checkVisibility() || bounds.right <= 0 || bounds.left >= innerWidth;
      });
      await userPrompt.waitFor({ state: "visible" });
      cases.push({ mode, directListSession: true, exactSelectedSession: true, ownPromptAndLocalFailure: true, workspaceRestored: true,
        workspaceSidebarSessionClickable: true, ...(mode === "390px" ? { mobileDrawerClosesAfterSelection: true } : {}) });
    }
    assert.deepEqual(manualExecutionRequests, [], "UI verification never sends or restarts execution");
    assert.deepEqual(pageErrors, [], "no page exceptions");
    result = { installed: true, realTimer: true, occurrences: 1, sessionId, workspaceId: workspace.id, cwd: workspace.cwd,
      sourceAutomation: true, planTitlePreserved: true, originalPromptVerified: true, messageTranscriptLoaded: true,
      localUnavailableModel: true, nativeResumeIdAbsent: true, toolCallsAbsent: true,
      modelExecution: false, cases };
  } catch (error) { failure = new Error(redact(error?.message ?? error)); }
  finally {
    if (authenticated) {
      await attemptCleanup("cancel-own-plan", async () => {
        if (!taskId) return;
        const detail = await getJson("/api/scheduled-tasks/" + taskId);
        sessionId ||= detail.runs.find(run => run.sessionId)?.sessionId;
        if (!detail.task.cancelledAt) assert.equal((await client.patch(origin + "/api/scheduled-tasks/" + taskId,
          { data: { revision: detail.task.revision, cancelled: true } })).status(), 200);
      });
      await attemptCleanup("archive-own-session", async () => {
        if (!sessionId) return;
        assert.equal((await client.post(origin + "/api/sessions/" + sessionId + "/archive")).status(), 200);
        assert.equal((await getJson("/api/sessions/" + sessionId)).archived, true);
        assert.ok((await getJson("/api/scheduled-tasks/" + taskId)).runs.some(run => run.sessionId === sessionId), "archiving keeps scheduled execution history and its real session identity");
      });
      await attemptCleanup("archive-own-employee", async () => {
        if (employeeId) assert.equal((await client.post(origin + "/api/silicon-employees/" + employeeId + "/archive")).status(), 200);
      });
      await attemptCleanup("logout", async () => assert.equal((await client.post(origin + "/api/logout")).status(), 200));
    }
    await context.close(); await browser.close();
  }
  if (failure || cleanupErrors.length) throw new Error([failure?.message, cleanupErrors.length ? "Acceptance cleanup failed: " + cleanupErrors.join(", ") : ""].filter(Boolean).join("; "));
  Object.assign(result, { ownedPlanCancelled: true, ownedSessionArchivedHistoryRetained: true, ownedEmployeeArchived: true, logout200: true });
  writeFileSync(path.join(evidenceDir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}
