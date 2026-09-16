import { useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import { WandIcon } from "../ui";
import { composerPopoverController, type ComposerPopoverMount } from "./controller";

/**
 * popover 条目内容。容器（`#composer-plus-popover`）与开合、键盘导航、
 * 点外部关闭都留在 legacy：那些逻辑绑在容器节点上，React 只管这两个条目。
 */
export function ComposerPopoverItems({ mount }: { mount: ComposerPopoverMount }): React.ReactElement {
  const interactiveClass = `plus-popover-item${mount.interactiveOn ? " is-on" : ""}${
    mount.interactiveVisible ? "" : " hidden"
  }`;

  return (
    <>
      <button
        className="plus-popover-item"
        id="plus-attach-item"
        type="button"
        onClick={(event) => mount.onAttach(event.detail === 0)}
      >
        <WandIcon name="paperclip" size={14} strokeWidth={1.8} className="plus-popover-icon" />
        <span className="plus-popover-label">上传附件</span>
      </button>
      <button
        className={interactiveClass}
        id="terminal-interactive-toggle-top"
        type="button"
        aria-pressed={mount.interactiveOn ? "true" : "false"}
        onClick={() => mount.onToggleInteractive()}
      >
        <WandIcon name="keyboard" size={14} strokeWidth={1.8} className="plus-popover-icon" />
        <span className="plus-popover-label">终端交互</span>
        <span className="plus-popover-toggle-state">{mount.interactiveOn ? "开" : "关"}</span>
      </button>
    </>
  );
}

export function ComposerPopoverHost(): React.ReactElement[] {
  const snapshot = useSyncExternalStore(
    composerPopoverController.subscribe,
    composerPopoverController.getSnapshot,
    composerPopoverController.getSnapshot,
  );

  return snapshot.mounts.map((mount) => createPortal(
    <ComposerPopoverItems mount={mount} />,
    mount.target,
    mount.key,
  ));
}
