import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { composerSelectController } from "./controller";
import { WandSelect } from "../ui";

export function ComposerSelectHost() {
  const snapshot = useSyncExternalStore(
    composerSelectController.subscribe,
    composerSelectController.getSnapshot,
    composerSelectController.getSnapshot,
  );

  return snapshot.mounts.map((mount) => createPortal(
    <WandSelect
      value={mount.value}
      options={mount.options}
      ariaLabel={mount.ariaLabel}
      placeholder={mount.placeholder}
      displayValue={mount.displayValue}
      disabled={mount.disabled}
      className={`wand-composer-select-trigger wand-composer-select-trigger-${mount.control}`}
      contentClassName={`wand-composer-select-content wand-composer-select-content-${mount.control}`}
      itemClassName="wand-composer-select-item"
      side="top"
      align={mount.align}
      sideOffset={8}
      collisionPadding={14}
      onValueChange={mount.onValueChange}
    />,
    mount.target,
    mount.key,
  ));
}
