import { useSyncExternalStore } from "react";
import * as React from "react";

import { WandDialogSurface } from "../ui";
import { classNames } from "../ui/class-names";
import { imageViewerController } from "./controller";

export function ImageViewerHost() {
  const snapshot = useSyncExternalStore(
    imageViewerController.subscribe,
    imageViewerController.getSnapshot,
    imageViewerController.getSnapshot,
  );

  return (
    <WandDialogSurface
      open={snapshot.open}
      onOpenChange={(open) => { if (!open) imageViewerController.close(); }}
      title={snapshot.label}
      description={snapshot.zoomed ? "再次点击图片缩小" : "点击图片查看原始尺寸"}
      className="wand-ui-dialog-content wand-image-viewer-dialog"
      overlayClassName="wand-ui-dialog-overlay wand-image-viewer-overlay"
      titleClassName="wand-ui-dialog-title wand-image-viewer-title"
      descriptionClassName="wand-ui-dialog-description wand-image-viewer-hint"
      headerClassName="wand-ui-dialog-heading wand-image-viewer-header"
      closeLabel="关闭图片预览"
      testId="image-viewer-dialog"
    >
      <button
        type="button"
        className={classNames("wand-image-viewer-stage", snapshot.zoomed && "zoomed")}
        aria-label={snapshot.zoomed ? "缩小图片" : "放大图片"}
        onClick={() => imageViewerController.toggleZoom()}
      >
        {snapshot.src ? <img src={snapshot.src} alt={snapshot.label} /> : null}
      </button>
    </WandDialogSurface>
  );
}
