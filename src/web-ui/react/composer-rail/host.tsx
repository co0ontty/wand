import { useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import { composerRailController } from "./controller";
import { WandButton, WandIcon } from "../ui";

const DEFAULT_HINT = "发送回车到终端（相当于 Enter）";

/** Native submit geometry shared with creation measurement; the host owns dispatch. */
export function ComposerRailSubmitChrome({ disabled, hint, onSubmit }: {
  disabled?: boolean;
  hint?: string;
  onSubmit?: () => void;
}): React.ReactElement {
  return <WandButton
    className="wand-composer-rail-submit"
    kind="soft"
    size="small"
    disabled={disabled}
    title={hint ?? DEFAULT_HINT}
    aria-label={hint ?? DEFAULT_HINT}
    onClick={onSubmit}
  >
    <WandIcon name="enter" slot="start" size={14}/>
    <span>发送</span>
  </WandButton>;
}

export function ComposerRailHost() {
  const snapshot = useSyncExternalStore(
    composerRailController.subscribe,
    composerRailController.getSnapshot,
    composerRailController.getSnapshot,
  );

  return snapshot.mounts.map((mount) => createPortal(
    <ComposerRailSubmitChrome disabled={mount.disabled} hint={mount.hint} onSubmit={mount.onSubmit}/>,
    mount.target,
    mount.key,
  ));
}
