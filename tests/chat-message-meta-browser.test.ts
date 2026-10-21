import { themeFixtureHtml } from "./helpers/theme-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

function textContrast(text: string, background: string): number {
  const rgba = text.match(/[\d.]+/g)!.map(Number);
  const bg = background.match(/[\d.]+/g)!.map(Number);
  const alpha = rgba[3] ?? 1;
  const channels = rgba.slice(0, 3).map((value, index) => value * alpha + bg[index]! * (1 - alpha));
  const luminance = (rgb: number[]): number => rgb.slice(0, 3).map(value => {
    value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0);
  const a = luminance(channels), b = luminance(bg);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

// Real production renderer and Ant components. Synthetic messages only; no provider requests.
test("canonical messages preserve body and compact metadata across live patches", {
  skip: process.env.WAND_CHAT_BROWSER !== "1", timeout: 180_000,
}, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temp = mkdtempSync(join(tmpdir(), "wand-chat-meta-"));
  const evidence = process.env.WAND_CHAT_EVIDENCE_DIR || join(root, "output/chat-layout-meta-20261007/browser");
  mkdirSync(evidence, { recursive: true });
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import "./tests/helpers/realtime-refresh-focus-harness.ts";
    import { installReactUiStyles } from "./src/web-ui/react/styles";
    import { presentChat } from "./src/web-ui/react/chat/presentation";
    installReactUiStyles();
    window.projectLegacy = presentChat;
  ` }, bundle: true, platform: "browser", format: "iife", outfile: join(temp, "app.js"),
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning" });
  const avatarRuntime = join(temp, "plush-avatar.js");
  await build({ entryPoints: [join(root, "src/web-ui/react/avatars/renderer.ts")], bundle: true,
    platform: "browser", format: "iife", minify: true, outfile: avatarRuntime });
  const appBundle = join(temp, "app.js");
  writeFileSync(appBundle, readFileSync(appBundle, "utf8").replaceAll("${plushAvatarChunkSrc}", "/assets/plush-avatar.js"));
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://fixture.test");
    const files: Record<string, [string, string]> = {
      "/app.js": [join(temp, "app.js"), "text/javascript"],
      "/assets/plush-avatar.js": [avatarRuntime, "text/javascript"],
      "/styles.css": [join(root, "src/web-ui/content/styles.css"), "text/css"],
      "/tailwind.css": [join(root, "src/web-ui/content/tailwind.css"), "text/css"],
    };
    const file = files[url.pathname];
    if (file) { res.setHeader("Content-Type", file[1]); res.end(readFileSync(file[0])); return; }
    if (url.pathname.includes("/tool-content/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ input: { command: "printf fixture" }, content: "explicit fixture result", pending: false, resultAvailable: true })); return;
    }
    if (url.pathname.startsWith("/api/")) { res.writeHead(404); res.end("{}"); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(themeFixtureHtml(`<!doctype html><html lang="zh-CN" class="${url.searchParams.has("native") ? "is-wand-app" : ""}">
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css">
      <style>#chat-output { height:100dvh; display:flex; }</style></head>
      <body><div id="chat-output"></div><textarea id="input-box" hidden></textarea><script src="/app.js"></script></body></html>`));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const chrome = spawn(process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--disable-gpu", "--no-first-run", "--remote-allow-origins=*", "--remote-debugging-port=0", `--user-data-dir=${temp}/profile`, "about:blank",
  ], { stdio: "ignore" });
  const pause = (ms: number) => new Promise(resolvePause => setTimeout(resolvePause, ms));
  let socket: WebSocket | undefined;
  const cases: unknown[] = [];
  const errors: string[] = [];
  try {
    const activePort = join(temp, "profile/DevToolsActivePort");
    for (let i = 0; i < 120 && !existsSync(activePort); i++) await pause(50);
    assert.ok(existsSync(activePort), "real Chrome must start");
    const port = readFileSync(activePort, "utf8").split("\n")[0];
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    socket = new WebSocket(tabs.find(tab => tab.type === "page")!.webSocketDebuggerUrl); await once(socket, "open");
    let sequence = 0;
    const pending = new Map<number, (value: any) => void>();
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if (message.id && pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
    });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise(resolveSend => {
      const id = ++sequence; pending.set(id, resolveSend); socket!.send(JSON.stringify({ id, method, params }));
    }).then(message => { if (message.error) throw new Error(JSON.stringify(message.error)); return message.result; });
    const evaluate = async (expression: string): Promise<any> => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
    };
    const wait = async (expression: string): Promise<void> => {
      for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await pause(40); }
      throw new Error(`Timeout: ${expression}`);
    };
    const screenshot = async (name: string): Promise<void> => {
      const result = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(evidence, `${name}.png`), Buffer.from(result.data, "base64"));
    };
    await send("Runtime.enable");
    const fixtures = [
      { role: "user", uuid: "meta-user-1", createdAt: "2026-10-07T09:00:00Z", content: [{ type: "text", text: "请核对聊天气泡和回复统计。" }] },
      { role: "assistant", uuid: "meta-reply-1", createdAt: "2026-10-07T09:00:02Z", completedAt: "2026-10-07T09:00:41Z",
        author: { id: "meta-peer", name: "布局伙伴", sessionId: "fixture-source-session" },
        usage: { inputTokens: 12345, outputTokens: 678, cacheReadInputTokens: 4096, totalCostUsd: .01231 },
        content: [{ type: "tool_use", id: "meta-tool-1", name: "Bash", input: {}, activity: { kind: "run_command", label: "核对布局" } },
          { type: "tool_result", tool_use_id: "meta-tool-1", content: "explicit fixture result" },
          { type: "text", text: "**核对结果**\n\n- 正文在气泡内\n- Token 与时间共用统计栏\n\n```ts\nconst checked = true;\n```" }] },
      { role: "user", uuid: "meta-user-2", createdAt: "2026-10-07T09:01:00Z", content: [{ type: "text", text: "继续核对实时统计。" }] },
      { role: "assistant", uuid: "meta-reply-2", createdAt: "2026-10-07T09:01:02Z", usage: { inputTokens: 900, outputTokens: 120, estimated: true },
        content: [{ type: "text", text: "短回复也在气泡内，当前输出用量仍是估算值。" }] },
    ];
    for (const mode of ["desktop", "390px", "320px", "native-shell", "reactUi=0", "reduce-motion"]) {
      const width = mode === "320px" ? 320 : mode === "desktop" || mode === "reactUi=0" ? 1280 : 390;
      await send("Emulation.setDeviceMetricsOverride", { width, height: 960, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduce-motion" ? "reduce" : "no-preference" }] });
      await send("Page.navigate", { url: `${origin}/?mode=${mode}${mode === "native-shell" ? "&native=1" : ""}` });
      await wait("!!window.focusRefreshHarness");
      await evaluate(`(async()=>{ window.h=window.focusRefreshHarness; window.metaTurns=${JSON.stringify(fixtures)};
        window.openedAuthor=null;window.__openAuthorSession=id=>{window.openedAuthor=id;};await h.fresh(metaTurns); })()`);
      await evaluate("h.publish(metaTurns,{employeeId:'e_meta',employeeName:'布局伙伴',employeeAvatar:'',provider:'codex'});h.doRenderChat(false)");
      await wait("!!document.querySelector('.chat-message[data-msg-index=\"1\"] .chat-message-time time')");
      await wait("document.querySelector('.chat-message[data-msg-index=\"3\"] .chat-message-content')?.innerText.includes('短回复')");
      const shape = await evaluate(`(()=>{
        const row=document.querySelector('.chat-message[data-msg-index="1"]');
        const surface=row.querySelector('.wand-chat-message-content'); const body=row.querySelector('.chat-message-content');
        const time=row.querySelector('.chat-message-time time'); const r=surface.getBoundingClientRect(),b=body.getBoundingClientRect();
        return { variant:surface.className, bodyInside:surface.contains(body),
          bodyFits:b.left>=r.left&&b.right<=r.right+1&&b.top>=r.top&&b.bottom<=r.bottom+1,
          fontSize:getComputedStyle(time).fontSize, color:getComputedStyle(time).color,
          usage:row.querySelectorAll('.turn-usage-summary').length, time:time.textContent,
          duration:row.querySelector('.chat-message-time').textContent, clockIso:time.dateTime,
          badgeLabel:row.querySelector('.wand-employee-avatar-provider')?.getAttribute('aria-label'),
          badgeRadius:getComputedStyle(row.querySelector('.wand-employee-avatar-provider .ant-avatar')).borderRadius,
          badgeColor:getComputedStyle(row.querySelector('.wand-employee-avatar-provider .ant-avatar')).color,
          badgeBackground:getComputedStyle(row.querySelector('.wand-employee-avatar-provider .ant-avatar')).backgroundColor,
          badgeSize:row.querySelector('.wand-employee-avatar-provider').getBoundingClientRect().width,
          badgeLogo:row.querySelector('[data-provider-logo]')?.getAttribute('data-provider-logo'),
          avatarWidth:row.querySelector('.assistant-author-avatar')?.getBoundingClientRect().width,
          overflow:document.documentElement.scrollWidth>innerWidth+1,
          background:(()=>{let n=time;while(n){const c=getComputedStyle(n).backgroundColor;if(!c.endsWith(', 0)')&&c!=='transparent')return c;n=n.parentElement;}return 'rgb(255, 255, 255)';})() };
      })()`);
      assert.match(shape.variant, /wand-chat-message-content/);
      assert.equal(shape.bodyInside && shape.bodyFits, true, `${mode}: text belongs to the shared message`);
      const assertStaticReplies = async () => {
        const avatars = await evaluate(`({
          staticCount: document.querySelectorAll('.assistant-author-avatar [data-renderer="static"]').length,
          canvases: document.querySelectorAll('.assistant-author-avatar canvas').length,
          runtimeLoaded: performance.getEntriesByType('resource').some(entry => entry.name.includes('/assets/plush-avatar.js'))
        })`);
        assert.ok(avatars.staticCount >= 2, `${mode}: reply employees retain static identity`);
        assert.equal(avatars.canvases, 0, `${mode}: replies never mount canvas`);
        assert.equal(avatars.runtimeLoaded, false, `${mode}: replies do not load the 3D runtime`);
      };
      await assertStaticReplies();
      assert.equal(shape.fontSize, "12px");
      assert.ok(textContrast(shape.color, shape.background) >= 4.5, `${mode}: small metadata remains readable`);
      assert.equal(shape.usage, 0, `${mode}: the transcript no longer carries a per-turn usage row`);
      assert.match(shape.duration, /耗时 39 秒/); assert.equal(shape.clockIso, "2026-10-07T09:00:41Z");
      assert.ok(textContrast(shape.badgeColor, shape.badgeBackground) >= 4.5, `${mode}: tool mark contrasts with its own surface`);
      assert.equal(shape.avatarWidth, 56);assert.equal(shape.badgeLabel,"Codex CLI");assert.equal(shape.badgeLogo,"codex");assert.equal(shape.badgeRadius,"4px");assert.equal(shape.badgeSize,20); assert.equal(shape.overflow, false, `${mode}: viewport overflow: ${JSON.stringify(shape)}`);
      // Quiet identity changes update the corner mark without replacing the transcript.
      const changedIdentity = await evaluate(`(async()=>{
        const row=document.querySelector('.chat-message[data-msg-index="1"]');
        const body=row.querySelector('.chat-message-content');
        const button=row.querySelector('.assistant-reply-disclosure');button.focus();
        h.publish(metaTurns,{provider:'pi',structuredState:{inFlight:false,engine:'core'}});
        h.doRenderChat(false);await h.frames();
        const sdkLabel=row.querySelector('.wand-employee-avatar-provider')?.getAttribute('aria-label');
        const wandMark=!!row.querySelector('[data-wand-brand="pixel-cat"]');
        const stableBody=body===row.querySelector('.chat-message-content');
        const stableFocus=document.activeElement===button;
        h.publish(metaTurns,{provider:'codex',structuredState:{engine:'cli'}});h.doRenderChat(false);await h.frames();
        return {sdkLabel,wandMark,stableBody,stableFocus,
          finalLogo:row.querySelector('[data-provider-logo]')?.getAttribute('data-provider-logo')};
      })()`);
      assert.equal(changedIdentity.sdkLabel, "Wand Agent");
      assert.equal(changedIdentity.wandMark, true, `${mode}: SDK uses the Wand mark`);
      assert.equal(changedIdentity.stableBody, true, `${mode}: identity refresh preserves the body`);
      assert.equal(changedIdentity.stableFocus, true, `${mode}: identity refresh preserves the focused disclosure`);
      assert.equal(changedIdentity.finalLogo, "codex");
      if (process.env.WAND_CHAT_META_SCREENSHOTS !== "0") await screenshot(mode);
      assert.equal(await evaluate("document.querySelector('.chat-message[data-msg-index=\"1\"] [data-chat-renderer]').dataset.chatRenderer"), "canonical");
      assert.ok(await evaluate("!!document.querySelector('.chat-message[data-msg-index=\"1\"] .assistant-author-name').textContent"));

      // Estimated -> final, added/removed usage, and completion all patch the same Wand message.
      const settled = await evaluate(`(async()=>{
        const row=document.querySelector('.chat-message[data-msg-index="3"]'); const bubble=row.querySelector('.wand-chat-message');
        const body=row.querySelector('.chat-message-content');
        metaTurns[3]={...metaTurns[3],completedAt:'2026-10-07T09:01:14Z',usage:{inputTokens:900,outputTokens:240,estimated:false},
          content:[{type:'text',text:'实时统计已核对，服务端最终用量已返回。'}]};
        h.publish(metaTurns); h.doRenderChat(false); await h.frames();
        return {sameRow:row===document.querySelector('.chat-message[data-msg-index="3"]'),sameBubble:bubble===row.querySelector('.wand-chat-message'),
          sameBody:body===row.querySelector('.chat-message-content'),
          text:row.textContent,usageLines:row.querySelectorAll('.turn-usage-summary').length};
      })()`);
      assert.equal(settled.sameRow && settled.sameBubble && settled.sameBody, true, `${mode}: stable owned nodes`);
      assert.equal(settled.usageLines, 0); assert.match(settled.text, /耗时 12 秒/); assert.doesNotMatch(settled.text, /输入 900/);
      const missing = await evaluate(`(async()=>{
        delete metaTurns[3].usage; delete metaTurns[3].completedAt;
        h.publish(metaTurns);h.doRenderChat(false);await h.frames();
        const row=document.querySelector('.chat-message[data-msg-index="3"]');
        return {usage:row.querySelectorAll('.turn-usage-summary').length,duration:row.querySelector('.chat-message-time').textContent};
      })()`);
      assert.equal(missing.usage, 0); assert.doesNotMatch(missing.duration, /耗时/);
      await evaluate(`(async()=>{metaTurns[3].usage={inputTokens:10,outputTokens:20};h.publish(metaTurns);h.doRenderChat(false);await h.frames();})()`);
      assert.equal(await evaluate("document.querySelectorAll('.chat-message[data-msg-index=\"3\"] .turn-usage-summary').length"), 0, "late usage does not bring back a per-turn row");
      // The existing disclosure still hides/reveals the reply body.
      const disclosure = '.chat-message[data-msg-index="3"] .assistant-reply-disclosure';
      await evaluate(`document.querySelector(${JSON.stringify(disclosure)}).click()`);
      assert.equal(await evaluate("document.querySelector('.chat-message[data-msg-index=\"3\"] .chat-message-content').checkVisibility({checkVisibilityCSS:true})"), false);
      await evaluate(`document.querySelector(${JSON.stringify(disclosure)}).click()`);
      assert.equal(await evaluate("document.querySelector('.chat-message[data-msg-index=\"3\"] .chat-message-content').checkVisibility({checkVisibilityCSS:true})"), true);
      await assertStaticReplies();
      const plain = await evaluate(`(async()=>{await h.fresh([{role:'assistant',uuid:'plain-metadata',content:[{type:'text',text:'没有统计信息的回复。'}]}]);
        const row=document.querySelector('.chat-message[data-msg-index="0"]');return {footer:row.querySelectorAll('.turn-usage-summary').length,text:row.textContent};})()`);
      assert.equal(plain.footer, 0, "absent metadata never reserves an empty footer");
      assert.match(plain.text, /没有统计信息/);
      // The provider corner mark must never replace the employee's actual face.
      const identity = await evaluate(`(async()=>{
        const avatar='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>');
        await h.fresh([{role:'assistant',uuid:'native-identity',content:[{type:'text',text:'自定义头像核对'}]}],
          {employeeId:'fixture-upload-peer',employeeName:'上传员工',employeeAvatar:avatar,provider:'codex'});
        const row=document.querySelector('.chat-message[data-msg-index="0"]');
        return {src:row.querySelector('.ant-avatar img')?.getAttribute('src'),expected:avatar,badge:!!row.querySelector('.ant-badge'),name:row.textContent};
      })()`);
      assert.equal(identity.src, identity.expected); assert.equal(identity.badge, true); assert.match(identity.name, /上传员工/);
      cases.push({ mode, shape, settled, missing, nativeIdentity: true });
    }
    assert.deepEqual(errors, []);
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: true, scope: "Production source and native Ant/X components; synthetic history; not installed-service acceptance", cases, errors }, null, 2));
  } catch (error) {
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: false, cases, errors, error: String(error) }, null, 2)); throw error;
  } finally {
    socket?.close();
    if (chrome.exitCode === null) { const exit = once(chrome, "exit"); chrome.kill(); await exit; }
    server.close(); rmSync(temp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});
