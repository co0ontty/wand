import { Button, Image } from "antd";
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
      width={{ xs: "calc(100vw - 16px)", md: 1080, xl: 1320 }}
      styles={{ body: { display: "flex", height: "min(70dvh, 760px)", minHeight: 0 } }}
      closeLabel="关闭图片预览"
      testId="image-viewer-dialog"
    >
      <Button
        type="text"
        className={classNames("wand-media-stage wand-image-viewer-stage", snapshot.zoomed && "zoomed")}
        aria-label={snapshot.zoomed ? "缩小图片" : "放大图片"}
        onClick={() => imageViewerController.toggleZoom()}
      >
        {snapshot.src ? <Image preview={false} src={snapshot.src} alt={snapshot.label} /> : null}
      </Button>
    </WandDialogSurface>
  );
}
