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
 *
 * `role="alert"`：这条只承载「刚做完的动作失败了」（发送 / 派发被打回），用户必须立刻知道，
 * 属于 assertive 而不是「顺带更新的状态」。节点按错误有无挂载/卸载，所以插入即播报；
 * 不给它 tabindex / focus，播报不改焦点。
 */
export function ComposerActionError({ mount }: { mount: ComposerActionErrorMount }): React.ReactElement {
  return (
    <p id="action-error" className="error-message" role="alert">
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
