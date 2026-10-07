import { Flex, Progress, Spin, Typography } from "antd";
import {
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import * as React from "react";
import { WandButton, WandDialogSurface } from "../ui";
import { wandTheme } from "../theme";
import { restartOverlayController } from "./controller";
import { restartOverlayPresentation } from "./model";
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
  const content = useRef<HTMLDivElement | null>(null);
  const liveStatus = useRef<HTMLDivElement | null>(null);

  // A late ordinary modal may autofocus after this non-dismissible takeover.
  // Keep its request alive, but retain keyboard ownership until restarting ends.
  useEffect(() => {
    if (!snapshot.open) return;
    const owner = content.current?.ownerDocument ?? document;
    const retainFocus = (event: FocusEvent): void => {
      if (!content.current) return;
      // Ant locks focus to the most recently mounted modal. A later lower layer
      // must not pull this synchronous return-focus back into its own trap.
      event.stopPropagation();
      if (!content.current.contains(event.target as Node)) {
        (manualRefreshButton.current ?? liveStatus.current)?.focus({ preventScroll: true });
      }
    };
    const retainEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || !content.current) return;
      // Portal escape ownership also follows mount order rather than z-index.
      event.preventDefault();
      event.stopPropagation();
    };
    owner.addEventListener("focusin", retainFocus, true);
    owner.addEventListener("keydown", retainEscape, true);
    return () => {
      owner.removeEventListener("focusin", retainFocus, true);
      owner.removeEventListener("keydown", retainEscape, true);
    };
  }, [snapshot.open]);

  useEffect(() => {
    if (snapshot.phase !== "timed-out") return;
    manualRefreshButton.current?.focus();
  }, [snapshot.phase]);

  const busy = snapshot.phase === "waiting" || snapshot.phase === "checking";
  // Ant Progress is percent-based; the exact attempt counts stay in the text below.
  const progressPercent = snapshot.maxAttempts > 0
    ? Math.min(100, Math.round((Math.min(snapshot.attempts, snapshot.maxAttempts) / snapshot.maxAttempts) * 100))
    : 0;

  return (
    <>
      <WandDialogSurface
        open={snapshot.open}
        onOpenChange={() => {}}
        title={presentation.title}
        description={presentation.description}
        className="wand-restart-surface"
        width={{ xs: "calc(100vw - 32px)", sm: 520 }}
        // Ant ordinary portals may reach base + 1000; restarting takes over them.
        zIndex={(wandTheme.token?.zIndexPopupBase ?? 1000) + 2000}
        styles={{ wrapper: { padding: "max(16px, var(--wand-safe-top)) max(16px, var(--wand-safe-right)) max(16px, var(--wand-safe-bottom)) max(16px, var(--wand-safe-left))" } }}
        testId="restart-overlay"
        showClose={false}
        dismissable={false}
      >
        <Flex ref={content} vertical align="center" gap="middle" className="wand-restart-body" aria-busy={busy} style={{ paddingBlock: 24 }}>
          {snapshot.phase !== "timed-out" ? (
            <Spin size="large" aria-hidden="true" />
          ) : null}
          <Typography.Paragraph
            ref={liveStatus}
            className="wand-restart-live"
            role={snapshot.phase === "timed-out" ? "alert" : "status"}
            aria-live={snapshot.phase === "timed-out" ? "assertive" : "polite"}
            data-wand-autofocus={snapshot.phase === "timed-out" ? undefined : "true"}
            tabIndex={-1}
          >
            {presentation.liveStatus}
          </Typography.Paragraph>
          {snapshot.phase !== "timed-out" ? (
            <>
              <Progress
                className="wand-restart-progress"
                percent={progressPercent}
                showInfo={false}
                size="small"
                status="active"
                aria-label="等待服务重启进度"
              />
              <Typography.Text type="secondary" className="wand-restart-attempts">
                已检查 {snapshot.attempts} / {snapshot.maxAttempts} 次
              </Typography.Text>
            </>
          ) : (
            <WandButton
              ref={manualRefreshButton}
              className="wand-restart-manual"
              data-wand-autofocus="true"
              kind="primary"
              onClick={() => controller.manualRefresh()}
            >
              手动刷新
            </WandButton>
          )}
        </Flex>
      </WandDialogSurface>
    </>
  );
}
