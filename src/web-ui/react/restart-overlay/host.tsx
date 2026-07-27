import {
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { WandButton, WandDialogSurface } from "../ui";
import { restartOverlayController } from "./controller";
import { restartOverlayPresentation } from "./model";
import { restartOverlayStyles } from "./styles";
import type { RestartOverlayController } from "./types";

export interface RestartOverlayHostProps {
  controller?: RestartOverlayController;
}

export function RestartOverlayHost({
  controller = restartOverlayController,
}: RestartOverlayHostProps) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const presentation = restartOverlayPresentation(snapshot);
  const manualRefreshButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (snapshot.phase !== "timed-out") return;
    manualRefreshButton.current?.focus();
  }, [snapshot.phase]);

  const busy = snapshot.phase === "waiting" || snapshot.phase === "checking";
  const progressValue = Math.min(snapshot.attempts, snapshot.maxAttempts);

  return (
    <>
      <style data-wand-restart-overlay-styles>{restartOverlayStyles}</style>
      <WandDialogSurface
        open={snapshot.open}
        onOpenChange={() => {}}
        title={presentation.title}
        description={presentation.description}
        className="wand-restart-surface"
        overlayClassName="wand-restart-backdrop"
        headerClassName="wand-restart-header"
        titleClassName="wand-restart-title"
        descriptionClassName="wand-restart-description"
        closeLabel="服务重启期间无法关闭"
        testId="restart-overlay"
        dismissable={false}
      >
        <div className="wand-restart-body" aria-busy={busy}>
          {snapshot.phase !== "timed-out" ? (
            <div className="wand-restart-spinner" aria-hidden="true" />
          ) : null}
          <p
            className="wand-restart-live"
            role={snapshot.phase === "timed-out" ? "alert" : "status"}
            aria-live={snapshot.phase === "timed-out" ? "assertive" : "polite"}
            data-wand-autofocus="true"
            tabIndex={-1}
          >
            {presentation.liveStatus}
          </p>
          {snapshot.phase !== "timed-out" ? (
            <>
              <progress
                className="wand-restart-progress"
                max={snapshot.maxAttempts}
                value={progressValue}
                aria-label="等待服务重启进度"
              />
              <span className="wand-restart-attempts">
                已检查 {snapshot.attempts} / {snapshot.maxAttempts} 次
              </span>
            </>
          ) : (
            <WandButton
              ref={manualRefreshButton}
              className="wand-restart-manual"
              kind="primary"
              onClick={() => controller.manualRefresh()}
            >
              手动刷新
            </WandButton>
          )}
        </div>
      </WandDialogSurface>
    </>
  );
}
