import { useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import { WandIcon } from "../ui/icons";
import { WandButton } from "../ui/button";
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
      {mount.predictionVisible ? <ComposerPopoverAction
        id="plus-predict-item"
        icon="sparkle"
        label={mount.predictionBusy ? "正在预测…" : "预测下一条"}
        title={mount.predictionBlocked
          ? "先清空当前草稿再预测；预测只填入空输入框，不会自动发送"
          : "让 Codex 根据本会话预测你的下一条输入（会调用模型）"}
        busy={mount.predictionBusy}
        disabled={mount.predictionBlocked}
        onClick={() => mount.onPredict()}
      /> : null}
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
