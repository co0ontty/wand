import { useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import { WandIcon, WandButton } from "../ui";
import { ComposerPopoverAction } from "./action";
import { composerPopoverController, type ComposerPopoverMount } from "./controller";

/**
 * popover 条目内容。容器（`#composer-plus-popover`）与开合、键盘导航、
 * 点外部关闭都留在 legacy：那些逻辑绑在容器节点上，React 只管这两个条目。
 */
export function ComposerPopoverItems({ mount }: { mount: ComposerPopoverMount }): React.ReactElement {
  const interactiveClass = `${mount.interactiveOn ? "is-on" : ""}${
    mount.interactiveVisible ? "" : " hidden"
  }`;

  return (
    <>
      <ComposerPopoverAction
        id="plus-attach-item"
        icon="paperclip"
        label="上传附件"
        onClick={(event) => mount.onAttach(event.detail === 0)}
      />
      <WandButton kind="ghost"
        className={interactiveClass}
        id="terminal-interactive-toggle-top"
        type="button"
        aria-pressed={mount.interactiveOn ? "true" : "false"}
        title="终端交互开启时，键盘直通原始终端；关闭后在对话中阅读解析后的输出"
        onClick={() => mount.onToggleInteractive()}
      >
        <WandIcon name="keyboard" size={14} strokeWidth={1.8} className="plus-popover-icon" />
        <span className="plus-popover-label">终端交互</span>
        <span className="plus-popover-toggle-state">{mount.interactiveOn ? "开" : "关"}</span>
      </WandButton>
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
