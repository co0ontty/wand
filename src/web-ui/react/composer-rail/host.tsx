import { useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import { composerRailController } from "./controller";
import { WandButton, WandIcon } from "../ui";

const DEFAULT_HINT = "发送回车到终端（相当于 Enter）";

export function ComposerRailHost() {
  const snapshot = useSyncExternalStore(
    composerRailController.subscribe,
    composerRailController.getSnapshot,
    composerRailController.getSnapshot,
  );

  return snapshot.mounts.map((mount) => createPortal(
    <WandButton
      className="wand-composer-rail-submit"
      kind="soft"
      size="small"
      disabled={mount.disabled}
      title={mount.hint ?? DEFAULT_HINT}
      aria-label={mount.hint ?? DEFAULT_HINT}
      onClick={mount.onSubmit}
    >
      <WandIcon name="enter" slot="start" size={14}/>
      <span>发送</span>
    </WandButton>,
    mount.target,
    mount.key,
  ));
}
