import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

export async function verifyBrowserModuleLoading(origin, { installed = false, fixturePath } = {}) {
  const { chromium } = await import(process.env.WAND_PLAYWRIGHT_MODULE || "playwright");
  const manifest = JSON.parse(readFileSync("src/web-ui/content/module-manifest.json", "utf8"));
  const feature = name => "/assets/" + manifest.features["src/web-ui/react/" + name];
  const settingsPath = feature("settings/host.tsx");
  const boardPath = feature("issues/task-board-host.tsx");
  const newSessionPath = feature("new-session/host.tsx");
  const previewPath = feature("file-preview/host.tsx");
  const explorerPath = feature("file-explorer/host.tsx");
  const piPanelPath = feature("pi-settings/panel.tsx");
  const editorPath = feature("agents/employee-card.tsx");
  const welcomePath = feature("workspaces/workspace-agent-picker.tsx");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const cases = [];
  try {
    for (const mode of ["desktop", "mobile", "native-shell", "reactUi=0", "reduced-motion"]) {
      const context = await browser.newContext({ viewport: { width: ["mobile", "native-shell"].includes(mode) ? 390 : 1280, height: 900 },
        reducedMotion: mode === "reduced-motion" ? "reduce" : "no-preference" });
      try {
        if (installed) {
          const connection = JSON.parse(readFileSync(path.join(process.env.HOME, ".wand/acceptance-connection.json"), "utf8"));
          const decoded = Buffer.from(connection.connectionCode.replace(/\s+/g, ""), "base64url").toString();
          assert.equal((await context.request.post(origin + "/api/login", { data: { appToken: decoded.slice(decoded.lastIndexOf("#") + 1) } })).status(), 200);
        } else assert.equal((await context.request.post(origin + "/api/login", { data: { password: "module-test-password" } })).status(), 200);
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        const requested = [], errors = [];
        page.on("request", request => { const pathname = new URL(request.url()).pathname; if (pathname.startsWith("/assets/")) requested.push(pathname); });
        page.on("pageerror", error => errors.push(error.message));
        const fixtureId = `module-fixture-${mode}`;
        if (!installed) {
          const session = { id: fixtureId, sessionKind: "structured", provider: "pi", engine: "core", command: "pi", cwd: fixturePath ? path.dirname(fixturePath) : "/tmp",
            mode: "default", status: "idle", createdAt: "2026-10-10T00:00:00Z", structuredState: { inFlight: false }, messages: [], messageTotal: 0, messageOffset: 0, output: "", queuedMessages: [] };
          await page.route("**/api/sessions**", route => {
            const url = new URL(route.request().url());
            if (url.pathname === "/api/sessions") return route.fulfill({ json: [session] });
            if (url.pathname === `/api/sessions/${fixtureId}/pi-settings`) return route.fulfill({ json: {
              engine: "core", available: true, controls: { codemodeOverride: true }, skillLocksAvailable: true,
              settings: { autoResources: false, codemodeOverride: null, resources: { skills: [], mcpServers: [] }, lockedSkills: [] },
              resourceCatalog: { supported: true, skills: [], mcpServers: [] },
            } });
            if (url.pathname.startsWith(`/api/sessions/${fixtureId}`)) return route.fulfill({ json: url.pathname.endsWith("/messages") ? { messages: [], messageTotal: 0, messageOffset: 0 } : session });
            return route.continue();
          });
        }
        let failSettings = mode === "desktop";
        await page.route("**" + settingsPath, route => failSettings ? route.abort() : route.continue());
        await page.goto(origin + "/?" + (!installed ? `session=${fixtureId}&` : "") + (mode === "reactUi=0" ? "reactUi=0" : ""));
        await page.locator("#settings-button").waitFor({ state: "attached" });
        const settingsReachable = await page.locator("#settings-button").evaluate(node => {
          const r = node.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight
            && (hit === node || !!hit && node.contains(hit));
        });
        if (!settingsReachable) {
          try {
            const sessionToggle = page.locator("#sessions-toggle-button");
            if (await sessionToggle.isVisible()) await sessionToggle.click();
            else await page.getByRole("button", { name: /^(打开列表|打开任务)$/ }).and(page.locator(":visible")).first().click();
          }
          catch (error) {
            const diagnostic = await page.evaluate(() => [...document.querySelectorAll("button")].filter(node => /^(打开列表|打开会话侧栏|打开任务)$/.test(node.getAttribute("aria-label") || "")).map(node => {
              const r = node.getBoundingClientRect();
              return { id: node.id, label: node.getAttribute("aria-label"), rect: r.toJSON(), visibility: getComputedStyle(node).visibility,
                hit: document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).slice(0, 4).map(hit => ({ tag: hit.tagName, id: hit.id, class: String(hit.className) })) };
            }));
            throw new Error(JSON.stringify({ mode, failedAction: "open sidebar", diagnostic,
              pointerEvidence: String(error.message).split("\n").filter(line => /intercepts pointer|not stable|outside.*viewport|not visible|not enabled|retrying click|waiting for.*locator/.test(line)).slice(-12) }));
          }
        }
        await page.locator("#settings-button").waitFor({ state: "visible" });
        if (mode === "native-shell") await page.evaluate(() => document.documentElement.classList.add("is-wand-app"));
        for (const url of [settingsPath, boardPath, newSessionPath, previewPath, explorerPath, piPanelPath, editorPath, welcomePath]) assert.ok(!requested.includes(url), `${mode}: not fetched before use: ${url}`);
        await page.locator("#settings-button").click();
        await page.locator("#sidebar-settings-entry").click();
        if (failSettings) {
          await page.getByRole("alert").filter({ hasText: "资源加载失败" }).waitFor();
          assert.ok(await page.evaluate(() => window.__wandReactSettings.isOpen()));
          failSettings = false;
          await page.getByRole("button", { name: /^重\s*试$/ }).click();
        }
        await page.locator("[data-testid=settings-page]").waitFor({ state: "visible" });
        assert.ok(requested.includes(settingsPath), "settings fetches on open");
        const settingsRequests = requested.filter(url => url === settingsPath).length;
        await page.getByRole("button", { name: "返回工作台", exact: true }).click();
        if (["mobile", "native-shell"].includes(mode)) {
          // Returning from a workspace page may leave the mobile list closed.
          await page.evaluate(() => window.__wandReactTaskBoard.open());
        } else await page.locator("#task-board-button").click();
        await page.locator(".task-board-native-page").waitFor({ state: "visible" });
        assert.ok(requested.includes(boardPath));
        await page.evaluate(() => window.__wandReactTaskBoard.close());
        // Controllers remain usable during a delayed download; Escape must not
        // resurrect the closed dialog when the response eventually arrives.
        let release;
        await page.route("**" + newSessionPath, async route => {
          await new Promise(resolve => { release = resolve; });
          await route.continue();
        });
        await page.evaluate(() => window.__wandReactNewSession.open());
        await page.getByRole("status").filter({ hasText: "正在加载新建会话" }).waitFor();
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !window.__wandReactNewSession.isOpen());
        assert.ok(release); release();
        await page.unroute("**" + newSessionPath);
        await page.evaluate(() => window.__wandReactNewSession.open());
        await page.locator("[data-testid=new-session-dialog]").waitFor({ state: "visible" });
        await page.evaluate(() => window.__wandReactNewSession.close());
        if (fixturePath) {
          await page.evaluate(file => window.__wandReactFilePreview.open({ path: file }), fixturePath);
          await page.locator(".wand-file-preview-dialog").waitFor({ state: "visible" });
          assert.ok(requested.includes(previewPath));
          await page.evaluate(() => window.__wandReactFilePreview.execute({ type: "close" }));
        }
        assert.ok(await page.evaluate(() => window.__wandDesktopTools.openFiles()));
        try { await page.getByRole("tree", { name: "文件树" }).waitFor({ state: "visible" }); }
        catch (error) {
          const diagnostic = await page.evaluate(() => [...document.querySelectorAll(".wand-file-drawer, [role=tree], #file-side-panel")].map(node => ({ tag: node.tagName, class: String(node.className), id: node.id,
            rect: node.getBoundingClientRect().toJSON(), hidden: node.hasAttribute("hidden"), visibility: getComputedStyle(node).visibility })));
          throw new Error(JSON.stringify({ mode, failedAction: "open files", moduleRequested: requested.includes(explorerPath), errors, diagnostic }));
        }
        assert.ok(requested.includes(explorerPath), "file explorer downloads only when opened");
        const explorerRequests = requested.filter(url => url === explorerPath).length;
        await page.locator("#file-side-panel-close").click();
        assert.ok(await page.evaluate(() => window.__wandDesktopTools.openFiles()));
        await page.getByRole("tree", { name: "文件树" }).waitFor({ state: "visible" });
        assert.equal(requested.filter(url => url === explorerPath).length, explorerRequests);
        await page.locator("#file-side-panel-close").click();
        if (!installed) {
          const input = page.locator("#input-box");
          await input.fill("按需加载期间保留的草稿");
          await input.evaluate(node => { window.__moduleTestInput = node; });
          let releasePi;
          await page.route("**" + piPanelPath, async route => {
            await new Promise(resolve => { releasePi = resolve; });
            await route.continue();
          });
          const toggle = page.locator(".composer-pi-settings-toggle");
          await toggle.click();
          await page.getByRole("status").filter({ hasText: "正在加载会话功能设置" }).waitFor();
          await page.keyboard.press("Escape");
          assert.equal(await toggle.getAttribute("aria-expanded"), "false");
          assert.ok(releasePi); releasePi();
          await page.unroute("**" + piPanelPath);
          await toggle.click();
          await page.getByRole("searchbox", { name: "搜索 Skills / MCP" }).waitFor({ state: "visible" });
          assert.ok(requested.includes(piPanelPath));
          assert.equal(await input.inputValue(), "按需加载期间保留的草稿");
          assert.equal(await input.evaluate(node => node === window.__moduleTestInput), true);
          await page.keyboard.press("Escape");
          assert.equal(await toggle.getAttribute("aria-expanded"), "false");
          const piRequests = requested.filter(url => url === piPanelPath).length;
          await toggle.click();
          await page.getByRole("searchbox", { name: "搜索 Skills / MCP" }).waitFor({ state: "visible" });
          assert.equal(requested.filter(url => url === piPanelPath).length, piRequests);
          await page.getByRole("button", { name: "关闭会话功能设置" }).click();
        }
        await page.evaluate(() => window.__wandReactSettings.open());
        await page.locator("[data-testid=settings-page]").waitFor({ state: "visible" });
        assert.equal(requested.filter(url => url === settingsPath).length, settingsRequests, "reopening uses the loaded module");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.deepEqual(errors, []);
        cases.push({ mode, deferredSettings: true, deferredBoard: true, deferredExplorer: true, deferredPiPanel: !installed,
          inputNodeAndDraftPreserved: !installed, delayedClose: true, reopenWithoutDownload: true,
          modules: [...new Set(requested.filter(url => url.includes("/modules/")))].map(url => url.split("/").at(-1)) });
      } catch (error) {
        throw new Error(JSON.stringify({ mode, name: error.name, reason: String(error.message).split("Call log:")[0],
          location: String(error.stack).split("\n").find(line => line.includes("browser-module-loading.mjs")) }));
      } finally {
        try {
          const logout = await context.request.post(origin + "/api/logout");
          assert.equal(logout.status(), 200);
        } catch { throw new Error("Acceptance logout did not complete; browser context was closed."); }
        finally { await context.close(); }
      }
    }
  } finally { await browser.close(); }
  return { installed, modelExecution: false, cases };
}
