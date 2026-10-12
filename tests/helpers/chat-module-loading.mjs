import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Production ESM + isolated synthetic sessions. Mutate only the actual exported
 * state owner to simulate in-flight frames; never substitute the renderer. */
export async function verifyChatModuleLoading(origin) {
  const { chromium } = await import(process.env.WAND_PLAYWRIGHT_MODULE || "playwright");
  const manifest = JSON.parse(readFileSync("src/web-ui/content/module-manifest.json", "utf8"));
  const chatPath = "/assets/" + manifest.features["src/web-ui/browser/chat-render.ts"];
  const turn = text => [{ role: "user", uuid: "prompt", content: [{ type: "text", text: "Owned prompt" }] },
    { role: "assistant", uuid: "reply", content: [{ type: "text", text }] }];
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const cases = [];
  try {
    for (const scenario of ["latest", "switch", "terminal", "failure"]) {
      const context = await browser.newContext({ viewport: { width: scenario === "switch" ? 390 : 1280, height: 900 } });
      try {
        assert.equal((await context.request.post(origin + "/api/login", { data: { password: "module-test-password" } })).status(), 200);
        const page = await context.newPage(); page.setDefaultTimeout(15_000);
        const errors = [], downloads = []; let modelRequests = 0;
        page.on("pageerror", error => errors.push(error.message));
        page.on("request", request => {
          const url = new URL(request.url());
          if (url.pathname === chatPath) downloads.push(url.search);
          if (request.method() !== "GET" && /\/api\/(?:commands|structured-sessions)|\/api\/sessions\/[^/]+\/(?:input|answer|approve)/.test(url.pathname)) modelRequests++;
        });
        const sessions = ["A", "B"].map(id => ({ id: `chat-load-${id}`, sessionKind: "structured", provider: "pi", command: "pi", engine: "core",
          cwd: "/tmp", title: `Owned ${id}`, mode: "default", status: "idle", structuredState: { inFlight: false },
          createdAt: "2026-10-10T00:00:00Z", messages: turn(`Original ${id}`), messageTotal: 2, messageOffset: 0, output: "", queuedMessages: [] }));
        await page.route("**/api/sessions**", route => {
          const pathname = new URL(route.request().url()).pathname;
          if (pathname === "/api/sessions") return route.fulfill({ json: sessions });
          const session = sessions.find(item => pathname.startsWith(`/api/sessions/${item.id}`));
          if (session) return route.fulfill({ json: pathname.endsWith("/messages") ? { messages: session.messages, messageTotal: 2, messageOffset: 0 } : session });
          return route.continue();
        });
        let release;
        let fail = scenario === "failure";
        await page.route("**" + chatPath + "*", async route => {
          if (fail) return route.abort();
          if (!release) { await new Promise(resolve => { release = resolve; }); }
          await route.continue();
        });
        await page.goto(origin + "/?session=chat-load-A");
        if (fail) await page.getByRole("alert").filter({ hasText: "会话组件加载失败" }).waitFor();
        else await page.getByRole("status").filter({ hasText: "正在加载会话组件" }).waitFor();
        const input = page.locator("#input-box"); await input.fill("Owned draft");
        await input.evaluate(node => { window.__chatTestInput = node; });
        // The exported owner is unique and remains shared with the optional module.
        await page.evaluate(async entry => {
          const module = await import(entry);
          const owners = Object.values(module).filter(value => value && typeof value === "object"
            && Array.isArray(value.sessions) && "selectedId" in value && "currentMessages" in value);
          if (owners.length !== 1 || !owners[0].sessions.every(session => session.id.startsWith("chat-load-"))) throw Error("Not an owned isolated state");
          window.__chatTestState = owners[0];
        }, "/assets/" + manifest.entry);
        const target = scenario === "switch" ? "chat-load-B" : "chat-load-A";
        await page.evaluate(({ target, messages, terminal }) => {
          const state = window.__chatTestState;
          state.selectedId = target; state.chatRenderEpoch = (state.chatRenderEpoch || 0) + 1;
          state.currentMessages = messages; state.sessions.find(session => session.id === target).messages = messages;
          if (terminal) state.currentView = "terminal";
          for (let index = 0; index < 100; index++) window.__scheduleChatRender();
        }, { target, messages: turn(`Latest ${scenario}`), terminal: scenario === "terminal" });
        if (fail) {
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert.equal(downloads.length, 1, "stream frames must not automatically retry a failed module");
          fail = false;
          // Retry uses a fresh import URL; let that one complete without another hold.
          release = () => {};
          await page.getByRole("button", { name: /^重\s*试$/ }).click();
        } else { assert.ok(release); release(); }
        if (scenario === "terminal") {
          await page.waitForFunction(() => !document.querySelector("[data-chat-load-state]"));
          assert.equal(await page.locator("#chat-output [data-chat-renderer=canonical]").count(), 0);
        } else {
          await page.waitForFunction(text => document.querySelector("#chat-output")?.textContent.includes(text), `Latest ${scenario}`);
          assert.ok(await page.locator("#chat-output [data-chat-renderer=canonical]").count() > 0);
          assert.equal(await page.locator("#chat-output").textContent().then(text => text.includes("Original A")), false);
        }
        assert.equal(await input.inputValue(), "Owned draft");
        assert.equal(await input.evaluate(node => node === window.__chatTestInput), true);
        assert.equal(modelRequests, 0); assert.deepEqual(errors, []);
        cases.push({ scenario, latestOwnerPreserved: true, sameInputAndDraft: true, modelRequests,
          moduleDownloads: downloads.length, retryHasNewUrl: !fail && (scenario !== "failure" || downloads[1]?.includes("wandModuleRetry")) });
      } finally { await context.request.post(origin + "/api/logout"); await context.close(); }
    }
  } finally { await browser.close(); }
  return { productionModules: true, isolatedStateFrames: true, installed: false, cases };
}
