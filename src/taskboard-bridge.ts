import { mkdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RequestHandler } from "express";
import type { WandStorage } from "./storage.js";
import type { SessionRegistry } from "./session-registry.js";
import type { StructuredSessionManager } from "./structured-session-manager.js";
import type { SessionProvider, ThinkingEffort } from "./types.js";

interface TaskboardBridge {
  handler: RequestHandler;
  close(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") { probe.close(); reject(new Error("无法分配任务面板端口。")); return; }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function waitForReady(port: number, child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    let timer: NodeJS.Timeout;
    const check = () => {
      if (Date.now() > deadline) { reject(new Error("任务面板服务启动超时。")); return; }
      const request = httpRequest({ hostname: "127.0.0.1", port, path: "/health", method: "GET", timeout: 1_000 }, (response) => {
        response.resume();
        if ((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300) { clearTimeout(timer); resolve(); return; }
        timer = setTimeout(check, 100);
        timer.unref();
      });
      request.on("error", () => { timer = setTimeout(check, 100); timer.unref(); });
      request.end();
    };
    child.once("exit", (code) => { if (code !== null && code !== 0) reject(new Error(`任务面板服务退出（${code}）。`)); });
    check();
  });
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value);
}

export function taskboardIntegrationScript(): string {
  return `<script>
(() => {
  const query = new URLSearchParams(location.search);
  const currentSessionId = query.get("wandSessionId") || "";
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (currentSessionId) headers.set("X-Wand-Session-Id", currentSessionId);
    return originalFetch(input, { ...init, headers });
  };
  const providerLabel = (provider) => ({claude:"Claude",codex:"Codex",opencode:"OpenCode",grok:"Grok",qoder:"Qoder",pi:"Pi"}[provider] || provider || "Agent");
  const providers = ["claude", "codex", "opencode", "grok", "qoder", "pi"];
  let catalogPromise;
  const loadCatalog = () => catalogPromise || (catalogPromise = originalFetch("/api/models", {credentials:"same-origin"}).then((response) => response.ok ? response.json() : {}).catch(() => ({})));
  const modelsFor = async (provider) => {
    const catalog = await loadCatalog();
    const entries = Array.isArray(catalog[provider + "Models"]) ? catalog[provider + "Models"] : [];
    const fallback = catalog.defaultModels && catalog.defaultModels[provider] || catalog["default" + provider[0].toUpperCase() + provider.slice(1) + "Model"] || "";
    const options = entries.map((entry) => ({id: String(entry.id || ""), label: String(entry.label || entry.id || "")})).filter((entry) => entry.id);
    if (!options.some((entry) => entry.id === "default")) options.unshift({id:"default", label:fallback ? "跟随服务端默认（" + fallback + "）" : "跟随服务端默认"});
    return options;
  };
  const style = document.createElement("style");
  style.textContent = ".wand-session-links{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:10px;padding-top:8px;border-top:1px solid color-mix(in srgb, currentColor 12%, transparent);font-size:11px}.wand-session-links button{border:1px solid color-mix(in srgb, currentColor 18%, transparent);border-radius:5px;padding:3px 7px;background:color-mix(in srgb, currentColor 5%, transparent);color:inherit;cursor:pointer;font:inherit}.wand-session-links button:hover{background:color-mix(in srgb, currentColor 12%, transparent)}.wand-session-link{color:#3678c9}.wand-session-bind,.wand-agent-assign{color:#777}.wand-session-empty,.wand-session-loading{opacity:.55}.wand-agent-dialog{border:0;border-radius:14px;padding:0;color:#202124;background:#fff;box-shadow:0 20px 70px rgb(0 0 0 / 28%);width:min(430px,calc(100vw - 32px))}.wand-agent-dialog::backdrop{background:rgb(0 0 0 / 35%);backdrop-filter:blur(3px)}.wand-agent-dialog form{display:grid;gap:14px;padding:20px}.wand-agent-dialog h2{margin:0;font-size:18px}.wand-agent-dialog p{margin:-6px 0 0;color:#6b7280;font-size:12px}.wand-agent-field{display:grid;gap:6px}.wand-agent-field label{font-size:12px;font-weight:650;color:#4b5563}.wand-agent-field select{min-height:34px;border:1px solid #d1d5db;border-radius:7px;padding:0 9px;background:#fff;color:#111827}.wand-agent-actions{display:flex;justify-content:flex-end;gap:8px}.wand-agent-actions button{border:1px solid #d1d5db;border-radius:7px;padding:7px 12px;background:#fff;cursor:pointer}.wand-agent-actions button[type=submit]{border-color:#2563eb;background:#2563eb;color:#fff}.wand-agent-error{margin:0;color:#b91c1c;font-size:12px}.wand-agent-assignment{color:#2563eb;font-weight:650}";
  document.head.appendChild(style);
  const openAssignDialog = async (taskId, card) => {
    if (document.querySelector(".wand-agent-dialog")) return;
    const dialog = document.createElement("dialog");
    dialog.className = "wand-agent-dialog";
    dialog.innerHTML = '<form method="dialog"><h2>指派 Wand Agent</h2><p>选择执行 Agent、模型和思考深度；创建后会话会自动绑定到此任务。</p><div class="wand-agent-field"><label for="wand-agent-provider">Agent</label><select id="wand-agent-provider" name="provider">' + providers.map((provider) => '<option value="' + provider + '">' + providerLabel(provider) + '</option>').join("") + '</select></div><div class="wand-agent-field"><label for="wand-agent-model">模型</label><select id="wand-agent-model" name="model"><option>加载中…</option></select></div><div class="wand-agent-field"><label for="wand-agent-effort">思考深度</label><select id="wand-agent-effort" name="thinkingEffort"><option value="off">关闭</option><option value="standard">标准</option><option value="deep">深入</option><option value="max">最大</option></select></div><p class="wand-agent-error" hidden></p><div class="wand-agent-actions"><button type="button" data-cancel>取消</button><button type="submit">开始执行</button></div></form>';
    document.body.appendChild(dialog);
    const form = dialog.querySelector("form");
    const provider = dialog.querySelector("[name=provider]");
    const model = dialog.querySelector("[name=model]");
    const error = dialog.querySelector(".wand-agent-error");
    const submit = dialog.querySelector("button[type=submit]");
    const refreshModels = async () => {
      const selected = provider.value;
      model.innerHTML = '<option>加载中…</option>';
      for (const entry of await modelsFor(selected)) {
        const option = document.createElement("option"); option.value = entry.id; option.textContent = entry.label; model.appendChild(option);
      }
    };
    provider.addEventListener("change", () => void refreshModels());
    dialog.querySelector("[data-cancel]").addEventListener("click", () => dialog.close());
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.hidden = true; submit.disabled = true; submit.textContent = "正在启动…";
      try {
        const response = await originalFetch("/taskboard/api/wand/assign", {method:"POST", headers:{"Content-Type":"application/json", "X-Wand-Session-Id":currentSessionId}, body:JSON.stringify({taskId, provider:provider.value, model:model.value, thinkingEffort:form.querySelector("[name=thinkingEffort]").value})});
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "指派失败");
        dialog.close();
        dialog.remove();
        card.querySelector(".wand-session-links")?.remove();
        setup(card);
      } catch (caught) {
        error.textContent = caught instanceof Error ? caught.message : "指派失败";
        error.hidden = false; submit.disabled = false; submit.textContent = "开始执行";
      }
    });
    dialog.addEventListener("close", () => dialog.remove(), {once:true});
    dialog.showModal();
    await refreshModels();
  };
  const setup = (card) => {
    const taskId = card.getAttribute("data-task-id");
    if (!taskId) return;
    let links = card.querySelector(".wand-session-links");
    if (!links) {
      links = document.createElement("div"); links.className = "wand-session-links";
      links.innerHTML = '<span class="wand-session-loading">Wand 会话…</span>';
      card.appendChild(links);
    }
    if (!links.querySelector(".wand-agent-assign")) {
      const assign = document.createElement("button");
      assign.type = "button"; assign.className = "wand-agent-assign"; assign.textContent = "+ 指派 Agent";
      assign.onclick = (event) => { event.stopPropagation(); event.preventDefault(); void openAssignDialog(taskId, card); };
      links.appendChild(assign);
    }
    if (links.dataset.wandSessionsLoaded === taskId) return;
    links.dataset.wandSessionsLoaded = taskId;
    originalFetch("/taskboard/api/wand/sessions?taskId=" + encodeURIComponent(taskId), {headers: currentSessionId ? {"X-Wand-Session-Id": currentSessionId} : {}})
      .then((response) => response.ok ? response.json() : {sessions: []})
      .then((payload) => {
        const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
        [...links.children].filter((node) => !node.classList.contains("wand-agent-assign")).forEach((node) => node.remove());
        if (!sessions.length) {
          const empty = document.createElement("span"); empty.className = "wand-session-empty"; empty.textContent = currentSessionId ? "尚未绑定 Wand 会话" : "未绑定 Wand 会话"; links.prepend(empty);
          return;
        }
        sessions.forEach((session) => {
          const button = document.createElement("button"); button.type = "button"; button.className = "wand-session-link wand-agent-assignment";
          button.textContent = providerLabel(session.provider) + (session.model ? " · " + session.model : "") + " · " + ({off:"关闭",standard:"标准",deep:"深入",max:"最大"}[session.thinkingEffort] || session.thinkingEffort || "关闭");
          button.title = "打开 Wand 会话"; button.onclick = (event) => { event.stopPropagation(); window.parent.postMessage({type:"wand-taskboard-open-session", sessionId: session.id}, location.origin); };
          links.prepend(button);
        });
      }).catch(() => {
        [...links.children].filter((node) => !node.classList.contains("wand-agent-assign")).forEach((node) => node.remove());
        const unavailable = document.createElement("span"); unavailable.className = "wand-session-empty"; unavailable.textContent = "Wand 会话不可用"; links.prepend(unavailable);
      });
  };
  const scan = () => document.querySelectorAll("[data-task-id]").forEach(setup);
  new MutationObserver(scan).observe(document.documentElement, {childList:true, subtree:true});
  scan();
})();
</script>`;
}
const TASKBOARD_PROVIDERS = new Set<SessionProvider>(["claude", "codex", "opencode", "grok", "qoder", "pi"]);
const TASKBOARD_EFFORTS = new Set<NonNullable<ThinkingEffort>>(["off", "standard", "deep", "max"]);

function readJsonBody(request: { on: (event: string, listener: (...args: any[]) => void) => unknown }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("请求体不是有效 JSON。")); }
    });
    request.on("error", reject);
  });
}

function upstreamJson(port: number, requestPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: requestPath, method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if ((response.statusCode ?? 500) >= 400) reject(new Error(value?.error || "任务面板读取失败。"));
          else resolve(value);
        } catch { reject(new Error("任务面板返回了无效数据。")); }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function rewriteTaskboardHtml(body: Buffer): Buffer {
  const html = body.toString("utf8");
  const script = taskboardIntegrationScript();
  const marker = html.toLowerCase().lastIndexOf("</head>");
  return Buffer.from(marker >= 0 ? `${html.slice(0, marker)}${script}${html.slice(marker)}` : `${html}${script}`);
}

export async function startTaskboardBridge(
  configDir: string,
  storage?: WandStorage,
  sessions?: SessionRegistry,
  structured?: StructuredSessionManager,
  fallbackCwd?: string,
): Promise<TaskboardBridge> {
  const port = await freePort();
  const vendorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../vendor/codex-taskboard");
  const dataDir = path.join(configDir, "taskboard");
  await mkdir(dataDir, { recursive: true });
  const child = spawn(process.execPath, [path.join(vendorRoot, "server/index.mjs")], {
    cwd: vendorRoot,
    env: {
      ...process.env,
      CODEX_TASKBOARD_HOST: "127.0.0.1",
      CODEX_TASKBOARD_PORT: String(port),
      CODEX_TASKBOARD_DATA_DIR: dataDir,
    },
    stdio: "ignore",
  });
  await waitForReady(port, child);

  const handler: RequestHandler = async (req, res) => {
    const incoming = new URL(req.originalUrl, "http://127.0.0.1");
    const pathname = incoming.pathname.replace(/^\/taskboard/, "") || "/";
    const query = incoming.search;
    const taskId = typeof incoming.searchParams.get("taskId") === "string" ? incoming.searchParams.get("taskId") ?? "" : "";
    const sessionId = typeof req.headers["x-wand-session-id"] === "string" ? req.headers["x-wand-session-id"] : "";
    if (storage && sessions && structured && pathname === "/api/wand/assign" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("请求体必须是对象。");
        const input = body as Record<string, unknown>;
        const targetTaskId = validId(input.taskId) ? input.taskId : "";
        const provider = typeof input.provider === "string" ? input.provider.trim() as SessionProvider : "" as SessionProvider;
        const model = typeof input.model === "string" ? input.model.trim() : "";
        const thinkingEffort = typeof input.thinkingEffort === "string" ? input.thinkingEffort.trim() as NonNullable<ThinkingEffort> : "off";
        if (!targetTaskId || !TASKBOARD_PROVIDERS.has(provider)) throw new Error("请选择有效的 Agent。");
        if (model.length > 128) throw new Error("模型名称过长。");
        if (!TASKBOARD_EFFORTS.has(thinkingEffort)) throw new Error("思考深度无效。");
        const taskPayload = await upstreamJson(port, `/api/tasks/${encodeURIComponent(targetTaskId)}`);
        const task = taskPayload?.task;
        if (!task || task.source === "jira") throw new Error("只能指派本地任务。");
        const projectsPayload = await upstreamJson(port, "/api/projects");
        const project = Array.isArray(projectsPayload?.projects) ? projectsPayload.projects.find((item: any) => item?.id === task.projectId) : null;
        const current = sessionId ? sessions.get(sessionId) : null;
        const cwd = typeof task.developmentContext?.path === "string" && task.developmentContext.path.trim()
          ? task.developmentContext.path.trim()
          : typeof project?.workspacePath === "string" && project.workspacePath.trim()
            ? project.workspacePath.trim()
            : current?.cwd || fallbackCwd;
        if (!cwd) throw new Error("任务没有可用的工作目录，请先为 Taskboard 项目配置工作目录。");
        const prompt = [task.title, typeof task.description === "string" ? task.description.trim() : ""].filter(Boolean).join("\n\n");
        const session = structured.createSession({
          cwd,
          mode: "agent",
          provider,
          model: model && model !== "default" ? model : undefined,
          thinkingEffort,
          worktreeEnabled: false,
          sessionSource: "automation",
          automationId: `taskboard:${targetTaskId}`,
        });
        storage.bindTaskboardTaskSession(targetTaskId, session.id);
        const completion = structured.sendMessage(session.id, prompt || task.title || "执行此任务");
        completion.catch((error) => console.error(`[Taskboard] Agent dispatch failed for ${targetTaskId}:`, error));
        res.status(202).json({ ok: true, taskId: targetTaskId, session: { id: session.id, provider, model: session.selectedModel, thinkingEffort: session.thinkingEffort, cwd: session.cwd } });
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (storage && sessions && pathname === "/api/wand/sessions" && req.method === "GET") {
      const ids = storage.listTaskboardTaskSessions(taskId);
      const result = ids.flatMap((id) => {
        const session = sessions.getLatest(id);
        return session ? [{ id: session.id, provider: session.provider ?? "", sessionKind: session.sessionKind ?? "", title: session.title || session.description || session.command, status: session.status, cwd: session.cwd, model: session.selectedModel || session.structuredState?.model || "", thinkingEffort: session.thinkingEffort || "off" }] : [];
      });
      res.json({ sessions: result });
      return;
    }
    if (storage && sessions && pathname === "/api/wand/bindings" && req.method === "POST") {
      const body = req.body as { taskId?: unknown; sessionId?: unknown };
      const targetTaskId = validId(body?.taskId) ? body.taskId : "";
      const targetSessionId = validId(body?.sessionId) ? body.sessionId : sessionId;
      if (!targetTaskId || !targetSessionId || !sessions.get(targetSessionId)) { res.status(400).json({ error: "任务或会话无效。" }); return; }
      storage.bindTaskboardTaskSession(targetTaskId, targetSessionId);
      res.status(201).json({ ok: true, taskId: targetTaskId, sessionId: targetSessionId });
      return;
    }
    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    headers["x-forwarded-host"] = req.get("host") ?? undefined;
    const upstream = httpRequest({ hostname: "127.0.0.1", port, path: pathname + query, method: req.method, headers }, (response) => {
      res.status(response.statusCode ?? 502);
      const isHtml = String(response.headers["content-type"] ?? "").includes("text/html");
      const captureTaskMutation = storage && sessions && req.method !== "GET" && req.method !== "HEAD" && pathname.startsWith("/api/tasks");
      if (!isHtml && !captureTaskMutation) {
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined && name !== "transfer-encoding" && name !== "connection") res.setHeader(name, value);
        response.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        let body = Buffer.concat(chunks);
        if (isHtml) body = rewriteTaskboardHtml(body) as typeof body;
        if (captureTaskMutation) {
          try {
            const payload = JSON.parse(body.toString("utf8")) as { task?: { id?: unknown } };
            const createdTaskId = typeof payload.task?.id === "string" ? payload.task.id : "";
            if (sessionId && createdTaskId && sessions.get(sessionId)) storage.bindTaskboardTaskSession(createdTaskId, sessionId);
          } catch { /* preserve the upstream response */ }
        }
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined && name !== "transfer-encoding" && name !== "connection" && name !== "content-length") res.setHeader(name, value);
        res.setHeader("content-length", body.byteLength);
        res.end(body);
      });
    });
    upstream.once("error", () => { if (!res.headersSent) res.status(502).json({ error: "任务面板服务不可用。" }); else res.destroy(); });
    const contentType = String(req.headers["content-type"] ?? "");
    if (contentType.includes("application/json") && req.body !== undefined) {
      const payload = JSON.stringify(req.body);
      delete headers["content-length"];
      upstream.setHeader("content-length", Buffer.byteLength(payload));
      upstream.end(payload);
    } else {
      req.pipe(upstream);
    }
  };
  return {
    handler,
    close: async () => {
      if (!child.killed) child.kill("SIGTERM");
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 1_000); child.once("exit", () => { clearTimeout(timer); resolve(); }); });
    },
  };
}
