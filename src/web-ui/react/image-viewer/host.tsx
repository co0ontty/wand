import { Flex, Image } from "antd";
import { useEffect, useRef, useSyncExternalStore } from "react";
import * as React from "react";

import { usePortalContainer, WandIcon } from "../ui";
import { usePopupDismiss } from "../ui/popup-lifecycle";
import { imageViewerController } from "./controller";

export function ImageViewerHost() {
  const snapshot = useSyncExternalStore(
    imageViewerController.subscribe,
    imageViewerController.getSnapshot,
    imageViewerController.getSnapshot,
  );

  const portal = usePortalContainer();
  const swipe = useRef<{ id: number; x: number; y: number; endX: number; endY: number } | null>(null);
  const activate = useRef<(offset: number) => void>(() => {});
  usePopupDismiss(snapshot.open, () => imageViewerController.close());

  useEffect(() => {
    if (!snapshot.open || !portal) return;
    // Ant's preview renders its navigation and zoom buttons without a locale
    // prop for their accessible names. Scope this adapter to our own viewer.
    const labels = {
      "switch-prev": "上一张图片", "switch-next": "下一张图片",
      "actions-action-zoomIn": "放大图片", "actions-action-zoomOut": "缩小图片",
    };
    const labelButtons = () => {
      for (const [suffix, label] of Object.entries(labels)) {
        const button = portal.querySelector<HTMLButtonElement>(`.wand-image-viewer .ant-image-preview-${suffix}`);
        button?.setAttribute("aria-label", label);
        button?.setAttribute("title", label);
      }
    };
    labelButtons();
    const observer = new MutationObserver(labelButtons);
    observer.observe(portal, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [snapshot.open, portal]);

  return <Image.PreviewGroup
    items={snapshot.items.map(item => ({ src: item.src, alt: item.label }))}
    classNames={{ popup: { root: "wand-image-viewer" } }}
    styles={{ popup: { root: { pointerEvents: "auto" }, mask: { background: "var(--bg-terminal)" },
      footer: { maxWidth: "calc(100vw - 24px)", bottom: "max(24px, env(safe-area-inset-bottom))" } } }}
    preview={{
      open: snapshot.open,
      current: snapshot.current,
      alt: snapshot.label,
      getContainer: portal,
      onOpenChange: open => { if (!open) imageViewerController.close(); },
      afterOpenChange: open => { if (!open) imageViewerController.afterClosed(); },
      onChange: current => { swipe.current = null; imageViewerController.select(current); },
      closeIcon: <><WandIcon name="close"/><span className="sr-only">关闭图片预览</span></>,
      icons: {
        prev: <><WandIcon name="chevronLeft"/><span className="sr-only">上一张</span></>,
        next: <><WandIcon name="chevron"/><span className="sr-only">下一张</span></>,
      },
      countRender: (current, total) => <span role="status" aria-live="polite" className="wand-image-viewer-caption">
        {snapshot.label} · {current} / {total}
      </span>,
      actionsRender: (_, { actions, icons }) => {
        activate.current = actions.onActive;
        return <Flex gap="small">{icons.zoomOutIcon}{icons.zoomInIcon}</Flex>;
      },
      imageRender: (image, { transform }) => <div data-testid="image-viewer-dialog" style={{ display: "contents" }}
        onTouchStartCapture={event => {
          const point = event.touches[0];
          swipe.current = event.touches.length === 1 && transform.scale === 1 && snapshot.items.length > 1
            ? { id: point.identifier, x: point.clientX, y: point.clientY, endX: point.clientX, endY: point.clientY } : null;
        }}
        onTouchMove={event => {
          const gesture = swipe.current;
          if (!gesture) return;
          const point = event.touches[0];
          if (event.touches.length !== 1 || point.identifier !== gesture.id || transform.scale !== 1) {
            swipe.current = null; return;
          }
          gesture.endX = point.clientX; gesture.endY = point.clientY;
        }}
        onTouchEnd={event => {
          const gesture = swipe.current; swipe.current = null;
          if (!gesture || event.touches.length || transform.scale !== 1) return;
          const point = Array.from(event.changedTouches).find(touch => touch.identifier === gesture.id);
          const dx = (point?.clientX ?? gesture.endX) - gesture.x;
          const dy = (point?.clientY ?? gesture.endY) - gesture.y;
          if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) activate.current(dx < 0 ? 1 : -1);
        }}
        onTouchCancel={() => { swipe.current = null; }}
      >{image}</div>,
    }}
  />;
}
