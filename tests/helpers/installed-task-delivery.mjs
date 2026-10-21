import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { openPlushBrowser } from "./run-plush-avatar-browser-harness.mjs";

// Read-only installed-service acceptance. Never accepts a real task, dispatches,
// installs a device, changes server configuration, or downloads/prunes artifacts.
export async function verifyInstalledTaskDelivery() {
  const connection = JSON.parse(readFileSync(join(process.env.HOME, ".wand/acceptance-connection.json"), "utf8"));
  const origin = new URL(connection.serverURL).origin;
  const decoded = Buffer.from(connection.connectionCode.replace(/\s+/g, ""), "base64url").toString();
  const appToken = decoded.slice(decoded.lastIndexOf("#") + 1);
  const login = await fetch(origin + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appToken }) });
  assert.equal(login.status, 200, "installed service login");
  const cookies = login.headers.getSetCookie();
  const headers = { cookie: cookies.map(c => c.split(";")[0]).join("; ") };
  const get = async path => { const r = await fetch(origin + path, { headers }); assert.equal(r.status, 200, path); return r.json(); };
  const tasks = await get("/api/wand-tasks");
  const current = tasks.find(t => t.identifier === "TASK-76"); assert.ok(current);
  assert.equal(current.acceptance?.acceptedAt ?? null, null, "TASK-76 must remain unaccepted");
  const multi = tasks.find(t => t.sessions.length >= 2 && t.status !== "archived"); assert.ok(multi, "existing multi-session task");
  const output = "output/architecture-stage2/task-76/installed"; mkdirSync(output, { recursive: true });
  const browser = await openPlushBrowser(); const cases = [], updates = [], clicks = [];
  const click = async selector => {
    await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:"center",behavior:"instant"})`);
    await browser.settle();
    const target = await browser.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);return {x,y,expanded:n.getAttribute("aria-expanded"),hit:hit?.className,inside:n.contains(hit)}})()`);
    clicks.push({ selector, ...target }); assert.ok(target.inside, "target must be hit-testable after nested scrolling");
    for (const type of ["mousePressed","mouseReleased"]) await browser.send("Input.dispatchMouseEvent",{type,x:target.x,y:target.y,button:"left",clickCount:1});
    await browser.settle();
  };
  try {
    for (const raw of cookies) {
      const pair = raw.split(";")[0], at = pair.indexOf("=");
      await browser.send("Network.setCookie", { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin, httpOnly: /HttpOnly/i.test(raw), secure: origin.startsWith("https:") });
    }
    for (const mode of ["desktop", "390px", "reactUi=0"]) {
      const task = mode === "desktop" ? current : multi;
      await browser.send("Emulation.setDeviceMetricsOverride", { width: mode === "390px" ? 390 : 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
      await browser.send("Page.navigate", { url: origin + `/?view=taskboard&task=${task.id}` + (mode === "reactUi=0" ? "&reactUi=0" : "") });
      await browser.wait("!!document.querySelector('[aria-label=多会话交付汇总]')");
      if (mode === "390px") {
        await click("#close-drawer-button");
        await browser.wait("!document.querySelector('.sidebar-overlay.is-open')");
      }
      const summary = await browser.evaluate("document.querySelector('[aria-label=多会话交付汇总]').innerText");
      assert.ok(summary.includes(`${task.sessions.length} 个关联会话`));
      await click('[aria-label="多会话交付汇总"] .ant-collapse-header');
      if (task.sessions.length) await browser.wait("!!document.querySelector('[aria-label^=继续已有会话]')");
      assert.equal(await browser.evaluate("document.querySelectorAll('[aria-label^=继续已有会话]').length"), task.sessions.length);
      await click('.task-board-acceptance-collapse .ant-collapse-header');
      await browser.wait("!!document.querySelector('[aria-label=验收阻塞]')");
      await click('[aria-label="验收阻塞"]');
      await browser.send("Input.insertText", { text: "【TASK-76只读验证草稿：等待部署，不保存】" });
      await browser.evaluate("document.querySelector('[aria-label=验收阻塞]').blur()");
      assert.equal(await browser.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='确认验收通过').disabled"), true);
      assert.equal(await browser.evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
      await browser.screenshot(join(output, mode + ".png"));
      const fresh = await get(`/api/wand-tasks/${task.id}`);
      assert.deepEqual(fresh.acceptance ?? null, task.acceptance ?? null, "draft must not mutate installed acceptance");
      assert.deepEqual([...fresh.sessionIds].sort(), [...task.sessionIds].sort(), "opening task must not create executions");
      cases.push({ mode, identifier: task.identifier, sessions: task.sessions.length, readOnly: true, acceptanceUnchanged: true, exactContinueTargets: true, overflow: false });
    }
    for (const [platform, route] of [
      ["android", "/api/android-apk-update?channel=beta&currentVersion=0.0.0", "android", "apk"],
      ["ios", "/api/ios-ipa-update?channel=beta&currentVersion=0.0.0", "ios", "ipa"],
      ["macos", "/api/macos-app-update?channel=beta&currentVersion=0.0.0", "macos", "zip"],
    ]) {
      const body = await get(route);
      assert.equal(body.updateAvailable, true, platform + " beta available");
      assert.equal(body.fileName, basename(body.fileName));
      const artifact = join(process.env.HOME, ".wand", platform, body.fileName);
      assert.equal(statSync(artifact).size, body.size, platform + " endpoint size matches artifact");
      const localSha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
      if (body.sha256) assert.equal(localSha256, body.sha256, platform + " endpoint SHA matches artifact");
      updates.push({ platform, metadata: body, localSha256 });
    }
    // Only known public update metadata is retained. Tokens/cookies stay in memory.
    const cleanUpdates = updates.map(({ platform, metadata, localSha256 }) => ({ platform, version: metadata.latestVersion, available: metadata.updateAvailable, fileName: metadata.fileName, size: metadata.size, sha256: metadata.sha256 ?? null, localSha256, signed: metadata.signed, otaReady: metadata.otaReady }));
    const mutations = browser.events.filter(e => e.method === "Network.requestWillBeSent" && !["GET", "HEAD", "OPTIONS"].includes(e.params.request.method));
    assert.equal(mutations.length, 0, "installed UI checks must remain read-only");
    writeFileSync(join(output, "result.json"), JSON.stringify({ ok: true, cases, updates: cleanUpdates, pageErrors: browser.errors, mutations: 0 }, null, 2));
    return { cases, updates: cleanUpdates, pageErrors: browser.errors.length };
  } catch (error) {
    await browser.screenshot(join(output, "failure.png"));
    writeFileSync(join(output, "failure.json"), JSON.stringify({ error: String(error), cases, clicks, summary: await browser.evaluate("document.querySelector('[aria-label=多会话交付汇总]')?.innerText"), pageErrors: browser.errors }, null, 2));
    throw error;
  } finally { await browser.close(); }
}
