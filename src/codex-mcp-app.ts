import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { whichSync } from "./path-repair.js";

/**
 * MCP Apps 面板会话。
 *
 * 插件界面是一份 `ui://` HTML 资源，面板里的按钮要回到同一条 MCP 连接上调工具。
 * 因此面板按需开一个探针进程（不跑模型），宿主只做转发与边界控制：
 *   · HTML 大小、面板数量、空闲时长都有上限；
 *   · 工具调用只允许面板自己声明的 server，参数原样透传，不扩大审批策略；
 *   · 关闭面板 / 会话结束 / 空闲超时都会回收进程。
 */
export type McpAppOpenOutcome =
  | { state: "ready"; panelId: string; html: string; mimeType: string; uri: string }
  | { state: "unsupported"; reason: string }
  | { state: "failed"; reason: string };

export type McpAppCallOutcome =
  | { state: "ready"; content: unknown[]; structuredContent?: unknown; isError: boolean }
  | { state: "failed"; reason: string };

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_PANELS_PER_SESSION = 3;
const PANEL_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const OPEN_TIMEOUT_MS = 40_000;
const CALL_TIMEOUT_MS = 30_000;

interface Panel {
  id: string;
  sessionId: string;
  threadId: string;
  server: string;
  uri: string;
  child: ChildProcessWithoutNullStreams;
  callbacks: Map<string, { resolve(value: McpAppCallOutcome): void; timer: ReturnType<typeof setTimeout> }>;
  openResolve?: (outcome: McpAppOpenOutcome) => void;
  closed: boolean;
}

function probeArgs(): string[] {
  const js = fileURLToPath(new URL("./codex-mcp-app-probe.js", import.meta.url));
  return existsSync(js) ? [js] : ["--import", import.meta.resolve("tsx"), js.replace(/\.js$/, ".ts")];
}

export class CodexMcpAppPanels {
  private readonly panels = new Map<string, Panel>();
  private readonly bySession = new Map<string, Set<string>>();

  async open(options: {
    sessionId: string;
    threadId: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    server: string;
    uri: string;
    originCallId?: string;
  }): Promise<McpAppOpenOutcome> {
    const existing = this.bySession.get(options.sessionId);
    if (existing && existing.size >= MAX_PANELS_PER_SESSION) {
      this.closeOldest(options.sessionId);
    }
    const file = whichSync("codex", { env: options.env }) ?? "codex";
    const id = randomUUID();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(process.execPath, probeArgs(), {
        cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      return { state: "failed", reason: (error as Error).message };
    }
    const panel: Panel = {
      id, sessionId: options.sessionId, threadId: options.threadId, server: options.server,
      uri: options.uri, child, callbacks: new Map(), closed: false,
    };
    this.panels.set(id, panel);
    const set = this.bySession.get(options.sessionId) ?? new Set<string>();
    set.add(id);
    this.bySession.set(options.sessionId, set);

    const opened = new Promise<McpAppOpenOutcome>((resolve) => {
      const timer = setTimeout(() => resolve({ state: "failed", reason: "插件面板读取超时。" }), OPEN_TIMEOUT_MS);
      panel.openResolve = (outcome) => { clearTimeout(timer); resolve(outcome); };
    });

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_HTML_BYTES * 2 + 65536) { buffer = ""; this.close(id); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let event: Record<string, any>;
        try { event = JSON.parse(line); } catch { continue; }
        this.handleEvent(panel, event);
      }
    });
    child.stderr.on("data", () => {});
    child.once("error", (error) => {
      panel.openResolve?.({ state: "failed", reason: error.message });
      panel.openResolve = undefined;
      this.close(id);
    });
    child.once("close", () => {
      panel.openResolve?.({ state: "failed", reason: "插件面板进程已退出。" });
      panel.openResolve = undefined;
      for (const [callId, callback] of panel.callbacks) {
        clearTimeout(callback.timer);
        callback.resolve({ state: "failed", reason: "插件面板已关闭。" });
        panel.callbacks.delete(callId);
      }
      this.forget(panel);
    });
    child.stdin.write(JSON.stringify({
      file, threadId: options.threadId, cwd: options.cwd, server: options.server,
      uri: options.uri, originCallId: options.originCallId, idleTimeoutMs: PANEL_IDLE_TIMEOUT_MS,
    }) + "\n");

    const outcome = await opened;
    panel.openResolve = undefined;
    if (outcome.state !== "ready") this.close(id);
    return outcome;
  }

  call(panelId: string, tool: string, args: unknown): Promise<McpAppCallOutcome> {
    const panel = this.panels.get(panelId);
    if (!panel || panel.closed) return Promise.resolve({ state: "failed", reason: "插件面板已关闭。" });
    const callId = randomUUID();
    return new Promise<McpAppCallOutcome>((resolve) => {
      const timer = setTimeout(() => {
        panel.callbacks.delete(callId);
        resolve({ state: "failed", reason: "插件工具调用超时。" });
      }, CALL_TIMEOUT_MS);
      panel.callbacks.set(callId, { resolve, timer });
      panel.child.stdin.write(JSON.stringify({ id: callId, method: "tool/call", tool, arguments: args ?? {} }) + "\n");
    });
  }

  close(panelId: string): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;
    panel.closed = true;
    try { panel.child.stdin.write(JSON.stringify({ method: "close" }) + "\n"); } catch { /* already gone */ }
    try { panel.child.kill("SIGTERM"); } catch { /* already gone */ }
    const force = setTimeout(() => { try { panel.child.kill("SIGKILL"); } catch { /* gone */ } }, 3000);
    force.unref();
    this.forget(panel);
  }

  closeSession(sessionId: string): void {
    for (const id of [...(this.bySession.get(sessionId) ?? [])]) this.close(id);
  }

  dispose(): void {
    for (const id of [...this.panels.keys()]) this.close(id);
  }

  private closeOldest(sessionId: string): void {
    const ids = [...(this.bySession.get(sessionId) ?? [])];
    if (ids.length) this.close(ids[0]);
  }

  private forget(panel: Panel): void {
    this.panels.delete(panel.id);
    const set = this.bySession.get(panel.sessionId);
    if (!set) return;
    set.delete(panel.id);
    if (set.size === 0) this.bySession.delete(panel.sessionId);
  }

  private handleEvent(panel: Panel, event: Record<string, any>): void {
    if (event.type === "resource") {
      const html = typeof event.html === "string" ? event.html : "";
      if (!html || Buffer.byteLength(html) > MAX_HTML_BYTES) {
        panel.openResolve?.({ state: "unsupported", reason: "插件界面资源为空或超出大小上限。" });
        panel.openResolve = undefined;
        return;
      }
      panel.openResolve?.({
        state: "ready", panelId: panel.id, html,
        mimeType: typeof event.mimeType === "string" ? event.mimeType : "text/html",
        uri: typeof event.uri === "string" ? event.uri : panel.uri,
      });
      panel.openResolve = undefined;
      return;
    }
    if (event.type === "unsupported" || event.type === "error") {
      panel.openResolve?.({
        state: event.type === "unsupported" ? "unsupported" : "failed",
        reason: typeof event.message === "string" ? event.message : "插件面板不可用。",
      });
      panel.openResolve = undefined;
      return;
    }
    if (typeof event.id === "string") {
      const callback = panel.callbacks.get(event.id);
      if (!callback) return;
      panel.callbacks.delete(event.id);
      clearTimeout(callback.timer);
      if (event.error) callback.resolve({ state: "failed", reason: String(event.error) });
      else callback.resolve({
        state: "ready",
        content: Array.isArray(event.result?.content) ? event.result.content : [],
        ...(event.result?.structuredContent !== undefined ? { structuredContent: event.result.structuredContent } : {}),
        isError: event.result?.isError === true,
      });
      return;
    }
    if (event.type === "closed") this.forget(panel);
  }
}
