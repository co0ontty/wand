import { useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import {
  composerActionErrorController,
  type ComposerActionErrorMount,
} from "./controller";

/**
 * 错误条本体。保留 `#action-error` / `.error-message` 这对选择器：前者是
 * 既有约定，后者带 `shake` 入场动画与 danger 配色。没有错误时整个节点不存在。
 */
export function ComposerActionError({ mount }: { mount: ComposerActionErrorMount }): React.ReactElement {
  return (
    <p id="action-error" className="error-message">
      {mount.message}
    </p>
  );
}

export function ComposerActionErrorHost(): React.ReactElement[] {
  const snapshot = useSyncExternalStore(
    composerActionErrorController.subscribe,
    composerActionErrorController.getSnapshot,
    composerActionErrorController.getSnapshot,
  );

  return snapshot.mounts.map((mount) => createPortal(
    <ComposerActionError mount={mount} />,
    mount.target,
    mount.key,
  ));
}
