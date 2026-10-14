// RUNTIME-LOADED BY PATH by pi-tmux-host.ts, inside the actual Pi CLI installation.
// Do not import a Wand SDK runtime: the native CLI owns its extensions and TUI.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { projectPiProtocolEvent } from "./pi-event-projection.js";

interface NativePaths { events: string; ready: string; }

export default function wandNativeEvents(pi: ExtensionAPI): void {
  const file = process.env.WAND_PI_NATIVE_PATHS;
  if (!file) throw new Error("Pi 原生事件桥缺少本轮路径。");
  const paths = JSON.parse(readFileSync(file, "utf8")) as NativePaths;
  let fileFailed = false;
  const append = (event: unknown): void => {
    if (fileFailed) return;
    try { appendFileSync(paths.events, JSON.stringify(projectPiProtocolEvent(event as Record<string, unknown>)) + "\n", { mode: 0o600 }); }
    catch (error) {
      fileFailed = true;
      // Pi normally reports extension-handler failures and continues. Losing
      // the protocol source must instead stop this CLI with a real signal, so
      // Wand cannot publish a partial stream as a successful completed round.
      process.stderr.write("Pi 原生事件文件写入失败；本轮送达结果未知，不自动重试。\n");
      process.kill(process.pid, "SIGTERM");
      throw error;
    }
  };
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") throw new Error("Pi 原生 tmux 会话必须使用 TUI 模式。");
    append({ type: "session", id: ctx.sessionManager.getSessionId() });
    writeFileSync(paths.ready, JSON.stringify({ mode: ctx.mode, hasUI: ctx.hasUI, pid: process.pid }) + "\n", { mode: 0o600 });
  });
  const capture = (event: ExtensionEvent): void => {
      if (event.type === "message_update") {
        const e = event.assistantMessageEvent;
        // The protocol consumes deltas/boundaries, not a repeated copy of the entire growing message.
        append({ type: event.type, assistantMessageEvent: {
          type: e.type, ...(e.type.endsWith("_delta") && "delta" in e ? { delta: e.delta } : {}),
          ...("content" in e ? { content: e.content } : {}),
        } });
      } else append(event);
  };
  pi.on("agent_start", capture);
  pi.on("turn_start", capture);
  pi.on("message_start", capture);
  pi.on("message_update", capture);
  pi.on("message_end", capture);
  pi.on("turn_end", capture);
  pi.on("tool_execution_start", capture);
  pi.on("tool_execution_update", capture);
  pi.on("tool_execution_end", capture);
  pi.on("agent_end", capture);
  pi.on("agent_settled", (event, ctx) => {
    append(event);
    // Match the existing per-submit CLI lifetime. This boundary is later than
    // agent_end: queued/background work, retry and compaction have drained.
    // A graceful TUI shutdown leaves Pi's native transcript in the tmux pane.
    ctx.shutdown();
  });
  pi.on("session_shutdown", () => append({ type: "session_shutdown" }));
}
