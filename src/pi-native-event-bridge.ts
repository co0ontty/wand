// RUNTIME-LOADED BY PATH by pi-tmux-host.ts, inside the actual Pi CLI installation.
// Do not import a Wand SDK runtime: the native CLI owns its extensions and TUI.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { projectPiProtocolEvent } from "./pi-event-projection.js";
import { claimNativeInput, nativeInputFile, openNativeInputBoundary, writeNativeInput, type PiInputOffer } from "./pi-native-input.js";

interface NativePaths { events: string; ready: string; input?: string; initialMessageId?: string; }

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
    if (paths.input) append({ type: "wand_input_ready", id: paths.initialMessageId });
    writeFileSync(paths.ready, JSON.stringify({ mode: ctx.mode, hasUI: ctx.hasUI, pid: process.pid,
      sessionFile: ctx.sessionManager.getSessionFile() }) + "\n", { mode: 0o600 });
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
  let pending: PiInputOffer | null = null;
  const confirmInput = (ctx: ExtensionContext): void => {
    if (!pending || !paths.input) return;
    const offer = pending;
    const found = ctx.sessionManager.getBranch().some((entry) => entry.type === "custom_message"
      && entry.customType === "wand-user-input"
      && (entry.details as { inputId?: string } | undefined)?.inputId === offer.id);
    if (!found) return;
    writeNativeInput(nativeInputFile(paths.input, offer.boundaryId, "committed"), offer);
    append({ type: "wand_input_committed", id: offer.boundaryId, message: offer });
    pending = null;
  };
  pi.on("turn_end", async (event, ctx) => {
    if (!paths.input || !Array.isArray(event.entries) || !event.context
      || event.outcome === "error" || event.outcome === "aborted" || ctx.signal?.aborted
      || (event.message as { stopReason?: string }).stopReason === "error"
      || (event.message as { stopReason?: string }).stopReason === "aborted") return;
    confirmInput(ctx);
    // A prior unconfirmed handoff must never be followed by another injection.
    if (pending || ctx.hasPendingMessages()) return;
    const boundaryId = openNativeInputBoundary(paths.input);
    append({ type: "wand_input_boundary", id: boundaryId });
    try {
      const deadline = Date.now() + 2000;
      while (!ctx.signal?.aborted && Date.now() < deadline) {
        const offer = claimNativeInput(paths.input, boundaryId);
        if (offer !== undefined) {
          if (!offer) return;
          pending = offer;
          // Official awaited boundary entries commit to the native session before
          // continuing. Unlike sendUserMessage(), no discarded async enqueue runs.
          return { entries: [...event.entries, { type: "custom_message" as const,
            customType: "wand-user-input", content: offer.text, display: true,
            details: { inputId: offer.id, boundaryId } }], continue: true };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      writeNativeInput(nativeInputFile(paths.input, boundaryId, "closed"), { id: boundaryId });
    }
  });
  pi.on("agent_start", capture);
  pi.on("turn_start", (event, ctx) => { confirmInput(ctx); capture(event); });
  pi.on("message_start", capture);
  pi.on("message_update", capture);
  pi.on("message_end", capture);
  pi.on("turn_end", capture);
  pi.on("tool_execution_start", capture);
  pi.on("tool_execution_update", capture);
  pi.on("tool_execution_end", capture);
  pi.on("agent_end", (event, ctx) => { confirmInput(ctx); capture(event); });
  pi.on("agent_settled", (event, ctx) => {
    confirmInput(ctx);
    append(event);
    // Match the existing per-submit CLI lifetime. This boundary is later than
    // agent_end: queued/background work, retry and compaction have drained.
    // A graceful TUI shutdown leaves Pi's native transcript in the tmux pane.
    ctx.shutdown();
  });
  pi.on("session_shutdown", () => append({ type: "session_shutdown" }));
}
