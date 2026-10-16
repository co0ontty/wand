import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { openBrowser } from "./helpers/sidebar-ux-browser.mjs";

test("explicit completion viewing waits for content, retries failures and leaves activity while selected", {
  skip: process.env.WAND_COMPLETION_BROWSER !== "1", timeout: 180_000,
}, async () => {
  const root = resolve(import.meta.dirname, ".."), temp = mkdtempSync(join(tmpdir(), "wand-completion-browser-"));
  const session = { id: "completion-fixture", provider: "claude", sessionKind: "structured", status: "idle",
    command: "claude", cwd: "/tmp", completionRevision: 2, viewedCompletionRevision: 1,
    structuredState: { inFlight: false }, messages: [{ role: "assistant", content: [{ type: "text", text: "Completed fixture result" }] }],
    messageTotal: 1, messageOffset: 0, output: "", queuedMessages: [] };
  let views = 0, rejectView = true, holdDetail = true, releaseDetail: (() => void) | undefined;
  await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import './tests/helpers/composer-panels-browser-harness';
    import {selectSession} from './src/web-ui/browser/session-engine';
    import {filterActiveGroups} from './src/web-ui/react/workspaces/sidebar-display-mode';
    import {collectRecentEntries,recentConversationGroups} from './src/web-ui/react/workspaces/sidebar-recent';
    import {isSessionJustCompleted} from './src/session-completion-state';
    window.completionFixture={async setup(){await composerPanels.setup();composerPanels.state.sessions=[${JSON.stringify(session)}];
      const b=document.createElement('button');b.id='completion-open';b.textContent='查看完成结果';b.onclick=()=>selectSession('completion-fixture');document.body.prepend(b);},
      result(){const state=composerPanels.state,s=state.sessions.find(s=>s.id==='completion-fixture');
        const groups=[{workspaceId:'w',workspaceName:'W',workspaceCwd:'/tmp',tasks:[],standaloneSessions:[s]}];
        return {selected:state.selectedId,unread:isSessionJustCompleted(s),viewed:s.viewedCompletionRevision,
          directory:filterActiveGroups(groups,state.selectedId)[0].standaloneSessions.length,
          recent:recentConversationGroups(collectRecentEntries(groups),{activeOnly:true,selectedSessionId:state.selectedId}).flatMap(g=>g.entries).length};}};
  ` }, bundle: true, platform: "browser", format: "iife", jsx: "automatic", outfile: join(temp, "app.js"), logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } });
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://fixture.invalid").pathname;
    if (path.startsWith("/api/")) {
      response.setHeader("Content-Type", "application/json");
      if (path.endsWith("/completion/view")) {
        views++;
        if (rejectView) { response.statusCode = 503; response.end(JSON.stringify({ error: "Fixture unavailable" })); return; }
        session.viewedCompletionRevision = 2;
        response.end(JSON.stringify({ completionRevision: 2, viewedCompletionRevision: 2 })); return;
      }
      if (path === `/api/sessions/${session.id}`) {
        const send = () => response.end(JSON.stringify(session));
        if (holdDetail) { releaseDetail = send; return; }
        send(); return;
      }
      response.end(JSON.stringify(path === "/api/sessions" ? [session]
        : path === "/api/tasks" ? { groups: [], revision: "fixture" }
        : path === "/api/session-check" ? { authed: false } : {})); return;
    }
    const files: Record<string, string> = { "/app.js": join(temp, "app.js"), "/styles.css": join(root, "src/web-ui/content/styles.css"), "/tailwind.css": join(root, "src/web-ui/content/tailwind.css") };
    if (files[path]) { response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : "text/css"); response.end(readFileSync(files[path])); return; }
    response.setHeader("Content-Type", "text/html;charset=utf-8");
    response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/tailwind.css"><style>#panels-source-host{display:flex;flex-direction:column;height:80vh}#chat-output{flex:1;min-height:0}#app{height:0}</style><script src="/app.js"></script>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const browser = await openBrowser(`http://127.0.0.1:${address.port}/`, 1280, 900);
  try {
    await browser.wait("!!window.completionFixture"); await browser.evaluate("completionFixture.setup()");
    await browser.click("#completion-open");
    assert.equal(views, 0, "the cleared/loading result must not consume completion");
    assert.equal(await browser.evaluate("completionFixture.result().unread"), true);
    assert.ok(releaseDetail); holdDetail = false; releaseDetail();
    await browser.wait("document.querySelector('#chat-output')?.innerText.includes('Completed fixture result')");
    await browser.wait("completionFixture.result().selected==='completion-fixture'");
    for (let i = 0; i < 100 && views === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(views > 0); assert.equal(await browser.evaluate("completionFixture.result().unread"), true, "failed confirmation preserves unread completion");
    rejectView = false; await browser.click("#completion-open");
    await browser.wait("completionFixture.result().viewed===2");
    assert.deepEqual(await browser.evaluate("completionFixture.result()"), { selected: session.id, unread: false, viewed: 2, directory: 0, recent: 0 });
    assert.ok(await browser.evaluate("document.querySelector('#chat-output')?.innerText.includes('Completed fixture result')"), "the open result stays visible after leaving the filter");
    assert.deepEqual(browser.errors, []);
  } finally { releaseDetail?.(); await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(temp, { recursive: true, force: true }); }
});
