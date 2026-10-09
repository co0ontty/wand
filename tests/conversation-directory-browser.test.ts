import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import express from "express";

/** Production directory/editor, isolated HTTP fixture, actual Chrome pointer/keyboard events. */
test("directory distinguishes resource failures, search misses, and unselected templates without clearing drafts", {
  skip: process.env.WAND_CONVERSATIONS_BROWSER !== "1", timeout: 120_000,
}, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-directory-browser-"));
  const evidence = join(process.env.WAND_CONVERSATION_EVIDENCE_DIR || join(root, "output/web-ux-implementation-20261009"), "directory-browser");
  mkdirSync(evidence, { recursive: true });
  const employee = { id: "e_directory", name: "研发员工", duty: "维护 Web", prompt: "fixture", avatar: "cat:0", agents: [], tags: [] };
  const team = { id: "t_directory", name: "研发模板", description: "维护应用", instructions: "fixture", maxSteps: 8, requirePlanApproval: true,
    members: [{ id: "m_directory", employeeId: employee.id, name: employee.name, duty: employee.duty, isLeader: true,
      agent: { provider: "codex", model: "default" } }] };
  let fixture = { employeeFail: true, teamFail: true, empty: false };
  let writes = 0;
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import { ConversationDirectory } from "./src/web-ui/react/conversations/directory";
    import { notifyAiTeamDefinitionChanged } from "./src/web-ui/react/ai-teams/repository";
    import { WandUiProvider } from "./src/web-ui/react/theme";
    import { installReactUiStyles } from "./src/web-ui/react/styles";
    import { PortalContainerProvider } from "./src/web-ui/react/ui";
    installReactUiStyles();
    globalThis.directoryFixture = { invalidate: () => notifyAiTeamDefinitionChanged("fixture") };
    createRoot(document.getElementById("root")).render(<PortalContainerProvider container={document.getElementById("portals")}>
      <WandUiProvider><div style={{height:"100dvh",minHeight:0}}><ConversationDirectory onSelect={() => {}}/></div></WandUiProvider>
    </PortalContainerProvider>);
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"),
  logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } });
  const app = express();
  app.use((req, _res, next) => { if (req.method !== "GET") writes++; next(); });
  app.get("/api/silicon-employees", (_req, res) => setTimeout(() => fixture.employeeFail
    ? res.status(503).json({ error: "员工列表暂时不可用，请重试。" }) : res.json({ employees: fixture.empty ? [] : [employee] }), 150));
  app.get("/api/ai-teams", (_req, res) => setTimeout(() => fixture.teamFail
    ? res.status(503).json({ error: "团队模板列表暂时不可用，请重试。" }) : res.json(fixture.empty ? [] : [team]), 150));
  app.get("/app.js", (_req, res) => res.type("js").send(readFileSync(join(temp, "app.js"))));
  app.get("/styles.css", (_req, res) => res.type("css").send(readFileSync(join(root, "src/web-ui/content/styles.css"))));
  app.get("/tailwind.css", (_req, res) => res.type("css").send(readFileSync(join(root, "src/web-ui/content/tailwind.css"))));
  app.get("*", (_req, res) => res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><div id="overlay-root"><div id="portals" class="wand-ui-portals"></div></div><script src="/app.js"></script></body></html>`));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const chrome = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${temp}/profile`, "about:blank"], { stdio: "ignore" });
  const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
  let socket: WebSocket | null = null;
  const rows: unknown[] = [], errors: unknown[] = [];
  try {
    for (let n = 0; n < 120 && !existsSync(join(temp, "profile/DevToolsActivePort")); n++) await pause(50);
    const port = readFileSync(join(temp, "profile/DevToolsActivePort"), "utf8").split("\n")[0];
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    socket = new WebSocket(tabs.find(tab => tab.type === "page")!.webSocketDebuggerUrl); await once(socket, "open");
    let sequence = 0;
    const pending = new Map<number, (value: any) => void>();
    socket.addEventListener("message", event => {
      const reply = JSON.parse(String(event.data));
      if (reply.method === "Runtime.exceptionThrown") errors.push(reply.params);
      if (reply.id) { pending.get(reply.id)?.(reply); pending.delete(reply.id); }
    });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise(done => {
      const id = ++sequence; pending.set(id, done); socket!.send(JSON.stringify({ id, method, params }));
    }).then(reply => { if (reply.error) throw new Error(JSON.stringify(reply.error)); return reply.result; });
    const evaluate = async (expression: string): Promise<any> => {
      const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
      return reply.result.value;
    };
    const wait = async (expression: string): Promise<void> => {
      for (let n = 0; n < 150; n++) { if (await evaluate(expression)) return; await pause(40); }
      throw new Error(`Timeout: ${expression}; ${await evaluate("document.body.innerText")}`);
    };
    const visible = (selector: string) => `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(n=>n.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&!n.closest('[inert],[hidden]'))`;
    const click = async (selector: string): Promise<void> => {
      let point: { x: number; y: number; hit: boolean } | null = null;
      for (let n = 0; n < 100 && !point?.hit; n++) {
        point = await evaluate(`(()=>{const n=${visible(selector)};if(!n)return null;n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return{x,y,hit:h===n||n.contains(h)}})()`);
        if (!point?.hit) await pause(40);
      }
      assert.ok(point?.hit, `visible click target: ${selector}`);
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
    };
    const type = async (selector: string, text: string): Promise<void> => { await click(selector); await send("Input.insertText", { text }); };
    const shot = async (name: string): Promise<void> => {
      const image = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(evidence, `${name}.png`), Buffer.from(image.data, "base64"));
    };
    await send("Page.enable"); await send("Runtime.enable");
    for (const width of [1440, 390]) {
      fixture = { employeeFail: true, teamFail: true, empty: false };
      await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url: `${origin}/?width=${width}` });
      await wait("document.body?.innerText.includes('员工加载失败')");
      assert.equal(await evaluate("document.body.innerText.includes('还没有员工')"), false, "failure is not empty");
      await click('.conversation-directory [data-stretch-value="presets"]');
      await wait("document.body.innerText.includes('团队模板加载失败')");
      assert.equal(await evaluate("document.body.innerText.includes('还没有团队模板')"), false);
      await type('[aria-label="搜索通讯录"]', "研发");
      fixture.teamFail = false;
      await click('.conversation-directory .ant-alert button');
      await wait("document.body.innerText.includes('正在读取团队模板')");
      await wait("document.querySelectorAll('.conversation-preset-row').length===1");
      assert.equal(await evaluate("document.querySelector('[aria-label=\"搜索通讯录\"]').value"), "研发", "retry preserves search");
      await type('[aria-label="搜索通讯录"]', "不存在");
      await wait("document.body.innerText.includes('没有匹配的团队模板')");
      const accessibility = await send("Accessibility.getFullAXTree");
      assert.ok(accessibility.nodes.some((node: any) => node.role?.value === "button" && node.name?.value === "清空搜索"), "native clear button has a Chinese accessible name");
      await click('[aria-label="清空搜索"]');
      assert.equal(await evaluate("document.activeElement===document.querySelector('[aria-label=\"搜索通讯录\"]')"), true);
      await click('[aria-label="发起群聊"]');
      await wait("!!document.querySelector('.conversation-group-editor .ant-alert')");
      await type('[aria-label="群名（可选）"]', "保留的群名");
      fixture.employeeFail = false;
      await click('.conversation-group-editor .ant-alert button');
      await wait("!document.querySelector('.conversation-group-editor .ant-alert')");
      await click('.conversation-group-editor .ant-select');
      await wait("!!document.querySelector('.ant-select-item-option')");
      await click('.ant-select-item-option');
      await wait("!!document.querySelector('[aria-label=\"研发员工本群职责\"]')");
      await type('[aria-label="研发员工本群职责"]', "保留的职责");
      await click('.conversation-group-editor [data-stretch-value="presets"]');
      await wait("document.querySelector('.conversation-group-editor').innerText.includes('选择一个团队模板，查看成员与协作规则')");
      assert.equal(await evaluate("document.querySelector('.conversation-group-editor').innerText.includes('还没有团队模板')"), false, "unselected is not empty");
      fixture.teamFail = true;
      await evaluate("directoryFixture.invalidate()");
      await wait("document.querySelector('.conversation-group-editor').innerText.includes('团队模板加载失败')");
      fixture.teamFail = false;
      await click('.conversation-group-editor .ant-alert button');
      await wait("!document.querySelector('.conversation-group-editor .ant-alert')");
      await wait("!document.querySelector('.conversation-directory .ant-alert')");
      assert.equal(await evaluate("document.querySelector('[aria-label=\"群名（可选）\"]').value"), "保留的群名");
      assert.equal(await evaluate("document.querySelector('[aria-label=\"研发员工本群职责\"]').value"), "维护 Web保留的职责");
      await click('[aria-label="选择团队模板"]');
      await wait("!!document.querySelector('[aria-label=\"搜索团队模板\"]')");
      await type('[aria-label="搜索团队模板"]', "研发");
      assert.equal(await evaluate("document.querySelector('.conversation-panel').dataset.open"), "true", "owned search keeps parent open");
      await click('[role="option"]');
      await wait("document.querySelector('.conversation-group-editor').innerText.includes('使用这个模板')");
      await wait("!document.querySelector('.wand-ui-select-content')");
      assert.equal(await evaluate("document.querySelector('.conversation-panel').dataset.open"), "true", "owned option keeps parent open");
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"), true);
      await shot(`${width}-draft-preserved`);
      for (const eventType of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type: eventType, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await wait("document.querySelector('[aria-label=\"发起群聊\"]')!==null");
      fixture = { employeeFail: false, teamFail: false, empty: true };
      await send("Page.navigate", { url: `${origin}/?empty=${width}` });
      await wait("document.body?.innerText.includes('还没有员工')");
      await click('.conversation-directory [data-stretch-value="presets"]');
      await wait("document.body.innerText.includes('还没有团队模板')");
      assert.equal(await evaluate("!!document.querySelector('.ant-alert')"), false);
      await shot(`${width}-empty`);
      rows.push({ width, failureDistinct: true, queryPreserved: true, clearButtonNamed: true, draftPreserved: true, unselectedDistinct: true, ownedPopup: true, emptyDistinct: true });
    }
    assert.equal(writes, 0, "read-only recovery does not submit work");
    assert.deepEqual(errors, [], "no browser exceptions");
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: true, scope: "source components + fixture HTTP + actual Chrome; not installed-service acceptance", writes, rows }, null, 2));
  } catch (cause) {
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: false, rows, errors, error: String(cause) }, null, 2));
    throw cause;
  } finally {
    socket?.close();
    if (chrome.exitCode === null) { const exited = once(chrome, "exit"); chrome.kill(); await exited; }
    server.close(); rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});
