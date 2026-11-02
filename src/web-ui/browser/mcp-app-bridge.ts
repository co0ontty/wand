/**
 * MCP Apps 面板的宿主侧 JSON-RPC 桥。
 *
 * 插件界面运行在 `sandbox="allow-scripts"` 的 iframe 里（不透明源，拿不到 Wand 的
 * cookie / DOM）。它通过 postMessage 上的 JSON-RPC 与宿主通信：先 `ui/initialize`
 * 握手，再按需 `tools/call` 回到同一条 MCP 连接。这里只做协议翻译与能力边界，
 * 不自己实现 MCP 连接；未实现的能力明确回 -32601，不假装成功。
 */
export interface McpAppToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpAppBridgeHost {
  /** 发一条消息给插件 iframe。 */
  postToApp(message: Record<string, unknown>): void;
  /** 面板里的动作回到 MCP 连接（服务端负责），不经过模型。 */
  callTool(tool: string, args: unknown): Promise<McpAppToolResult>;
  /** 只允许 http(s)；返回是否真的打开了。 */
  openLink(url: string): boolean;
  /** 插件自报尺寸，宿主据此调整面板高度。 */
  resize(height: number): void;
  /** 用户可见的桥接失败原因（不写 console 冒充成功）。 */
  report(message: string): void;
}

const FALLBACK_PROTOCOL_VERSION = "2025-06-18";
const MAX_LINK_LENGTH = 2048;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** 把会话里的 tool_result 块翻译成 MCP CallToolResult，供插件渲染原始结果。 */
export function toolResultToCallToolResult(content: unknown, isError?: boolean): McpAppToolResult {
  if (typeof content === "string") {
    return { content: content ? [{ type: "text", text: content }] : [], ...(isError ? { isError: true } : {}) };
  }
  if (Array.isArray(content)) {
    return { content: content as unknown[], ...(isError ? { isError: true } : {}) };
  }
  return { content: [], ...(isError ? { isError: true } : {}) };
}

export class McpAppBridge {
  private ready = false;
  private disposed = false;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly host: McpAppBridgeHost) {}

  /** 处理一条来自插件 iframe 的消息；非 JSON-RPC 消息直接忽略。 */
  async handleMessage(data: unknown): Promise<void> {
    if (this.disposed) return;
    const message = asRecord(data);
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
    const method = message.method;
    const id = message.id;
    const params = asRecord(message.params) ?? {};
    const isRequest = id !== undefined && id !== null;

    if (method === "ui/initialize") {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : FALLBACK_PROTOCOL_VERSION;
      if (isRequest) {
        this.reply(id, {
          protocolVersion: requested,
          hostInfo: { name: "Wand", version: "1.0.0" },
          hostCapabilities: { tools: { call: true }, links: { open: true } },
          hostContext: { displayMode: "inline", theme: "light", locale: "zh-CN" },
        });
      }
      // 正常流程由插件回 `ui/notifications/initialized` 表示就绪；个别实现不回，
      // 这里留一个有界兜底，避免面板一直空白。
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = setTimeout(() => { this.ready = true; this.readyTimer = undefined; }, 1200);
      return;
    }

    if (method === "ui/notifications/initialized") {
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
      this.ready = true;
      return;
    }

    if (method === "ui/notifications/size-changed") {
      const height = typeof params.height === "number" ? params.height : Number(params.height);
      if (Number.isFinite(height) && height > 0) this.host.resize(Math.max(240, Math.min(720, Math.round(height))));
      return;
    }

    if (method === "tools/call") {
      if (!isRequest) return;
      const tool = typeof params.name === "string" ? params.name.trim() : "";
      if (!tool) { this.replyError(id, -32602, "缺少工具名"); return; }
      try {
        const result = await this.host.callTool(tool, params.arguments ?? {});
        this.reply(id, {
          content: result.content,
          ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
          ...(result.isError ? { isError: true } : {}),
        });
      } catch (error) {
        this.replyError(id, -32603, error instanceof Error ? error.message : "工具调用失败");
      }
      return;
    }

    if (method === "ui/open-link") {
      const url = typeof params.url === "string" ? params.url : "";
      const opened = url.length > 0 && url.length <= MAX_LINK_LENGTH && this.host.openLink(url);
      if (isRequest) {
        if (opened) this.reply(id, {});
        else this.replyError(id, -32602, "链接被拒绝：只允许 http(s) 地址");
      }
      return;
    }

    if (method === "ui/request-display-mode") {
      if (isRequest) this.reply(id, { mode: "inline" });
      return;
    }

    if (method === "ui/update-model-context" || method === "ui/message") {
      // Wand 不把插件内容写进模型上下文，也不代发用户消息：明确拒绝而不是假装成功。
      if (isRequest) this.replyError(id, -32601, "Wand 不支持把插件内容写入模型上下文");
      return;
    }

    // 其余通知（日志等）不响应；请求明确回不支持，避免插件一直等。
    if (isRequest) this.replyError(id, -32601, `Wand 不支持 ${method}`);
  }

  notifyToolInput(input: unknown): void {
    if (!this.ready) return;
    this.host.postToApp({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: input ?? {} } });
  }

  notifyToolResult(result: McpAppToolResult): void {
    if (!this.ready) return;
    this.host.postToApp({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result });
  }

  dispose(): void {
    this.disposed = true;
    this.ready = false;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
  }

  private reply(id: unknown, result: unknown): void {
    this.host.postToApp({ jsonrpc: "2.0", id, result });
  }

  private replyError(id: unknown, code: number, message: string): void {
    this.host.postToApp({ jsonrpc: "2.0", id, error: { code, message } });
  }
}
