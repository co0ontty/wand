import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export async function runComposerPlaywright() {
  // Opt-in installed-service acceptance; credentials stay in memory and the
  // dedicated login is revoked on exit. Never start a model during this test.
  const { chromium } = await import(process.env.WAND_PLAYWRIGHT_MODULE || "playwright");
  const connection = JSON.parse(readFileSync(resolve(process.env.HOME, ".wand/acceptance-connection.json"), "utf8"));
  const origin = new URL(connection.serverURL).origin;
  const decoded = Buffer.from(connection.connectionCode.replace(/\s+/g, ""), "base64url").toString();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const output = resolve("output/web-composer-fix"); mkdirSync(output, { recursive: true });
  let owned;
  const evidence = { installedService: true, sourceAssets: process.env.WAND_COMPOSER_SOURCE === "1", modelExecution: false, cases: [] };
  try {
    const login = await context.request.post(origin + "/api/login", { data: { appToken: decoded.slice(decoded.lastIndexOf("#") + 1) } });
    assert.equal(login.status(), 200);
    for (const mode of ["desktop", "390px", "native-shell", "reactUi=0", "reduced-motion"]) {
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      await page.setViewportSize({ width: ["390px", "native-shell"].includes(mode) ? 390 : 1280, height: 900 });
      await page.emulateMedia({ reducedMotion: mode === "reduced-motion" ? "reduce" : "no-preference" });
      let session = { id: "composer-playwright-fixture-" + mode, sessionKind: "structured", provider: "claude", command: "claude", cwd: "/tmp", mode: "default", status: "running", createdAt: new Date().toISOString(), structuredState: { inFlight: true }, messages: [], messageTotal: 0, messageOffset: 0, output: "", queuedMessages: [] };
      let stops = 0, sends = 0, optimizes = 0, failOptimize = false, releaseOptimize;
      await page.route("**/api/sessions**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/sessions") return route.fulfill({ json: [session] });
        if (path === `/api/sessions/${session.id}/stop`) {
          stops++; session = { ...session, status: "idle", structuredState: { inFlight: false } };
          return route.fulfill({ json: session });
        }
        if (path.startsWith(`/api/sessions/${session.id}`)) return route.fulfill({ json: path.endsWith("/messages") ? { messages: [], messageTotal: 0, messageOffset: 0 } : session });
        return route.continue();
      });
      await page.route("**/api/structured-sessions/**/messages", async route => {
        sends++; session = { ...session, status: "running", structuredState: { inFlight: true } };
        return route.fulfill({ json: session });
      });
      await page.route("**/api/optimize-prompt", async route => {
        optimizes++;
        await new Promise(resolve => { releaseOptimize = resolve; });
        return route.fulfill(failOptimize ? { status: 503, json: { error: "验收优化失败" } } : { json: { optimized: "请修复输入框，并验证停止按钮无需刷新即可复用。" } });
      });
      if (evidence.sourceAssets) {
        await page.route("**/assets/app.js?*", route => route.fulfill({ body: readFileSync("src/web-ui/content/scripts.js"), contentType: "application/javascript" }));
        await page.route("**/assets/app.css?*", route => route.fulfill({ body: readFileSync("src/web-ui/content/tailwind.css", "utf8") + "\n" + readFileSync("src/web-ui/content/styles.css", "utf8"), contentType: "text/css" }));
      }
      const errors = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(origin + `/?session=${session.id}` + (mode === "reactUi=0" ? "&reactUi=0" : ""));
      const input = page.locator("#input-box"), action = page.locator("#send-input-button"), optimize = page.locator("#prompt-optimize-btn");
      await input.waitFor({ state: "visible" });
      if (mode === "native-shell") await page.evaluate(() => document.documentElement.classList.add("is-wand-app"));
      const backdrop = page.locator("#sessions-drawer-backdrop.open");
      if (await backdrop.count()) {
        const rect = await backdrop.boundingBox();
        await backdrop.click({ position: { x: rect.width - 2, y: 10 } });
      }
      await page.waitForFunction(() => document.getElementById("send-input-button").dataset.phase === "running");
      // Cancel must release the stop guard. Then complete two whole turns without reload.
      await action.click(); await page.locator('[role="dialog"] button').filter({ hasText: /取\s*消|Cancel/ }).click();
      assert.equal(stops, 0); assert.equal(await action.isEnabled(), true);
      for (let turn = 0; turn < 2; turn++) {
        if (turn) {
          await input.fill("验收下一轮"); await action.click();
          await page.waitForFunction(() => document.getElementById("send-input-button").dataset.phase === "running");
        }
        await action.click(); await page.locator('[role="dialog"] .ant-btn-dangerous').click();
        await page.waitForFunction(() => document.getElementById("send-input-button").dataset.phase === "idle");
        assert.equal(await input.isEnabled(), true);
      }
      assert.equal(stops, 2); assert.equal(sends, 1);
      await input.fill("请修复输入框"); await input.click();
      const geometry = await input.evaluate(node => {
        const surface = node.closest(".composer-surface"), sender = node.closest(".ant-sender"), panel = node.closest(".input-panel"), main = node.closest(".main-content"), badge = document.getElementById("prompt-optimize-btn");
        const p = panel.getBoundingClientRect(), c = surface.getBoundingClientRect(), b = badge.getBoundingClientRect(), m = main.getBoundingClientRect(), i = node.getBoundingClientRect();
        return { outline: getComputedStyle(node).outlineStyle, nativeBorder: getComputedStyle(node).borderWidth,
          focusBorder: getComputedStyle(surface).borderColor, caret: getComputedStyle(node).caretColor,
          senderBorder: getComputedStyle(sender).borderWidth, senderShadow: getComputedStyle(sender).boxShadow,
          surfaces: panel.querySelectorAll(".composer-surface").length, nestedSurface: surface.querySelectorAll(".ant-card").length,
          left: c.left - m.left, right: m.right - c.right, textLeft: i.left - c.left, textRight: c.right - i.right,
          badgeInInput: !!badge.closest(".composer-input-wrap"), badgeHangs: b.top < c.top && b.bottom > c.top,
          badgeWidth: b.width, badgeHeight: b.height, badgeFits: b.left >= c.left && b.right <= c.right,
          panelFits: p.left >= m.left && p.right <= m.right, overflow: document.documentElement.scrollWidth > innerWidth,
          rightControlsFit: [...panel.querySelectorAll(".composer-actions-right button")].filter(n => n.getClientRects().length).every(n => n.getBoundingClientRect().right <= c.right && n.getBoundingClientRect().left >= c.left) };
      });
      assert.equal(geometry.outline, "none"); assert.equal(geometry.nativeBorder, "0px");
      assert.equal(geometry.focusBorder, geometry.caret); assert.equal(geometry.senderBorder, "0px"); assert.equal(geometry.senderShadow, "none");
      assert.equal(geometry.surfaces, 1); assert.equal(geometry.nestedSurface, 0);
      assert.equal(geometry.left, 16); assert.equal(geometry.right, 16); assert.ok(Math.abs(geometry.textLeft - geometry.textRight) <= 1);
      for (const field of ["badgeInInput", "badgeHangs", "badgeFits", "panelFits", "rightControlsFit"]) assert.equal(geometry[field], true, field);
      assert.equal(geometry.overflow, false);
      await page.locator(".input-panel").screenshot({ path: resolve(output, `${evidence.sourceAssets ? "source" : "installed"}-${mode}-focus.png`) });
      // Real pointer activation preserves the textarea, its focus, and the loading lock.
      await optimize.click();
      await page.waitForFunction(() => document.getElementById("input-box").readOnly);
      assert.equal(await optimize.isDisabled(), true);
      assert.equal(await input.evaluate(n => document.activeElement === n), true);
      assert.equal(optimizes, 1); releaseOptimize();
      await page.waitForFunction(() => !document.getElementById("input-box").readOnly);
      assert.equal(await input.inputValue(), "请修复输入框，并验证停止按钮无需刷新即可复用。");
      assert.equal(await optimize.isEnabled(), true);
      // Failure retains the user's text and releases the badge for keyboard retry.
      failOptimize = true; await input.fill("保留失败草稿"); await optimize.click();
      await page.waitForFunction(() => document.getElementById("input-box").readOnly); releaseOptimize();
      await page.waitForFunction(() => !document.getElementById("input-box").readOnly);
      assert.equal(await input.inputValue(), "保留失败草稿"); assert.equal(await optimize.isEnabled(), true);
      failOptimize = false; await optimize.focus(); await optimize.press("Enter");
      await page.waitForFunction(() => document.getElementById("input-box").readOnly); releaseOptimize();
      await page.waitForFunction(() => !document.getElementById("input-box").readOnly); assert.equal(optimizes, 3);
      await input.fill("长草稿\n".repeat(40));
      const long = await input.evaluate(n => ({ scrolls: n.scrollHeight > n.clientHeight, clipped: n.classList.contains("has-clipped-draft"), height: n.getBoundingClientRect().height, max: parseFloat(getComputedStyle(n).maxHeight) }));
      assert.equal(long.scrolls, true); assert.equal(long.clipped, true); assert.ok(long.height <= long.max + 1);
      await page.locator(".input-panel").screenshot({ path: resolve(output, `${evidence.sourceAssets ? "source" : "installed"}-${mode}-long.png`) });
      assert.deepEqual(errors, []);
      evidence.cases.push({ mode, geometry, structuredStopsWithoutReload: stops, optimizeSuccessFailureKeyboardRetry: true, loadingKeepsFocus: true, longDraft: long });
      await page.close();
    }
    // An owned bare shell provides actual installed-server/Render evidence. The
    // only command is sleep, interrupted twice; no user session or model is touched.
    const created = await context.request.post(origin + "/api/commands", { data: { shell: true, cwd: "/tmp", cols: 120, rows: 30 } });
    assert.equal(created.status(), 201); owned = await created.json();
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    if (evidence.sourceAssets) {
      await page.route("**/assets/app.js?*", route => route.fulfill({ body: readFileSync("src/web-ui/content/scripts.js"), contentType: "application/javascript" }));
      await page.route("**/assets/app.css?*", route => route.fulfill({ body: readFileSync("src/web-ui/content/tailwind.css", "utf8") + "\n" + readFileSync("src/web-ui/content/styles.css", "utf8"), contentType: "text/css" }));
    }
    await page.goto(origin + "/?session=" + owned.id); const input = page.locator("#input-box"); await input.waitFor({ state: "visible" });
    await page.waitForTimeout(1000);
    for (let turn = 0; turn < 2; turn++) {
      await input.pressSequentially("sleep 60", { delay: 40 }); await input.press("Enter");
      await page.waitForFunction(() => document.getElementById("send-input-button").dataset.phase === "running");
      await page.locator("#send-input-button").click(); await page.locator('[role="dialog"] .ant-btn-dangerous').click();
      await page.waitForFunction(() => document.getElementById("send-input-button").dataset.phase === "idle");
      assert.equal(await input.isEnabled(), true);
      const current = await (await context.request.get(origin + "/api/sessions/" + owned.id)).json(); assert.equal(current.status, "running");
    }
    evidence.realPtyStopsWithoutReload = 2; await page.close();
    writeFileSync(resolve(output, evidence.sourceAssets ? "source-playwright.json" : "installed-playwright.json"), JSON.stringify(evidence, null, 2) + "\n");
    return evidence;
  } finally {
    if (owned) {
      const current = await (await context.request.get(origin + "/api/sessions/" + owned.id)).json();
      assert.equal(current.command, owned.command, "only clean up this owned test shell");
      await context.request.post(origin + "/api/sessions/" + owned.id + "/stop");
      await context.request.delete(origin + "/api/sessions/" + owned.id);
    }
    await context.request.post(origin + "/api/logout"); await browser.close();
  }
}
