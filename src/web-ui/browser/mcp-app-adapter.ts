import { mcpAppPanelController } from "../react/mcp-app/controller";

/**
 * 插件面板入口（legacy 聊天渲染 → React 面板）。
 *
 * 工具卡只带一个 tool_use id；入参/结果在渲染时登记到这张有界表里，避免把整段
 * 工具结果塞进 DOM 属性。面板打开后由 React 宿主负责 iframe、桥接与关闭。
 */
export interface McpAppToolEntry {
  sessionId: string;
  server: string;
  uri: string;
  toolName: string;
  toolInput: unknown;
  toolResult: unknown;
  toolError: boolean;
}

const MAX_ENTRIES = 40;
const entries = new Map<string, McpAppToolEntry>();
let openToken = 0;

export function registerMcpAppTool(toolUseId: string, entry: McpAppToolEntry): void {
  if (!toolUseId || !entry.server || !entry.uri) return;
  entries.delete(toolUseId);
  entries.set(toolUseId, entry);
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export function mcpAppToolEntry(toolUseId: string): McpAppToolEntry | undefined {
  return entries.get(toolUseId);
}

/** 打开插件面板：先占位显示「读取中」，资源到手后再换成 iframe。 */
export function openMcpAppPanel(toolUseId: string): void {
  const entry = entries.get(toolUseId);
  if (!entry) return;
  const token = ++openToken;
  mcpAppPanelController.update({
    open: true, phase: "loading", sessionId: entry.sessionId, panelId: null,
    server: entry.server, uri: entry.uri, toolName: entry.toolName,
    toolInput: entry.toolInput, toolResult: entry.toolResult, toolError: entry.toolError,
    html: "", message: "",
  });
  void (async () => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(entry.sessionId)}/mcp-app`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server: entry.server, uri: entry.uri }),
      });
      const body = await response.json().catch(() => ({}));
      if (token !== openToken) return;
      if (!response.ok) {
        mcpAppPanelController.update({ phase: "failed", message: String(body?.error || `请求失败（${response.status}）`) });
        return;
      }
      if (body?.state === "ready" && typeof body.html === "string") {
        mcpAppPanelController.update({ phase: "ready", panelId: String(body.panelId || ""), html: body.html, message: "" });
        return;
      }
      mcpAppPanelController.update({
        phase: "failed",
        message: String(body?.reason || "插件界面不可用。"),
      });
    } catch (error) {
      if (token !== openToken) return;
      mcpAppPanelController.update({
        phase: "failed",
        message: error instanceof Error ? error.message : "插件界面读取失败。",
      });
    }
  })();
}
