import * as React from "react";
import { taskBoardController, taskBoardStore } from "./task-board-controller";

/** Embeds the vendored upstream Codex Taskboard in the authenticated Wand content area. */
export function TaskBoardHost({ onOpenSession }: { onOpenSession?: (sessionId: string) => void } = {}): React.ReactElement | null {
  const controller = React.useSyncExternalStore(taskBoardStore.subscribe, taskBoardStore.getSnapshot, taskBoardStore.getSnapshot);
  const [frameState, setFrameState] = React.useState<"loading" | "ready" | "error">("loading");
  React.useEffect(() => {
    if (!controller.open) return;
    setFrameState("loading");
    const timer = window.setTimeout(() => setFrameState("error"), 10_000);
    return () => window.clearTimeout(timer);
  }, [controller.open, controller.revision]);
  React.useEffect(() => {
    if (!controller.open || !onOpenSession) return;
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!event.data || typeof event.data !== "object" || event.data.type !== "wand-taskboard-open-session") return;
      if (typeof event.data.sessionId === "string" && event.data.sessionId.trim()) onOpenSession(event.data.sessionId);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [controller.open, onOpenSession]);
  if (!controller.open) return null;
  const frameUrl = `/taskboard/?wandSessionId=${encodeURIComponent(controller.sessionId)}`;
  return <section className="task-board-page task-board-vendor-page" aria-label="任务面板">
    <div className="task-board-vendor-loading" data-state={frameState} role={frameState === "error" ? "alert" : "status"}>
      <strong>{frameState === "error" ? "任务面板加载失败" : "正在打开任务面板…"}</strong>
      <span>{frameState === "error" ? "请检查 Wand 服务后重试。" : "正在加载 Dashboard、看板、列表和甘特图。"}</span>
      {frameState === "error" && <button type="button" onClick={() => { setFrameState("loading"); const frame = document.querySelector<HTMLIFrameElement>(".task-board-vendor-frame"); if (frame) frame.src = frameUrl; }}>重新加载</button>}
    </div>
    <iframe
      className="task-board-vendor-frame"
      title="任务面板"
      src={frameUrl}
      onLoad={(event) => {
        window.setTimeout(() => {
          const frame = event.currentTarget;
          const root = frame.contentDocument?.querySelector("#root");
          setFrameState(root && root.childElementCount > 0 ? "ready" : "error");
        }, 1_500);
      }}
      onError={() => setFrameState("error")}
    />
  </section>;
}
