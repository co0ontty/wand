import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Installed-service acceptance. Only HTTP GET/view navigation plus scoped login
 * and logout; never log session identities, text, credentials or absolute URLs. */
export async function verifyInstalledChatModules({ originOverride } = {}) {
  const { chromium } = await import(process.env.WAND_PLAYWRIGHT_MODULE || "playwright");
  const connection = JSON.parse(readFileSync(path.join(process.env.HOME, ".wand/acceptance-connection.json"), "utf8"));
  const origin = originOverride ?? new URL(connection.serverURL).origin;
  const decoded = Buffer.from(connection.connectionCode.replace(/\s+/g, ""), "base64url").toString();
  const token = decoded.slice(decoded.lastIndexOf("#") + 1);
  const manifest = JSON.parse(readFileSync("dist/web-ui/content/module-manifest.json", "utf8"));
  const chatPath = "/assets/" + manifest.features["src/web-ui/browser/chat-render.ts"];
  const splitPath = "/assets/" + manifest.features["src/web-ui/react/workspaces/workspace-window.tsx"];
  assert.ok(chatPath.includes("chat-render")); assert.ok(splitPath.includes("workspace-window"));
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const probe = await browser.newContext();
  const cases = [];
  let target;
  try {
    assert.equal((await probe.request.post(origin + "/api/login", { data: { appToken: token } })).status(), 200);
    const shell = await (await probe.request.get(origin)).text();
    const bootstrapPath = shell.match(/src="(\/assets\/app\.js[^\"]*)"/)?.[1];
    assert.ok(bootstrapPath);
    const boot = await (await probe.request.get(origin + bootstrapPath)).text();
    assert.ok(boot.includes(manifest.entry)); assert.ok(!boot.includes("${browserModuleSrc}"));
    const assets = [];
    for (const file of manifest.files) {
      const response = await probe.request.get(origin + "/assets/" + file);
      assert.equal(response.status(), 200);
      assert.match(response.headers()["cache-control"], /public.*immutable/);
      const content = await response.body();
      const expected = readFileSync(path.join("dist/web-ui/content", file));
      assert.equal(createHash("sha256").update(content).digest("hex"), createHash("sha256").update(expected).digest("hex"));
      assets.push({ file: file.split("/").at(-1), bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
    }
    writeFileSync("output/architecture-stage2/app-split-installed-assets.json", JSON.stringify({ modules: assets, matches: assets.length, bootstrapBytes: Buffer.byteLength(boot) }, null, 2));
    const sessions = await (await probe.request.get(origin + "/api/sessions")).json();
    assert.ok(Array.isArray(sessions));
    for (const candidate of sessions.filter(item => item.sessionKind === "structured" && !item.archivedAt && ["idle", "completed", "stopped"].includes(item.status)).slice(-20).reverse()) {
      const response = await probe.request.get(origin + "/api/sessions/" + encodeURIComponent(candidate.id) + "?format=chat&blockBudget=200&byteBudget=65536&output=omit");
      if (response.status() !== 200) continue;
      const detail = await response.json();
      if (detail.messages?.some(turn => turn.content?.length)) { target = candidate; break; }
    }
    assert.ok(target, "Need one existing idle structured session with real messages for read-only acceptance");
    for (const mode of ["desktop", "390px", "native-shell", "reactUi=0", "reduced-motion", "failed-download"]) {
      const context = await browser.newContext({ viewport: { width: ["390px", "native-shell"].includes(mode) ? 390 : 1280, height: 900 }, reducedMotion: mode === "reduced-motion" ? "reduce" : "no-preference" });
      try {
        assert.equal((await context.request.post(origin + "/api/login", { data: { appToken: token } })).status(), 200);
        const page = await context.newPage(); page.setDefaultTimeout(20_000);
        const requests = [], errors = [], mutations = [];
        page.on("pageerror", error => {
          errors.push(error.message);
          writeFileSync("output/architecture-stage2/app-split-installed-pageerror.json", JSON.stringify({ mode,
            stack: String(error.stack).split(origin).join("<service>") }, null, 2));
        });
        page.on("request", request => {
          const url = new URL(request.url());
          if (url.pathname === chatPath) requests.push(url.search);
          if (url.pathname.startsWith("/api/") && request.method() !== "GET" && !/\/(?:login|logout)$/.test(url.pathname)) mutations.push({ method: request.method(), route: url.pathname.replace(/\/[A-Za-z0-9_-]{12,}/g, "/:id") });
        });
        if (mode === "native-shell") await page.addInitScript(() => {
          const apply = () => document.documentElement.classList.add("is-wand-app");
          if (document.documentElement) apply();
          else document.addEventListener("DOMContentLoaded", apply, { once: true });
        });
        let fail = mode === "failed-download";
        if (fail) await page.route("**" + chatPath + "*", route => fail ? route.abort() : route.continue());
        await page.goto(origin + "/?session=" + encodeURIComponent(target.id) + (mode === "reactUi=0" ? "&reactUi=0" : ""));
        const input = page.locator("#input-box"); await input.waitFor({ state: "attached" });
        const initialDraft = await input.inputValue(); await input.evaluate(node => { window.__installedInputNode = node; });
        if (fail) {
          await page.getByRole("alert").filter({ hasText: "会话组件加载失败" }).waitFor();
          assert.equal(requests.length, 1);
          fail = false;
          await page.getByRole("button", { name: /^重\s*试$/ }).click();
        }
        await page.locator("#chat-output [data-chat-renderer=canonical]").first().waitFor({ state: "attached" });
        assert.ok(requests.length > 0, "real session must request its renderer");
        assert.equal(await input.inputValue(), initialDraft);
        assert.equal(await input.evaluate(node => node === window.__installedInputNode), true);
        if (mode === "failed-download") {
          assert.equal(requests.length, 2); assert.ok(requests[1].includes("wandModuleRetry"));
        }
        assert.deepEqual(errors, []);
        // Opening an existing session marks completion viewed by the established
        // API contract; it must never send model input or execute commands.
        const unintended = mutations.filter(item => !item.route.endsWith("/completion/view"));
        assert.deepEqual(unintended, []);
        cases.push({ mode, realSessionRendering: true, sameInputNode: true, draftPreserved: true, downloads: requests.length,
          explicitRetry: mode === "failed-download", noExecutionRequests: true, completionViewRequests: mutations.length });
      } finally {
        try {
          const logout = await context.request.post(origin + "/api/logout");
          assert.equal(logout.status(), 200);
        } catch { throw new Error("Installed chat acceptance logout did not complete; browser context was closed."); }
        finally { await context.close(); }
      }
    }
    return { installed: true, assetMatches: manifest.files.length, cases, splitResourceServed: true,
      splitInteraction: "Not exercised unless an existing split task is available", modelExecution: false };
  } finally {
    try {
      const logout = await probe.request.post(origin + "/api/logout");
      assert.equal(logout.status(), 200);
    } catch { throw new Error("Installed asset probe logout did not complete."); }
    finally { await probe.close(); await browser.close(); }
  }
}
