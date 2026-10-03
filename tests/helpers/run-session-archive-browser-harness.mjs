// Static development harness only: exercises the real sidebar session archive
// fold in headless Chrome. Not an installed-service acceptance test and never
// reads ~/.wand credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { build } from "esbuild";

const dir = mkdtempSync(join(tmpdir(), "wand-session-archive-browser-"));
const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const bundle = join(dir, "app.js");
const root = resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

await build({
  entryPoints: [join(import.meta.dirname, "session-archive-browser-harness.tsx")],
  bundle: true, platform: "browser", format: "iife", outfile: bundle,
  define: { "process.env.NODE_ENV": '"production"' },
});

const server = createServer((req, res) => {
  const files = {
    "/app.js": [bundle, "text/javascript"],
    "/styles.css": [join(root, "src/web-ui/content/styles.css"), "text/css"],
    "/tailwind.css": [join(root, "src/web-ui/content/tailwind.css"), "text/css"],
  };
  const target = files[req.url];
  if (target) {
    res.setHeader("Content-Type", target[1]);
    res.end(readFileSync(target[0]));
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <link rel="stylesheet" href="/tailwind.css"/><link rel="stylesheet" href="/styles.css"/></head>
    <body><div id="root"></div><div id="overlay-root" data-wand-ui-root><div id="wand-react-ui-portals"></div></div>
    <script src="/app.js"></script></body></html>`);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const httpPort = server.address().port;

let processHandle;
let socket;
const results = [];
try {
  processHandle = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run",
    "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${dir}/profile`,
    `http://127.0.0.1:${httpPort}/`], { stdio: "ignore" });
  const activePortFile = join(dir, "profile", "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(activePortFile); i++) await sleep(100);
  assert.ok(existsSync(activePortFile), "Chrome CDP must start");
  const cdpPort = readFileSync(activePortFile, "utf8").split("\n")[0];
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    const tabs = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    page = tabs.find((tab) => tab.type === "page" && tab.url.startsWith(`http://127.0.0.1:${httpPort}/`));
    if (!page) await sleep(100);
  }
  assert.ok(page, "Chrome harness tab must be available");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, reject) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!pending.has(message.id)) return;
    const { resolvePending, rejectPending } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rejectPending(new Error(JSON.stringify(message.error)));
    else resolvePending(message.result);
  });
  const send = (method, params = {}) => new Promise((resolvePending, rejectPending) => {
    const next = ++id;
    pending.set(next, { resolvePending, rejectPending });
    socket.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const check = async (name, expression, expected) => {
    for (let i = 0; i < 60; i++) {
      const value = await evaluate(expression);
      if (value === expected) {
        results.push({ name, expected, actual: value, pass: true });
        return;
      }
      await sleep(100);
    }
    const actual = await evaluate(expression);
    results.push({ name, expected, actual, pass: false });
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  // 归档会话不进正常列表，只留下活跃的两条。
  await check("normal list hides archived sessions", "document.querySelectorAll('.workspace-session:not(.archived)').length", 2);
  // 每一层（任务内 / 目录未分组）各自有一个「已归档会话」折叠区。
  await check("archive folds rendered per scope", "document.querySelectorAll('.workspace-archive-fold').length", 2);
  await check("archive fold counts archived rows", "Array.from(document.querySelectorAll('.workspace-archive-fold-count')).map(el => el.textContent).join(',')", "1,1");
  // 默认收起；点开后在原位展开归档行（不跳页）。
  await check("fold starts collapsed", "document.querySelector('.workspace-archive-fold .sidebar-disclosure').dataset.open", "false");
  await evaluate("document.querySelector('.workspace-archive-fold-head').click()");
  await check("fold expands archived rows in place", "document.querySelector('.workspace-archive-fold .sidebar-disclosure').dataset.open", "true");
  await check("expanded rows are interactive", "document.querySelector('.workspace-archive-fold .sidebar-disclosure').inert", false);
  await check("archived row keeps restore + delete actions", "Boolean(document.querySelector('.workspace-archive-fold-list .workspace-session-action.restore') && document.querySelector('.workspace-archive-fold-list .workspace-session-action.delete'))", true);

  // 恢复是软处理，不杀终端：走批量归档端点（archived:false），不在前端直接删除。
  await evaluate("document.querySelector('.workspace-archive-fold-list .workspace-session-action.restore').click()");
  await check("restore calls batch-archive with archived:false", "window.sessionArchiveHarness.calls.some(call => call.url === '/api/sessions/batch-archive' && call.body && call.body.archived === false && call.body.sessionIds.includes('s-arch'))", true);

  // 批量管理模式：归档与删除是两个动作，没有选中终端时不显示危险按钮。
  await evaluate("document.querySelector('.sidebar-manage-toggle').click()");
  await check("manage mode shows the archive action", "Array.from(document.querySelectorAll('.sidebar-manage-action')).map(el => el.textContent.trim()).includes('归档终端')", true);
  await check("manage mode hides delete until a session is picked", "Array.from(document.querySelectorAll('.sidebar-manage-action')).some(el => el.textContent.trim().startsWith('删除'))", false);
  await evaluate("document.querySelector('.workspace-session .workspace-session-main').click()");
  await check("picking a session reveals the delete action", "Array.from(document.querySelectorAll('.sidebar-manage-action')).map(el => el.textContent.trim()).join('|')", "全选|归档终端|删除 1 个终端|完成");
  await check("manage bar counts the selection", "document.querySelector('.sidebar-manage-count').textContent.trim()", "已选择 1 项");

  console.log(JSON.stringify({ pass: true, results }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ pass: false, error: String(error), results }, null, 2));
  process.exitCode = 1;
} finally {
  try { socket?.close(); } catch { /* ignore */ }
  try { processHandle?.kill("SIGKILL"); } catch { /* ignore */ }
  await sleep(400);
  try { server.close(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Chrome may still be flushing its profile */ }
}
