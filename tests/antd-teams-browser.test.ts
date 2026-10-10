import { themeFixtureHtml } from "./helpers/theme-fixture.js";
import { cssEvidenceCapture } from "./helpers/antd-css-evidence.js";
import { peopleContrastExpression } from "./helpers/people-layout-contrast.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";

/**
 * Lane gate for the AI teams / employees migration: mounts the real page components
 * against a local canned API and drives them with genuine Chrome input. Canned JSON
 * is fixture data for this lane only; installed-service acceptance stays with integration.
 * Opt in with WAND_TEAMS_BROWSER=1 because it needs a local Chrome.
 */
test("Ant Design teams pages keep library controls, chat ownership and keyboard contracts", { timeout: 180_000, skip: process.env.WAND_TEAMS_BROWSER !== "1" }, async () => {
  const root = resolve(import.meta.dirname, "..");
  const temporary = mkdtempSync(join(tmpdir(), "wand-antd-teams-"));
  const artifact = join(root, "output/web-ui-library-migration/lanes/teams");
  const browserErrors: string[] = [];
  const evidence: Array<Record<string, unknown>> = [];
  const employeesOnly = process.env.WAND_TEAMS_BROWSER_SCOPE === "employees";
  const posts: Array<Record<string, unknown>> = [];
  const source = `
    import * as React from "react";
    import { createRoot } from "react-dom/client";
    import { WandUiProvider } from "./src/web-ui/react/theme";
    import { installReactUiStyles, installStyleSheet } from "./src/web-ui/react/styles";
    import { PortalContainerProvider } from "./src/web-ui/react/ui";
    import { aiTeamsChunkStyles } from "./src/web-ui/react/ai-teams/styles";
    import { AiTeamsPage } from "./src/web-ui/react/ai-teams/teams-page";
    import { TeamChatPage } from "./src/web-ui/react/ai-teams/team-chat-page";
    import { TeamChatView } from "./src/web-ui/react/ai-teams/team-chat-view";
    import { conversationUi } from "./src/web-ui/react/conversations/state";
    import { configureTeamChatComposerRuntime } from "./src/web-ui/react/ai-teams/composer-bridge";
    import { notifyAiTeamStepLive } from "./src/web-ui/react/ai-teams/repository";
    import * as dispatchRoster from "./src/web-ui/react/team-dispatch/roster";

    // 生产里这份注册表由 lazy.tsx 装上；这里照同一把钥匙装同一份共享模块。
    globalThis.__wandAiTeamsHost = key => {
      if (key === "team-dispatch/roster") return dispatchRoster;
      throw new Error("unexpected host key " + key);
    };
    installReactUiStyles();
    installStyleSheet("wand-ai-teams-styles", aiTeamsChunkStyles);

    const drafts = new Map();
    const listeners = new Set();
    const fixture = { submits: [], drafts, toolbar: 0 };
    const empty = () => ({ text: "", attachments: [], revision: 0 });
    const read = id => drafts.get(id || "") ?? empty();
    configureTeamChatComposerRuntime({
      read,
      edit: (id, change) => {
        if (!("text" in change)) return false;
        const key = id || "";
        const current = read(key);
        drafts.set(key, { ...current, text: change.text, revision: current.revision + 1 });
        for (const listener of listeners) listener();
        return true;
      },
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      submit: (id, text, deliver) => {
        fixture.submits.push({ sessionId: id, text });
        return Promise.resolve(deliver({ text, attachments: [] }));
      },
    });

    function App() {
      const readMode = () => globalThis.location.hash === "#chat" ? "chat" : globalThis.location.hash === "#route" ? "route" : "teams";
      const [mode, setMode] = React.useState(readMode);
      const [detail, setDetail] = React.useState(null);
      React.useEffect(() => {
        const onHash = () => setMode(readMode());
        globalThis.addEventListener("hashchange", onHash);
        return () => globalThis.removeEventListener("hashchange", onHash);
      }, []);
      React.useEffect(() => {
        if (mode !== "chat") return;
        let active = true;
        fetch("/api/ai-team-runs/run-a").then(response => response.json()).then(value => { if (active) setDetail(value); });
        return () => { active = false; };
      }, [mode]);
      // The old run route now hands off to the canonical conversation. Keep its routing
      // contract separate from the exported chat renderer's component regression.
      return mode === "route" ? <TeamChatPage runId="run-a" onOpenSession={() => undefined}/>
        : mode === "chat" ? detail ? <TeamChatView detail={detail} onChange={setDetail} onOpenSession={() => undefined}/> : null
          : <AiTeamsPage/>;
    }

    globalThis.teamsFixture = { fixture, notifyAiTeamStepLive, routeState: conversationUi.getSnapshot,
      pushLive: steps => notifyAiTeamStepLive({ runId: "run-a", steps }) };
    const portal = document.getElementById("wand-react-ui-portals");
    createRoot(document.getElementById("root")).render(
      <PortalContainerProvider container={portal}><WandUiProvider><App/></WandUiProvider></PortalContainerProvider>,
    );
  `;
  await build({
    stdin: { contents: source, resolveDir: root, loader: "tsx" },
    bundle: true, format: "iife", platform: "browser", jsx: "automatic",
    outfile: join(temporary, "app.js"), logLevel: "warning",
    define: { "process.env.NODE_ENV": '"production"' },
  });

  const now = "2026-10-03T10:00:00.000Z";
  const agent = { kind: "structured", provider: "claude", model: "default", thinkingEffort: "default" };
  const member = (id: string, name: string, leader = false, duty = "负责交付") =>
    ({ id, name, duty, isLeader: leader, agents: [agent], agent, avatar: "cat:0", role: "any" });
  const team = (id: string, name: string, members: unknown[]) => ({
    id, name, description: `${name}的简介`, instructions: "", requirePlanApproval: true, maxSteps: 12,
    members, createdAt: now, updatedAt: now,
  });
  const employees = [
    { id: "emp-active", name: "景行", duty: "实现", prompt: "实现者设定", avatar: "cat:1", tags: ["开发"],
      agents: [agent], createdAt: now, updatedAt: now },
    { id: "emp-archived", name: "旧档", duty: "归档样本", prompt: "已归档", avatar: "", tags: [],
      agents: [agent], archivedAt: now, createdAt: now, updatedAt: now },
  ];
  let qaEmployeeCount: number | null = null;
  let qaStatuses = false;
  const detail = {
    run: {
      id: "run-a", taskId: "task-a", teamId: "team-a",
      team: team("team-a", "协作团队", [member("m-lead", "负责人", true), member("m-dev", "实现者")]),
      objective: "把设置页的模型下拉换成可搜索的选择器，并补单测。",
      cwd: "/synthetic", status: "running", statusDetail: "正在执行第 3 步", stepsUsed: 2, stepLimit: 12,
      formatRetries: 0, planApproved: true, chatSessionId: "relay-a", pendingNotes: [],
      createdAt: now, updatedAt: now,
    },
    steps: [{ id: "step-1", seq: 1, kind: "work", title: "实现 Web 端", memberId: "m-dev", status: "running",
      sessionId: "session-dev", reportPath: "/synthetic/report-0.md", report: "改好了" }],
    chatTurns: [
      { role: "user", createdAt: "2026-10-03T09:59:00.000Z", content: [{ type: "text",
        text: Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 行：把报告写短一点，只留结论与验证方式。`).join("\n") }] },
      { role: "assistant", notice: true, createdAt: "2026-10-03T09:59:30.000Z",
        author: { id: "m-lead", name: "负责人", leader: true },
        content: [{ type: "text", text: "邀请 @实现者、@负责人 加入群聊" }] },
      { role: "assistant", createdAt: "2026-10-03T09:59:35.000Z",
        author: { id: "m-lead", name: "负责人", leader: true },
        content: [{ type: "text", text: "计划\n\n1. **@实现者** 实现 Web 端" }] },
      { role: "assistant", createdAt: "2026-10-03T09:59:40.000Z",
        author: { id: "m-dev", name: "实现者", sessionId: "session-dev" },
        reportFile: { stepId: "step-1", path: "/synthetic/report-0.md", name: "report-0.md", size: 2048,
          preview: { title: "实现 Web 端报告", excerpt: "服务器给的冻结摘要" } },
        content: [{ type: "text", text: "✅ 完成「实现 Web 端」\\n\\n改好了" }] },
    ],
    memberStates: { "session-dev": "working" },
    delivery: {
      runId: "run-a", updatedAt: now, headline: "已交付 2 个文件", conclusion: "负责人交付说明",
      files: [{ stepId: "step-1", seq: 1, memberId: "m-dev", memberName: "实现者", title: "实现 Web 端",
        file: { stepId: "step-1", path: "/synthetic/secret-card.png", name: "secret-card.png", size: 100,
          preview: { title: "冻结标题", excerpt: "冻结摘录" } } }],
      totalFiles: 1, handoffs: [], totalHandoffs: 0, attention: null,
    },
  };

  await build({entryPoints:[join(root,"src/web-ui/react/avatars/renderer.ts")],bundle:true,format:"iife",platform:"browser",outfile:join(temporary,"plush-avatar.js"),logLevel:"warning"});
  writeFileSync(join(temporary,"app.js"),readFileSync(join(temporary,"app.js"),"utf8").replaceAll("${plushAvatarChunkSrc}","/plush-avatar.js"));
  let routeLinked = true;
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    const send = (value: unknown, status = 200): void => {
      response.setHeader("content-type", "application/json");
      response.statusCode = status;
      response.end(JSON.stringify(value));
    };
    if (url === "/plush-avatar.js") {response.setHeader("content-type","application/javascript");response.end(readFileSync(join(temporary,"plush-avatar.js")));return;}
    if (url === "/app.js") {
      response.setHeader("content-type", "application/javascript");
      response.end(readFileSync(join(temporary, "app.js")));
      return;
    }
    if (url === "/styles.css") {
      response.setHeader("content-type", "text/css");
      response.end(readFileSync(join(root, "src/web-ui/content/styles.css")));
      return;
    }
    if (url === "/tailwind.css") {
      response.setHeader("content-type", "text/css");
      response.end(readFileSync(join(root, "src/web-ui/content/tailwind.css")));
      return;
    }
    if (url.startsWith("/api/ai-teams")) return send([
      team("team-a", "协作团队", [member("m-lead", "负责人", true), member("m-dev", "实现者")]),
      team("team-b", "调研小组", [member("m-lead", "负责人", true)]),
    ]);
    if (url.startsWith("/api/ai-team-runs/run-a/live")) return send({ runId: "run-a", steps: [] });
    if (url.startsWith("/api/ai-team-runs/run-a")) return send({ ...detail,
      run: { ...detail.run, ...(routeLinked ? { conversationId: "conversation-a" } : {}) } });
    if (url.startsWith("/api/ai-team-runs")) return send(qaStatuses ? [
      { ...detail.run, id: "qa-running", teamId: "team-a", status: "running" },
      { ...detail.run, id: "qa-attention", teamId: "team-b", status: "waiting_user" },
    ] : []);
    if (url.startsWith("/api/workspaces")) return send([]);
    if (url.startsWith("/api/models")) return send({ providers: [] });
    if (url.startsWith("/api/silicon-employees/") && request.method === "PUT") {
      let body = ""; request.on("data", chunk => { body += chunk; }); request.on("end", () => {
        const id = url.split("/").at(-1), index = employees.findIndex(employee => employee.id === id);
        employees[index] = { ...employees[index], ...JSON.parse(body) }; send(employees[index]);
      }); return;
    }
    if (url.startsWith("/api/silicon-employees")) return send({ employees: qaEmployeeCount === null ? employees : Array.from({ length: qaEmployeeCount }, (_, index) => ({
      ...employees[0], id: `qa-employee-${index}`, name: `研发员工 ${index + 1} · VeryLongEnglishIdentityWithChinese姓名`.repeat(3),
      duty: "负责跨端界面、无障碍、性能与交付验收 · long-role-description ".repeat(5),
    })) });
    if (url.startsWith("/api/provider-usage")) return send({});
    if (url.startsWith("/api/conversations")) return send({ conversations: routeLinked ? [{
      id: "conversation-a", kind: "group", sessionId: "relay-a", tasks: [],
    }] : [] });
    if (url.startsWith("/api/structured-sessions") && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        posts.push({ url, body });
        send({ messages: [{ role: "user", content: [{ type: "text", text: "hello from the lane gate" }],
          createdAt: "2026-10-03T10:00:05.000Z" }] });
      });
      return;
    }
    if (url.startsWith("/api/")) return send({});
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(themeFixtureHtml(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<link rel="stylesheet" href="/tailwind.css"><link rel="stylesheet" href="/styles.css">`
      + `<style>html,body{margin:0}</style></head><body><div id="root"></div>`
      + `<div id="overlay-root"><div class="wand-ui-portals" id="wand-react-ui-portals"></div></div>`
      + `<script src="/app.js"></script></body></html>`));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const chrome = spawn(
    process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", "--disable-gpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows", "--no-first-run", "--remote-allow-origins=*",
      "--remote-debugging-port=0", `--user-data-dir=${temporary}/profile`, "about:blank"],
    { stdio: "ignore" },
  );
  let socket: WebSocket | undefined;
  const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
  try {
    const portFile = join(temporary, "profile/DevToolsActivePort");
    for (let attempt = 0; attempt < 160 && !existsSync(portFile); attempt++) await pause(50);
    assert.ok(existsSync(portFile), "Chrome debugging endpoint available");
    const debugPort = readFileSync(portFile, "utf8").split("\n")[0];
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    socket = new WebSocket(targets.find((target) => target.type === "page")!.webSocketDebuggerUrl);
    await once(socket, "open");
    let sequence = 0;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: unknown; error?: unknown; result?: unknown };
      if (message.method === "Runtime.exceptionThrown") browserErrors.push(JSON.stringify(message.params));
      const call = message.id === undefined ? undefined : pending.get(message.id);
      if (!call || message.id === undefined) return;
      pending.delete(message.id);
      message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result);
    });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolveCall, rejectCall) => {
      const id = ++sequence;
      pending.set(id, { resolve: resolveCall, reject: rejectCall });
      socket!.send(JSON.stringify({ id, method, params }));
    });
    const captureCss = cssEvidenceCapture("teams");
    const evaluate = async (expression: string): Promise<any> => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      await captureCss(send);
      return result.result.value;
    };
    const wait = async (expression: string): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await evaluate(expression)) return;
        await pause(30);
      }
      throw new Error(`Timed out: ${expression}; errors=${JSON.stringify(browserErrors.slice(0, 3))} text=${await evaluate("document.body.innerText.slice(0,400)")}`);
    };
    const click = async (selector: string): Promise<void> => {
      await pause(260);
      await send("Page.bringToFront");
      const probe = async () => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});
        if(!n)return {missing:true};
        n.scrollIntoView({block:'nearest',behavior:'instant'});
        const r=n.getBoundingClientRect();
        if(r.width<=0||r.height<=0)return {hidden:true};
        const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
        if(n===hit||n.contains(hit))return {x,y,width:r.width,height:r.height};
        return {blocked:(hit&&hit.outerHTML.slice(0,160))||'nothing at point',rect:r.toJSON()}})()`);
      let obstruction = "";
      for (let attempt = 0; attempt < 40; attempt++) {
        const before = await probe();
        if (typeof before?.x !== "number") { obstruction = JSON.stringify(before); await pause(80); continue; }
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: before.x, y: before.y });
        await pause(80);
        const after = await probe();
        // A library collapse may still change the scroll extent after scrolling.
        // Click only after hover keeps the target visible and its geometry stable.
        if (typeof after?.x !== "number" || ["x", "y", "width", "height"].some((key) => Math.abs(after[key] - before[key]) > 1)) {
          obstruction = JSON.stringify({ before, after }); continue;
        }
        for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", {
          type, x: after.x, y: after.y, button: "left", clickCount: 1,
        });
        return;
      }
      assert.fail(`Cannot click ${selector} with stable hover geometry: ${obstruction}`);
    };
    const key = async (name: string): Promise<void> => {
      const code = name === "Enter" ? 13 : name === "Escape" ? 27 : 0;
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    };
    const screenshot = async (name: string): Promise<void> => {
      await pause(300); // Capture the settled product state, not an intermediate fade/FLIP frame.
      const shot = await send("Page.captureScreenshot", { format: "png" });
      mkdirSync(artifact, { recursive: true });
      writeFileSync(join(artifact, `${name}.png`), Buffer.from(shot.data, "base64"));
    };
    const RETIRED_SELECTORS = [
      "composer-plus-popover", "team-chat-attachment", "team-chat-file-open", "team-chat-file-copy",
      "team-chat-file-icon", "team-delivery-file", "team-chat-goal-head", "team-chat-goal-label",
      "team-chat-goal-meta", "team-chat-live-body", "team-chat-office-head", "wand-employee-tag",
      "wand-employee-advanced-toggle", "wand-team-candidate-tool", "wand-team-candidate-add",
      "wand-team-empty-line", "wand-settings-label",
    ];
    // 退役的旧控件类名必须在真实页面里一个节点都不剩（不是只靠 grep 判死）。
    const assertRetiredSelectorsGone = async (scope: string): Promise<void> => {
      const found = await evaluate(`JSON.stringify(${JSON.stringify(RETIRED_SELECTORS)}
        .flatMap(name => Array.from(document.querySelectorAll('.' + name)).map(node => name + ':' + node.tagName)))`);
      assert.deepEqual(JSON.parse(found), [], `${scope}: 退役的旧控件类名在页面上已经没有节点`);
    };
    await send("Page.enable");
    await send("Runtime.enable");

    for (const mode of (process.env.WAND_TEAMS_TEST_MODES?.split(",") ?? ["desktop", "mobile", "reduced-motion"])) {
      await send("Emulation.setDeviceMetricsOverride", { width: mode === "mobile" ? 390 : 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduced-motion" ? "reduce" : "no-preference" }] });
      await evaluate("window.__wandFixtureBeforeNavigation = true");
      await send("Page.navigate", { url: `${origin}/?mode=${mode}` });
      await wait("!window.__wandFixtureBeforeNavigation && document.readyState === 'complete'");
      await send("Page.bringToFront");
      await wait("!!document.querySelector('.wand-employee-list')");
      await wait("document.querySelectorAll('[data-employee-profile]').length === 1");

      // A selected team belongs to its own page even after a desktop-to-mobile resize.
      await click(".wand-teams-page [data-stretch-value=teams]");
      await wait("document.querySelectorAll('.wand-teams-cards .wand-teams-card').length === 2");
      await click(".wand-teams-cards .wand-teams-card");
      await wait("!!document.querySelector('.wand-teams-page[data-detail]')");
      await click(".wand-teams-page [data-stretch-value=employees]");
      await wait("!!document.querySelector('.wand-employee-list [data-employee-profile]')");
      await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1000, deviceScaleFactor: 1, mobile: false });
      await wait("document.querySelector('[data-employee-profile]').getBoundingClientRect().height>0");
      await pause(300);
      const employeeResize = await evaluate(`(()=>{const page=document.querySelector('.wand-teams-page'),card=document.querySelector('[data-employee-profile]'),button=document.querySelector('.wand-employee-workspace[data-collapsed=true] .directory-toggle')||document.querySelector('.directory header button');const r=card.getBoundingClientRect(),b=button.getBoundingClientRect(),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return {detail:page.hasAttribute('data-detail'),cardVisible:r.width>0&&r.height>0,cardContained:r.left>=0&&r.right<=innerWidth+1,createReachable:hit===button||button.contains(hit)}})()`);
      assert.deepEqual(employeeResize, { detail: false, cardVisible: true, cardContained: true, createReachable: true }, `${mode}: employee cards and actions survive narrowing with a selected team`);
      assert.equal(await evaluate("!!document.querySelector('.wand-teams-page button[aria-label=返回工作区]')"), true, `${mode}: selected team does not hide the employee page's back action`);
      await click(".wand-teams-page [data-stretch-value=teams]");
      await wait("!!document.querySelector('.wand-teams-page[data-detail]') && !!document.querySelector('.wand-team-member')");
      await click('[aria-label="团队模板导航"] button');
      await wait("!document.querySelector('.wand-teams-page[data-detail]')");
      await click(".wand-teams-page [data-stretch-value=employees]");
      await wait("!!document.querySelector('.wand-employee-list [data-employee-profile]')");
      await send("Emulation.setDeviceMetricsOverride", { width: mode === "mobile" ? 390 : 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
      evidence.push({ mode, employeeResize, teamSelectionPreserved: true });

      // ---- 员工页：单一编辑器、原生目录、归档筛选、统一草稿 ----
      if(await evaluate("document.querySelector('.wand-employee-workspace').dataset.collapsed==='true'")) await click('.directory-toggle');
      assert.equal(await evaluate("document.querySelectorAll('.employee-item').length"), 1, `${mode}: 只显示未归档员工`);
      await click(".directory input[type=checkbox]");
      await wait("document.querySelectorAll('.employee-item').length === 2");
      assert.equal(await evaluate("document.querySelector('.employee-item[data-directory-employee-id=emp-archived]').textContent.includes('已归档')"), true, `${mode}: 目录可见归档状态`);
      await click(".directory input[type=checkbox]");await wait("document.querySelectorAll('.employee-item').length === 1");
      const density = await evaluate(`(()=>{const avatar=document.querySelector('.employee-item .wand-employee-avatar');return {avatarWidth:avatar.getBoundingClientRect().width,editorCount:document.querySelectorAll('[data-employee-profile]').length,mutedCard:getComputedStyle(document.querySelector('[data-employee-profile]')).boxShadow==='none'};})()`);
      assert.equal(density.avatarWidth,32,`${mode}: directory uses compact 32px identity`);assert.equal(density.editorCount,1,`${mode}: one editor only`);assert.equal(density.mutedCard,true);
      await screenshot(`employees-directory-${mode}`);evidence.push({mode,density});
      if(mode==='mobile') await click('.directory header button');
      await click('.profile-tabs button[data-step=tools]');
      assert.equal(await evaluate("document.querySelectorAll('[data-employee-profile] .wand-team-candidate.ant-card').length"),0,`${mode}: candidates do not nest cards`);
      assert.equal(await evaluate("Array.from(document.querySelectorAll('[data-employee-profile] .wand-team-candidate')).every(row => parseFloat(getComputedStyle(row).borderBottomWidth) === 1)"),true);
      await click('.profile-tabs button[data-step=identity]');await click('#employee-emp-active-name');
      await evaluate("document.querySelector('#employee-emp-active-name').select()");await send('Input.insertText',{text:`验证员工 ${mode}`});
      await click('.wand-employee-save-submit');await wait("document.querySelector('.wand-employee-save-submit').textContent.includes('已保存')");
      assert.equal(employees.find(employee=>employee.id==='emp-active')?.name,`验证员工 ${mode}`,`${mode}: real repository PUT persists fixture`);
      await click('#employee-emp-active-name');await evaluate("document.querySelector('#employee-emp-active-name').select()");await send('Input.insertText',{text:'撤销此草稿'});await key('Escape');
      await wait(`document.querySelector('#employee-emp-active-name').value==='验证员工 ${mode}'`);
      assert.equal(await evaluate("document.querySelectorAll('[data-employee-profile]').length"),1,`${mode}: Escape restores draft and retains fullpage editor`);
      await screenshot(`employees-${mode}`);evidence.push({mode,employeeCard:'unified draft save and Escape rollback'});
      if(await evaluate("document.querySelector('.wand-employee-workspace').dataset.collapsed==='true'")) await click('.directory-toggle');
      await evaluate("[...document.querySelectorAll('.directory button')].find(button=>button.textContent.includes('新建员工')).dataset.testCreate='true'");await click('[data-test-create]');
      await wait("!!document.querySelector('.wand-employee-list .ant-collapse')");
      assert.equal(await evaluate("!document.querySelector('.ant-collapse textarea#new-employee-name')"),true,`${mode}: advanced creation initially collapsed`);
      await click('.wand-employee-list .ant-collapse-header');await wait("!!document.querySelector('#new-employee-name')");
      assert.equal(await evaluate("document.getElementById('new-employee-name').className.includes('ant-input')"),true);
      await click('.wand-employee-list .ant-collapse-header');await pause(200);

      if (employeesOnly) {
        assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), true, `${mode}: 员工页无横向溢出`);
        continue;
      }

      // ---- 团队页：卡片 + 详情 + 成员编辑 ----
      await click(".wand-teams-page [data-stretch-value=teams]");
      await wait("document.querySelectorAll('.wand-teams-cards .wand-teams-card').length === 2");
      assert.equal(await evaluate("document.querySelectorAll('.wand-teams-card.ant-card').length"), 2,
        `${mode}: 团队卡是通用卡片`);
      await click(".wand-teams-cards .wand-teams-card");
      await wait("!!document.querySelector('.wand-team-member .ant-card-head') || !!document.querySelector('.wand-team-member')");
      await wait("!!document.querySelectorAll('.wand-team-section')[0]");
      const firstMember = ".wand-team-org-leader .wand-team-member-head, .wand-team-org-members .wand-team-member-head";
      await screenshot(`teams-collapsed-${mode}`);
      await click(firstMember);
      await wait("!!document.querySelector('.wand-team-member[data-open] textarea')");
      const firstCandidateTransform = await evaluate("getComputedStyle(document.querySelector('.wand-team-member[data-open] .wand-team-candidate')).transform");
      assert.equal(firstCandidateTransform, "none", `${mode}: opening an editor does not replay hidden candidate positions`);
      assert.equal(await evaluate(`(()=>{const n=document.querySelector('.wand-team-member[data-open] textarea');
        return n.className.includes('ant-input')})()`), true, `${mode}: 成员职责是通用多行输入`);
      assert.equal(await evaluate(`(()=>{const s=document.querySelector('.wand-team-member[data-open] .wand-team-select .wand-ui-select-trigger');
        return !!s && Math.abs(s.getBoundingClientRect().width - s.parentElement.getBoundingClientRect().width) < 2})()`), true,
        `${mode}: 选择器铺满字段宽度`);
      const candidateBounds = await evaluate(`Array.from(document.querySelectorAll('.wand-team-member[data-open] .wand-team-candidate [role=combobox]')).map(control=>{const r=control.getBoundingClientRect(),f=control.closest('.task-board-native-field').getBoundingClientRect(),c=control.closest('.wand-team-member').getBoundingClientRect();return {label:control.getAttribute('aria-label'),right:r.right,fieldRight:f.right,cardRight:c.right,overflow:control.scrollWidth>control.clientWidth+1};})`);
      assert.ok(candidateBounds.every(control => control.right <= control.fieldRight + 1 && control.right <= control.cardRight + 1 && !control.overflow), `${mode}: candidate controls stay within both field and member card: ${JSON.stringify(candidateBounds)}`);
      const candidateModel = '.wand-team-member[data-open] .wand-team-candidate [aria-label$="模型"]';
      await click(candidateModel);
      await wait("!!document.querySelector('.wand-ui-select-content input')");
      const modelPopupBounds = await evaluate(`(()=>{const p=document.querySelector('.wand-ui-select-content'),r=p.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};})()`);
      assert.ok(modelPopupBounds.left >= 0 && modelPopupBounds.right <= (mode === "mobile" ? 390 : 1280) + 1, `${mode}: model menu remains inside the viewport`);
      await click('.wand-ui-select-content input');
      assert.equal(await evaluate("!!document.querySelector('.wand-team-member[data-open]')"), true, `${mode}: searching the model menu preserves the editor`);
      await key("Escape");
      await wait("!document.querySelector('.wand-ui-select-content')");
      assert.equal(await evaluate(`document.activeElement === document.querySelector('${candidateModel}')`), true, `${mode}: model Escape restores the model trigger`);
      const scoreBefore = await evaluate("document.querySelectorAll('.wand-team-member[data-open] .wand-team-candidate').length");
      await click(".wand-team-member[data-open] .wand-team-candidates-foot .wand-ui-button");
      await wait(`document.querySelectorAll('.wand-team-member[data-open] .wand-team-candidate').length === ${scoreBefore + 1}`);
      assert.equal(await evaluate("document.querySelectorAll('.wand-team-member[data-open] .wand-team-candidate.ant-card').length"),
        0, `${mode}: 候选使用连续行而非嵌套卡片`);
      assert.equal(await evaluate("Array.from(document.querySelectorAll('.wand-team-member[data-open] .wand-team-candidate')).every(row => parseFloat(getComputedStyle(row).borderBottomWidth) === 1)"),
        true, `${mode}: 候选行有稳定细分隔`);
      assert.equal(await evaluate("!!document.querySelector('.wand-team-member[data-open] .wand-team-candidate .ant-tag')"), true,
        `${mode}: 候选位次用通用标签`);
      assert.equal(await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"), mode === "reduced-motion",
        `${mode}: reduced-motion 媒体查询生效`);
      if (mode === "desktop" || mode === "mobile") await screenshot(`teams-${mode}`);
      await assertRetiredSelectorsGone(mode);
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), true, `${mode}: 无横向溢出`);
      const invite = ".wand-team-member[data-open] .wand-team-employee-invite";
      await click(invite + " > button");
      await wait(`document.querySelector(${JSON.stringify(invite)} + ' > button').getAttribute('aria-pressed') === 'true'`);
      await click(invite + " .wand-ui-select-trigger");
      await wait("!!document.querySelector('.wand-ui-select-content input')");
      await click(".wand-ui-select-content input");
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(invite)} + ' > button').getAttribute('aria-pressed')`), "true",
        `${mode}: search in the owned Portal does not close the invitation`);
      await key("Escape");
      await wait("!document.querySelector('.wand-ui-select-content')");
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(invite)} + ' > button').getAttribute('aria-pressed')`), "true",
        `${mode}: the first Escape closes only the selector Portal`);
      await key("Escape");
      await wait(`document.querySelector(${JSON.stringify(invite)} + ' > button').getAttribute('aria-pressed') === 'false'`);
      assert.equal(await evaluate(`document.activeElement === document.querySelector(${JSON.stringify(invite)} + ' > button')`), true,
        `${mode}: invitation Escape returns focus to the invitation trigger`);
      await click(invite + " > button");
      await click(".wand-teams-detail-head");
      await wait(`document.querySelector(${JSON.stringify(invite)} + ' > button').getAttribute('aria-pressed') === 'false'`);
      const memberName = ".wand-team-member[data-open] input[id$='-name']";
      await evaluate(`(()=>{window.__memberEditorNode=document.querySelector(${JSON.stringify(memberName)});return true})()`);
      await click('.wand-teams-detail .ant-tabs-tab[data-node-key="runs"]');
      assert.equal(await evaluate("document.querySelector('.wand-teams-detail-pane[data-hidden]').hasAttribute('inert')"), true,
        `${mode}: hidden member editor remains inert`);
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.wand-teams-detail-pane[data-hidden]').closest('[role=tabpanel]')).display"), "none",
        `${mode}: Ant hides the inactive pane without reserving height`);
      await click('.wand-teams-detail .ant-tabs-tab[data-node-key="members"]');
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(memberName)})===window.__memberEditorNode`), true,
        `${mode}: switching tabs keeps the exact editor node`);
      assert.equal(await evaluate("document.querySelectorAll('.wand-team-member[data-open] .wand-team-candidate').length"), scoreBefore + 1,
        `${mode}: unsaved candidate edits survive the tab switch`);
      evidence.push({ mode, teams: "card list, detail, member editor, candidate add and persistent library tab switching verified" });
    }

    // ---- 群聊页：X 展示 + composer bridge 所有权 + 键盘/Portal 契约 ----
    if (!employeesOnly) {
      routeLinked = false;
      await send("Page.navigate", { url: `${origin}/?route=unlinked#route` });
      await wait("document.body?.innerText.includes('此运行尚未关联群对话')");
      assert.equal(await evaluate("!!document.querySelector('[role=alert]')"), true, "无关联旧运行展示可恢复错误");
      assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).some(button => button.textContent.replace(/\\s/g, '').includes('重试'))"), true);
      assert.equal(await evaluate("!!document.querySelector('.task-board-team-chat-input')"), false, "无关联运行不提供可发送输入");
      routeLinked = true;
      await send("Page.navigate", { url: `${origin}/?route=linked#route` });
      await wait("globalThis.teamsFixture?.routeState().selectedId === 'conversation-a'");
      assert.deepEqual(await evaluate("globalThis.teamsFixture.routeState().targets['conversation-a']"), { taskId: "task-a", runId: "run-a" });
      evidence.push({ mode: "old-run-route", unlinked: "retryable error and no composer", linked: "explicit conversation/task/run handoff" });
    }
    for (const mode of (employeesOnly ? [] : process.env.WAND_TEAMS_TEST_MODES?.split(",") ?? ["desktop", "mobile", "reduced-motion"])) {
    await send("Emulation.setDeviceMetricsOverride", { width: mode === "mobile" ? 390 : 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: mode === "reduced-motion" ? "reduce" : "no-preference" }] });
    await evaluate("window.__wandFixtureBeforeNavigation = true");
      await send("Page.navigate", { url: `${origin}/?mode=chat-${mode}#chat` });
      await wait("!window.__wandFixtureBeforeNavigation && document.readyState === 'complete'");
    await send("Page.bringToFront");
    await wait("!!document.querySelector('.task-board-team-chat')");
    await wait("document.querySelectorAll('.ant-bubble').length >= 2");
    assert.equal(await evaluate("!!document.querySelector('.ant-bubble-end')"), true, "自己的发言靠气泡 placement 镜像");
    assert.equal(await evaluate("!!document.querySelector('.ant-bubble-start')"), true, "成员/负责人发言在另一侧");
    assert.equal(await evaluate("!!document.querySelector('.team-chat-plan-list')"), true, "派工清单仍按任务条目渲染");
    assert.equal(await evaluate("!!document.querySelector('.chat-notice')"), true, "系统提示行仍是居中 notice");
    assert.equal(await evaluate(`(()=>{const row=document.querySelector('.chat-notice').getBoundingClientRect();
      const text=document.querySelector('.chat-notice-line').getBoundingClientRect();
      return Math.abs(row.x+row.width/2-text.x-text.width/2)<2})()`), true, `${mode}: 系统提示内容居中`);
    assert.equal(await evaluate("!!document.querySelector('.team-chat-mention')"), true, "@ 成员名仍由本页渲染");
    assert.equal(await evaluate("!!document.querySelector('.ant-file-card')"), true, "报告文件走通用文件卡");
    assert.equal(await evaluate("document.querySelectorAll('.ant-tag').length > 0"), true, "报告 chip 用通用标签");
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('.team-chat-msg')).every(row => {
      const avatar=row.querySelector('.team-chat-avatar').getBoundingClientRect();
      const content=row.querySelector('.team-chat-msg-content').getBoundingClientRect();
      return Math.abs(avatar.y-content.y)<2 && (row.dataset.side==='end'
        ? content.right<=avatar.left+2 : avatar.right<=content.left+2);
    })`), true, `${mode}: 每条发言的头像与内容列并排，自己的发言镜像靠右`);

    // 交付面板：历史文件不预载图片流
    await click(".team-chat-context");
    await wait("!!document.querySelector('.team-chat-details[data-open] .ant-file-card')");
    assert.equal(await evaluate("document.querySelectorAll('link[rel=preload][href*=\"/api/file-\"]').length"), 0,
      "交付列表不预载文件流");
    assert.equal(await evaluate("document.querySelector('.team-chat-details').hasAttribute('inert')"), false, "展开后详情可聚焦");
    await click(".team-chat-context");
    await wait("document.querySelector('.team-chat-details').hasAttribute('inert')");

    // live 过程块：推送一步输出，展开后在固定窗口里滚
    await evaluate(`(()=>{globalThis.teamsFixture.pushLive([{ stepId: "step-1", seq: 1, memberId: "m-dev",
      memberName: "实现者", sessionId: "session-dev", state: "working", text: "第一行\\n第二行", omittedChars: 12, updatedAt: "${now}" }]);
      return true})()`);
    await wait("!!document.querySelector('.team-chat-live-think')");
    await wait("!!document.querySelector('.team-chat-live-summary')");
    assert.equal(await evaluate("!!document.querySelector('.team-chat-live-summary')"), true, "展开态有键盘可达的按钮");
    assert.equal(await evaluate("document.querySelector('.team-chat-live-think .ant-think-status-down-icon') !== null"), true,
      "过程块自带展开图标");
    await click(".team-chat-live-summary");
    await wait("document.querySelector('.team-chat-live-summary').getAttribute('aria-expanded') === 'true'");
    await wait("!!document.querySelector('.team-chat-live-card')");
    assert.equal(await evaluate("document.querySelector('.team-chat-live-summary').getAttribute('aria-expanded')"), "true");
    assert.equal(await evaluate("!!document.querySelector('.team-chat-live-text')"), true, "输出窗口保留");
    const liveHeight = await evaluate("Math.round(document.querySelector('.team-chat-live-card').getBoundingClientRect().height)");
    assert.ok(liveHeight > 100 && liveHeight < 260, `live 窗口有界，实测 ${liveHeight}px`);
    assert.equal(await evaluate("document.querySelector('.team-chat-live-text').scrollHeight > 0"), true);
    assert.equal(await evaluate("document.querySelector('.team-chat-live-card .ant-card-head')===null"), true,
      `${mode}: 原生提示不误渲染为 Card 页头`);

    // 输入框：通用发送器 + bridge 是唯一草稿 owner
    await wait("!!document.querySelector('.ant-sender textarea')");
    const composerWidths = await evaluate(`(()=>{const host=document.querySelector('.task-board-team-chat-input').getBoundingClientRect();
      const sender=document.querySelector('.ant-sender').getBoundingClientRect();return {host:host.width,sender:sender.width}})()`);
    assert.ok(Math.abs(composerWidths.host-composerWidths.sender)<2,
      `${mode}: Sender 填满群聊输入列，实测 ${JSON.stringify(composerWidths)}`);
    await click(".ant-sender textarea");
    await wait("document.activeElement===document.querySelector('.ant-sender textarea')");
    await send("Input.insertText", { text: "hello from the lane gate" });
    await wait("globalThis.teamsFixture.fixture.drafts.get('relay-a')?.text === 'hello from the lane gate'");
    assert.equal(await evaluate("document.querySelector('.ant-sender textarea').value"), "hello from the lane gate",
      "发送器显示的就是 bridge 里的草稿");
    // 输入法确认键不能当成发送
    await evaluate(`(()=>{const input=document.querySelector('.ant-sender textarea');
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      return true})()`);
    await pause(120);
    assert.equal(await evaluate("globalThis.teamsFixture.fixture.submits.length"), 0, "合成态回车不发送");
    await key("Enter");
    await wait("globalThis.teamsFixture.fixture.submits.length === 1");
    assert.equal(await evaluate("globalThis.teamsFixture.fixture.submits[0].sessionId"), "relay-a", "提交仍走群聊 relay 会话");
    await wait("!!document.querySelector('.ant-bubble-end')");
    assert.ok(posts.some((post) => String(post.url).includes("/api/structured-sessions/relay-a/messages")
      && JSON.parse(String(post.body)).input.includes("hello from the lane gate")),
      "请求体字段仍是 input");

    // 附件菜单：Portal 归属 + Escape 关闭并把焦点还给触发点
    await click(".composer-attach-trigger");
    await wait("document.querySelectorAll('.wand-ui-dropdown-content .wand-ui-dropdown-item').length === 2");
    assert.equal(await evaluate(`(()=>{const t=document.querySelector('.composer-attach-trigger');
      return t.getAttribute('aria-expanded') === 'true'})()`), true, "触发点带上展开态");
    await key("Escape");
    await wait("!document.querySelector('.wand-ui-dropdown-content')");
    assert.equal(await evaluate("document.activeElement === document.querySelector('.composer-attach-trigger')"), true,
      "Escape 把焦点还给触发点");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), true, `${mode}: 群聊无横向溢出`);
    await screenshot(`teams-chat-${mode}`);

    // 全文弹层：真实点击展开进入通用弹层，Escape 关闭
    const expanders = await evaluate("document.querySelectorAll('.team-chat-expand').length");
    assert.ok(expanders > 0, "长正文有展开入口");
    await click(".team-chat-expand");
    await wait("!!document.querySelector('[data-testid=team-chat-doc-dialog]')");
    // 全文弹层渲染的是和行内同一份消息正文（Markdown/提及投影），不是 <pre> 块：
    // 判据是「给全文而不是三行预览」——末行只在弹层里可达。
    const docText = await evaluate(`document.querySelector('[data-testid=team-chat-doc-dialog] .team-chat-doc-layer-text')?.innerText || ""`);
    assert.ok(docText.includes("第 8 行"), "弹层给全文而不是预览");
    assert.equal(await evaluate(`!!document.querySelector(".team-chat-preview")?.textContent.includes("第 8 行")`), false,
      "收起态仍然只给三行预览，末行只在弹层里可达");
    await screenshot(`teams-chat-doc-${mode}`);
    await key("Escape");
    await wait("!document.querySelector('[data-testid=team-chat-doc-dialog]')");
    assert.equal(browserErrors.length, 0, `浏览器运行期异常：${browserErrors.slice(0, 2).join(" | ")}`);
    evidence.push({ mode: `chat-${mode}`, library: ["ant-bubble", "ant-file-card", "ant-sender", "ant-think", "wand-ui-dropdown-content"],
      geometry: composerWidths,
      contracts: ["avatar beside content", "Sender fills input column", "bridge owns draft/submit", "IME Enter blocked", "relay body input", "Escape refocus", "doc dialog full text"] });

    await assertRetiredSelectorsGone("chat");
    }
    if (process.env.WAND_PEOPLE_LAYOUT_QA === "1") {
      const scenarios = [320,390,639,640,768,1440,1920].map(width=>({ width, height:900, scale:1, name:String(width) }));
      scenarios.push({ width:640, height:450, scale:2, name:"zoom200-reflow" });
      qaEmployeeCount = 1;
      qaStatuses = true;
      for (const scenario of scenarios) {
        await send("Emulation.setDeviceMetricsOverride", { width:scenario.width,height:scenario.height,deviceScaleFactor:scenario.scale,mobile:false });
        await send("Page.navigate", { url:`${origin}/?people-layout=${scenario.name}` });
        await wait("!!document.querySelector('.wand-employee-card')");
        if(await evaluate("document.querySelector('.wand-employee-workspace').dataset.collapsed==='true'"))await click('.directory-toggle');
        const geometry = await evaluate(`(()=>{const page=document.querySelector('.wand-teams-page'),header=page.querySelector('.task-board-workspace-header'),body=page.querySelector('.wand-employees-layout'),avatar=page.querySelector('.employee-item .wand-employee-avatar');return {horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,avatarWidth:avatar.getBoundingClientRect().width,headerInset:parseFloat(getComputedStyle(header).paddingLeft),bodyInset:parseFloat(getComputedStyle(body).paddingLeft),scrollOwner:getComputedStyle(body).overflowY};})()`);
        assert.equal(geometry.horizontalOverflow,false,`${scenario.name}: long employee data remains contained`);
        assert.equal(geometry.avatarWidth,32,`${scenario.name}: avatar reserves a stable 32px square`);
        assert.equal(await evaluate("document.querySelectorAll('[data-employee-profile]').length"),1,`${scenario.name}: a single profile owns the form`);
        const contrast = await evaluate(peopleContrastExpression([".task-board-heading-copy h3", ".employee-item strong", ".employee-item small", ".directory-label", ".profile-header h2"]));
        assert.ok(contrast.length>=4,`${scenario.name}: computed title, identity and secondary colors were captured`);
        assert.ok(contrast.every((sample:any)=>sample.ratio>=4.5),`${scenario.name}: title and small auxiliary text meet AA against their actual solid backgrounds: ${JSON.stringify(contrast)}`);
        await screenshot(`qa-employees-${scenario.name}`);
        if(scenario.width===320) {
          await click('.wand-employee-list input[type="search"]');
          await send("Input.insertText",{text:"不会匹配的员工 fixture"});
          await wait("document.querySelector('.directory .no-results')?.textContent.includes('没有匹配的员工')");
          await screenshot("qa-employees-no-results");
          await key("Escape");
          await wait("document.querySelectorAll('.wand-employee-card').length===1");
          assert.equal(await evaluate("document.activeElement===document.querySelector('.wand-employee-list input[type=search]')"),true,"employee search Escape clears locally, retains focus and does not close its page");
          evidence.push({mode:"employee-search-no-results",clearViaEscape:true,focusRetained:true,pagePreserved:true});
        }
        await click(".wand-teams-page [data-stretch-value=teams]");
        await wait("document.querySelectorAll('.wand-teams-card-status').length===2");
        if(scenario.width<=760&&await evaluate("!!document.querySelector('.wand-teams-page[data-detail]')")) {
          await click('[aria-label="团队模板导航"] button');
          await wait("!document.querySelector('.wand-teams-page[data-detail]')");
        }
        const statusContrast = await evaluate(peopleContrastExpression([".wand-teams-card-status"]));
        assert.equal(statusContrast.length,2,`${scenario.name}: both status labels are visible, not a hidden-list contrast pass`);
        assert.ok(statusContrast.every((sample:any)=>sample.ratio>=4.5),`${scenario.name}: running/attention status text meets AA`);
        const headerActions=await evaluate("Array.from(document.querySelectorAll('.task-board-header-actions button')).filter(button=>button.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).map(button=>{const r=button.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {text:button.textContent,bounded:r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1,reachable:hit===button||button.contains(hit)}})");
        assert.ok(headerActions.length>=2&&headerActions.every((action:any)=>action.bounded&&action.reachable),`${scenario.name}: every header action is visible and hit-test reachable`);
        assert.equal(await evaluate("document.querySelectorAll('.wand-teams-card .wand-logo-glow').length"),0,`${scenario.name}: status is readable without decorative glow`);
        await screenshot(`qa-teams-${scenario.name}`);
        evidence.push({ mode:`layout-qa-${scenario.name}`,geometry,contrast,statusContrast,headerActions,zoomLimitation:scenario.scale===2?"1280x900 physical / 640x450 CSS reflow emulation; not native browser zoom or a physical touch-device test":undefined });
      }
      for (const count of [120,0]) {
        qaEmployeeCount=count;
        await send("Emulation.setDeviceMetricsOverride",{width:390,height:900,deviceScaleFactor:1,mobile:false});
        await send("Page.navigate",{url:`${origin}/?people-count=${count}`});
        await wait(count?"document.querySelectorAll('.employee-item').length===120":"!!document.querySelector('.directory .no-results')");
        if(await evaluate("document.querySelector('.wand-employee-workspace').dataset.collapsed==='true'"))await click('.directory-toggle');
        assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth+1"),true,`${count} employees: no horizontal overflow`);
        if(count) {
          const collection=await evaluate("(()=>{const body=document.querySelector('.employee-items'),page=document.querySelector('.wand-teams-page');return {scrollHeight:body.scrollHeight,clientHeight:body.clientHeight,overflowY:getComputedStyle(body).overflowY,pageHeight:page.getBoundingClientRect().height,pageDisplay:getComputedStyle(page).display,pageDirection:getComputedStyle(page).flexDirection,bodyFlex:getComputedStyle(body).flex,minHeight:getComputedStyle(body).minHeight};})()");
          evidence.push({mode:"large-collection",collection});
          assert.ok(collection.scrollHeight>collection.clientHeight&&collection.overflowY==='auto',`large employee collections retain one native content scroller: ${JSON.stringify(collection)}`);
        }
        await screenshot(`qa-employees-count-${count}`);
        evidence.push({ mode:`layout-qa-count-${count}`,horizontalOverflow:false,fixtureCount:count });
      }
    }
    evidence.push({ mode: "retired-css", selectorsChecked: RETIRED_SELECTORS.length, matches: 0 });
    assert.deepEqual(browserErrors, [], "no browser runtime exceptions");
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(artifact, employeesOnly ? "employees-browser.json" : "teams-browser.json"), JSON.stringify({
      passed: true, evidence, browserErrors,
      scope: `${employeesOnly ? "Employee list/editor/create disclosure only" : "Teams full lane gate"} in real Chrome against canned local API data; installed-service acceptance stays integration-owned`,
    }, null, 2));
  } catch (error) {
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(artifact, employeesOnly ? "employees-browser.json" : "teams-browser.json"), JSON.stringify({ passed: false, evidence, browserErrors, error: String(error) }, null, 2));
    throw error;
  } finally {
    socket?.close();
    if (chrome.exitCode === null) {
      const stopped = once(chrome, "exit");
      chrome.kill();
      await stopped;
    }
    server.close();
    rmSync(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
