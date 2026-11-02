import { Flex, Typography } from "antd";
import * as React from "react";

import { jsonBody, requestJson } from "../http-adapter";
import { WandButton, WandDialogSurface, WandIcon } from "../ui";
import { McpAppBridge, toolResultToCallToolResult, type McpAppToolResult } from "../../browser/mcp-app-bridge";
import { mcpAppPanelController, useMcpAppPanel } from "./controller";

interface CallResponse {
  state: "ready" | "failed";
  reason?: string;
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * 插件面板：把 MCP App 的 `ui://` 资源渲染在 sandbox iframe 里，并用 JSON-RPC 桥
 * 把它需要的工具调用转回服务端的同一条 MCP 连接。面板不写模型上下文、不代发消息。
 */
export function McpAppHost(): React.ReactElement | null {
  const panel = useMcpAppPanel();
  const frame = React.useRef<HTMLIFrameElement | null>(null);
  const bridge = React.useRef<McpAppBridge | null>(null);
  const [height, setHeight] = React.useState(480);
  const [error, setError] = React.useState("");

  const close = React.useCallback(() => {
    const current = mcpAppPanelController.getSnapshot();
    mcpAppPanelController.close();
    if (current.sessionId && current.panelId) {
      void requestJson(`/api/sessions/${encodeURIComponent(current.sessionId)}/mcp-app/${encodeURIComponent(current.panelId)}`, { method: "DELETE" })
        .catch(() => { /* 面板已关，回收失败不影响本地状态 */ });
    }
  }, []);

  // 桥接：只接受来自本 iframe 的消息，其他窗口一律忽略。
  React.useEffect(() => {
    if (!panel.open || panel.phase !== "ready") return;
    const node = frame.current;
    if (!node) return;
    const current = mcpAppPanelController.getSnapshot();
    const instance = new McpAppBridge({
      postToApp: (message) => node.contentWindow?.postMessage(message, "*"),
      callTool: async (tool, args): Promise<McpAppToolResult> => {
        if (!current.sessionId || !current.panelId) throw new Error("面板已关闭。");
        const response = await requestJson<CallResponse>(
          `/api/sessions/${encodeURIComponent(current.sessionId)}/mcp-app/${encodeURIComponent(current.panelId)}/call`,
          jsonBody({ tool, arguments: args }),
        );
        if (response.state !== "ready") throw new Error(response.reason || "插件工具调用失败。");
        return { content: response.content ?? [], structuredContent: response.structuredContent, isError: response.isError === true };
      },
      openLink: (url) => {
        let parsed: URL;
        try { parsed = new URL(url); } catch { return false; }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
        window.open(parsed.toString(), "_blank", "noopener,noreferrer");
        return true;
      },
      resize: (next) => setHeight(Math.max(240, Math.min(720, Math.round(next)))),
      report: (message) => setError(message),
    });
    bridge.current = instance;
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== node.contentWindow) return;
      void instance.handleMessage(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      instance.dispose();
      if (bridge.current === instance) bridge.current = null;
    };
  }, [panel.open, panel.phase, panel.panelId]);

  // 握手完成后把这次工具调用的入参与结果推给插件，界面才能渲染真实数据。
  React.useEffect(() => {
    if (!panel.open || panel.phase !== "ready") return;
    const timer = window.setTimeout(() => {
      const current = mcpAppPanelController.getSnapshot();
      const instance = bridge.current;
      if (!instance) return;
      instance.notifyToolInput(current.toolInput);
      instance.notifyToolResult(toolResultToCallToolResult(current.toolResult, current.toolError));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [panel.open, panel.phase, panel.panelId, panel.toolInput, panel.toolResult, panel.toolError]);

  React.useEffect(() => {
    if (panel.open) { setHeight(480); setError(""); }
  }, [panel.open, panel.panelId]);

  if (!panel.open) return null;

  return <WandDialogSurface
    open
    title="插件面板"
    description={panel.server ? `${panel.server} · ${panel.uri}` : panel.uri}
    width={760}
    className="wand-ui-dialog-content mcp-app-panel"
    onOpenChange={(open) => { if (!open) close(); }}
    onEscape={close}
  >
    {panel.phase === "loading" ? <Flex align="center" gap={8} className="mcp-app-panel-status" role="status">
      <WandIcon name="sparkle" size={16}/>
      <Typography.Text type="secondary">正在读取插件界面…</Typography.Text>
    </Flex> : null}
    {panel.phase === "failed" ? <Flex vertical gap={8} className="mcp-app-panel-status" role="alert">
      <Typography.Text type="danger">{panel.message || "插件面板不可用。"}</Typography.Text>
      <Typography.Text type="secondary">插件界面资源读取失败时不会伪造内容；工具结果仍可在对话里查看。</Typography.Text>
    </Flex> : null}
    {panel.phase === "ready" ? <>
      <iframe
        ref={frame}
        className="mcp-app-panel-frame"
        title="插件界面"
        // 不透明源 + 只允许脚本：插件拿不到 Wand 的 cookie、DOM 与存储。
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        srcDoc={panel.html}
        style={{ height: `${height}px` }}
      />
      {error ? <Typography.Text type="danger" className="mcp-app-panel-error" role="status">{error}</Typography.Text> : null}
      <Flex justify="space-between" align="center" className="mcp-app-panel-footer">
        <Typography.Text type="secondary">插件界面由 MCP 服务提供，运行在隔离沙箱中；不会把内容写进对话上下文。</Typography.Text>
        <WandButton size="small" onClick={close}>关闭面板</WandButton>
      </Flex>
    </> : null}
  </WandDialogSurface>;
}
