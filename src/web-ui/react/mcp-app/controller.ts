import { useSyncExternalStore } from "react";

/**
 * MCP Apps 面板状态：同一时间只开一个面板（插件界面属于一次工具调用的上下文，
 * 多开只会抢焦点）。生命周期由面板自己持有，关闭时通知服务端回收探针进程。
 */
export interface McpAppPanelSnapshot {
  open: boolean;
  phase: "loading" | "ready" | "failed";
  sessionId: string | null;
  panelId: string | null;
  server: string;
  uri: string;
  toolName: string;
  /** 这次工具调用的入参与结果，握手后推给插件渲染。 */
  toolInput: unknown;
  toolResult: unknown;
  toolError: boolean;
  html: string;
  message: string;
  height: number;
}

const CLOSED: McpAppPanelSnapshot = {
  open: false, phase: "loading", sessionId: null, panelId: null, server: "", uri: "",
  toolName: "", toolInput: null, toolResult: null, toolError: false, html: "", message: "", height: 480,
};

export class McpAppPanelController {
  private snapshot: McpAppPanelSnapshot = CLOSED;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = (): McpAppPanelSnapshot => this.snapshot;

  update(patch: Partial<McpAppPanelSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  reset(): void {
    this.update({ ...CLOSED });
  }

  close(): void {
    if (!this.snapshot.open) return;
    this.update({ open: false });
  }
}

export const mcpAppPanelController = new McpAppPanelController();

export function useMcpAppPanel(): McpAppPanelSnapshot {
  return useSyncExternalStore(
    mcpAppPanelController.subscribe,
    mcpAppPanelController.getSnapshot,
    mcpAppPanelController.getSnapshot,
  );
}
