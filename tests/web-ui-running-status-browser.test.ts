import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import express from "express";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("running status adapter updates live facts without stale actions or source leakage", {
  skip: process.env.WAND_RUNNING_STATUS_BROWSER !== "1", timeout: 120_000,
}, async t => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-running-status-"));
  const evidence = process.env.WAND_RUNNING_STATUS_EVIDENCE_DIR || join(root, "output/chat-ux-batch1/status-browser");
  mkdirSync(evidence, { recursive: true });
  const source = `
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import { WandUiProvider } from "./src/web-ui/react/theme";
    import { installReactUiStyles } from "./src/web-ui/react/styles";
    import { RunningStatusBar } from "./src/web-ui/react/chat/running-status-bar";
    import { paintRunningStatusBar, clearRunningStatusBar } from "./src/web-ui/browser/running-status-adapter";
    installReactUiStyles();
    const runRoot = createRoot(document.getElementById("team-run"));
    window.paintStatus = (value, id = "session") => paintRunningStatusBar(document.getElementById(id), value);
    window.clearStatus = () => clearRunningStatusBar(document.getElementById("session"));
    window.paintRun = value => runRoot.render(<WandUiProvider><RunningStatusBar activity={value} runMode /></WandUiProvider>);
    window.fixtureReady = true;
  `;
  await build({ stdin: { contents: source, resolveDir: root, loader: "tsx" }, bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    outfile: join(temp, "fixture.js"), logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } });
  const app = express();
  app.get("/fixture.js", (_req, res) => res.type("js").send(readFileSync(join(temp, "fixture.js"))));
  app.get("/styles.css", (_req, res) => res.type("css").send(readFileSync(join(root, "src/web-ui/content/styles.css"))));
  app.get("/", (_req, res) => res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/styles.css"><style>body{margin:0}#fixture{width:100%;height:100dvh;display:flex;flex-direction:column}#space{flex:1}#footer{padding:12px;box-sizing:border-box}textarea{box-sizing:border-box;width:100%}</style>
    <div id="fixture"><div id="other"></div><div id="team-run"></div><div id="space"></div><div id="footer"><div id="session"></div><textarea id="draft">本机测试草稿，不发送</textarea></div></div><script src="/fixture.js"></script>`));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const browser = await openBrowser(`http://127.0.0.1:${address.port}/`, 1280, 800);
  t.after(async () => { await browser.close(); server.close(); rmSync(temp, { recursive: true, force: true }); });
  await browser.wait("window.fixtureReady === true");
  const started = new Date(Date.now() - 15_000).toISOString();
  const action = (name = "Bash", id = "tool-a") => ({ type: "tool_use", id, name,
    input: { command: "SECRET_COMMAND" }, description: "SECRET_DESCRIPTION", activity: { kind: "run_command", label: "SECRET_LABEL" } });
  const session = (id: string, blocks: unknown[], extra: Record<string, unknown> = {}) => ({
    id, status: "running", structuredState: { inFlight: true, activeRequestId: "request", turnStartedAt: started, lastActivityAt: started },
    messages: [{ role: "user", requestId: "request", content: [{ type: "text", text: "fixture" }] },
      { role: "assistant", requestId: "request", author: { id: "employee", name: "员工", sessionId: id }, content: blocks }], ...extra,
  });
  const paint = async (value: unknown, stage: string | null, id = "session") => {
    await browser.evaluate(`window.paintStatus(${JSON.stringify(value)},${JSON.stringify(id)});true`);
    await browser.wait(stage ? `document.querySelector('#${id} .chat-running-bar')?.dataset.phase === ${JSON.stringify(stage)}`
      : `!document.querySelector('#${id} .chat-running-bar')`);
  };
  const text = (id = "session") => browser.evaluate(`document.getElementById(${JSON.stringify(id)}).innerText`);
  const cases: string[] = [];

  await paint(session("A", [action()]), "tool");
  assert.match(await text(), /Bash/);
  assert.doesNotMatch(await text(), /SECRET/);
  await browser.evaluate("window.firstBar=document.querySelector('#session .chat-running-bar');window.firstDraft=document.getElementById('draft');true");
  await paint(session("A", [action("ReadFile", "tool-b")]), "tool");
  await browser.wait("document.querySelector('#session .chat-running-text').textContent.includes('ReadFile')");
  assert.doesNotMatch(await text(), /Bash|SECRET/);
  assert.equal(await browser.evaluate("window.firstBar === document.querySelector('#session .chat-running-bar')"), true);
  cases.push("same-anchor tool change updates existing DOM without sensitive arguments");

  await paint(session("A", [action(), { type: "tool_result", tool_use_id: "tool-a", content: "SECRET_RESULT", is_error: true }]), "executing");
  assert.doesNotMatch(await text(), /Bash|SECRET/);
  await paint(session("A", [{ type: "text", text: "失败、完成、Bash（这些是正文，不是状态）" }]), "output");
  assert.match(await text(), /正在输出/);
  await paint(session("A", [{ type: "thinking", thinking: "fixture" }]), "thinking");
  cases.push("result retires tool; output and thinking follow block enums");

  const messageFinished = session("A", [action()]);
  messageFinished.messages[1]!.completedAt = started;
  await paint(messageFinished, "tool");
  const questionFinished = session("A", [{ type: "tool_use", id: "question", name: "AskUserQuestion", input: {} }]);
  questionFinished.messages[1]!.completedAt = started;
  await paint(questionFinished, "waiting");
  questionFinished.messages.push({ role: "user", requestId: "request", content: [{ type: "tool_result", tool_use_id: "question", content: "answered" }] });
  await paint(questionFinished, "executing");
  cases.push("message-stream completion keeps tools and questions active until their matching result");

  await paint(session("A", [action()]), "tool", "other");
  await paint(session("B", [action("ReadFile", "tool-a")]), "tool");
  await browser.wait("document.querySelector('#session .chat-running-text').textContent.includes('ReadFile')");
  assert.equal(await browser.evaluate("document.querySelector('#session .chat-running-bar').dataset.sourceSession"), "B");
  assert.match(await text("other"), /Bash/);
  const foreign = session("B", [action()]); foreign.messages[1]!.author!.sessionId = "A";
  await paint(foreign, "executing");
  assert.doesNotMatch(await text(), /Bash/);
  cases.push("same host switches source; same tool ID does not leak another session");

  for (const state of ["failed", "stopped"]) {
    await paint(session("B", [action()], { status: state }), state);
    assert.equal(await text(), state === "failed" ? "执行失败" : "已停止");
    assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#session .chat-running-pulse')).animationName"), "none");
    assert.equal(await browser.evaluate("document.querySelector('#session .chat-running-bar').getAttribute('aria-live')"), "polite");
  }
  await paint(session("B", [action()], { archived: true }), null);
  await paint({ status: "running", ptyRunning: false, lastActivityAt: started }, null);
  cases.push("terminal states stop animation; archive and bare PTY remove the status");

  await paint({ id: "Q", status: "idle", queuedMessages: ["next"], turnStartedAt: started }, "received");
  assert.equal(await text(), "已接收 · 排队中");
  await paint({ id: "Q", permissionBlocked: true, queuedMessages: ["next"] }, "waiting");
  assert.match(await text(), /等待你确认操作/);
  cases.push("waiting outranks queue; queued input does not fake elapsed execution");

  await browser.evaluate(`window.paintRun(${JSON.stringify(session("run", [action()], { status: "running" }))});true`);
  await browser.wait("document.querySelector('#team-run .chat-running-bar')?.dataset.phase === 'executing'");
  assert.doesNotMatch(await text("team-run"), /Bash|SECRET/);
  cases.push("team run never borrows member tool activity");

  await paint(session("B", [action("A".repeat(64))]), "tool");
  for (const width of [390, 320]) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: false });
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await browser.settle();
    assert.equal(await browser.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), true);
    assert.equal(await browser.evaluate("getComputedStyle(document.querySelector('#session .chat-running-pulse')).animationName"), "none");
    assert.equal(await browser.evaluate("window.firstDraft === document.getElementById('draft') && document.getElementById('draft').value === '本机测试草稿，不发送'"), true);
    await browser.screenshot(join(evidence, `status-${width}px.png`));
  }
  cases.push("narrow and reduced-motion retain draft node and fit viewport");
  await browser.evaluate("window.clearStatus();true");
  await browser.wait("document.getElementById('session').childElementCount === 0");
  await paint(session("A", [action()]), "tool");
  assert.deepEqual(browser.errors, []);
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, cases, errors: browser.errors }, null, 2));
});
