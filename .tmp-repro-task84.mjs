import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const conn = JSON.parse(readFileSync(`${process.env.HOME}/.wand/acceptance-connection.json`, "utf8"));
console.log("connection keys", Object.keys(conn), Object.fromEntries(Object.entries(conn).map(([k,v]) => [k, typeof v === "string" ? `len:${v.length}` : typeof v])));
const browser = await chromium.launch({ headless: true, executablePath: "/Users/co0ontty/Library/Caches/ms-playwright/chromium-1244/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" });
const page = await browser.newPage({ viewport: { width: 1512, height: 950 } });
const events = [];
page.on("pageerror", error => events.push(["pageerror", error.message]));
page.on("console", message => { if (message.type() === "error") events.push(["console", message.text()]); });
page.on("requestfailed", request => events.push(["requestfailed", request.method(), request.url(), request.failure()?.errorText]));
await page.goto(conn.serverURL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1000);
console.log("password inputs", await page.locator("input").evaluateAll(es => es.map(e => ({id:e.id,type:e.type,name:e.name}))), "url", page.url(), "title", await page.title(), "body", (await page.locator("body").innerText()).slice(0, 500));
if (await page.locator("input[type=password]").count()) {
  await page.fill("input[type=password]", "superco0ontty");
  await page.getByRole("button", {name:"进入控制台"}).click();
  await page.waitForTimeout(1500);
  console.log("after login", page.url(), (await page.locator("body").innerText()).slice(0,300));
}
await page.waitForSelector("#task-board-button", { state: "visible", timeout: 20000 });
await page.click("#task-board-button");
await page.waitForSelector('text="TASK-84"', { timeout: 20000 });
const id = page.getByText("TASK-84", { exact: true }).first();
const card = id.locator("xpath=ancestor::*[contains(@class,'task-board-card')][1]");
console.log("card", await card.count());
await page.getByRole("button", { name: "打开 TASK-84: 界面优化" }).evaluate(el => el.click());
await page.waitForSelector('.task-board-detail-id:text("TASK-84")', { timeout: 10000 });
console.log("detail opened", await page.locator('.task-board-detail-id').innerText());
console.log("detail body", (await page.locator(".task-board-detail").innerText()).slice(0,1200));
console.log("buttons", await page.locator(".task-board-detail button").evaluateAll(es => es.map(e => ({text:e.innerText, aria:e.getAttribute("aria-label"), title:e.getAttribute("title"), cls:e.className}))));
const session = page.locator(".task-board-detail button").filter({hasText:"superco0ontty"}).first();
console.log("session matches", await session.count());
await session.click();
await page.waitForSelector('.workspace-tab-add', { state: "visible", timeout: 15000 });
console.log("tab add visible", await page.locator('.workspace-tab-add').getAttribute('aria-label'));
await page.evaluate(() => {
  window.__tl = [];
  let old = false;
  const sample = () => {
    const next = !!document.querySelector('[data-testid="workspace-agent-dialog"]');
    if (next !== old) { old = next; window.__tl.push([Math.round(performance.now()), next]); }
  };
  new MutationObserver(sample).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('pointerdown', e => {
    window.__tl.push([Math.round(performance.now()), 'pointerdown', e.target?.className ?? e.target?.tagName]);
  }, true);
});
await page.locator('.workspace-tab-add').click();
await page.waitForTimeout(2000);
console.log("single", await page.evaluate(() => window.__tl), "open", await page.locator('[data-testid="workspace-agent-dialog"]').count());
if (await page.locator('[data-testid="workspace-agent-dialog"]').count()) await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.locator('.workspace-tab-add').dblclick({ delay: 80 });
await page.waitForTimeout(2000);
console.log("double", await page.evaluate(() => window.__tl), "open", await page.locator('[data-testid="workspace-agent-dialog"]').count());
console.log("errors", events);
await page.screenshot({ path: "/tmp/task84-detail-repro.png", fullPage: true });
await browser.close();
