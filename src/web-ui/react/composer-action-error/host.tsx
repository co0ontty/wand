import { useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import { Alert } from "antd";
import { WandUiBoundary } from "../theme";
import {
  composerActionErrorController,
  type ComposerActionErrorMount,
} from "./controller";

/** Inline failure feedback never moves focus or clears the owned draft. */
export function ComposerActionError({ mount }: { mount: ComposerActionErrorMount }): React.ReactElement {
  return <WandUiBoundary><Alert id="action-error" role="alert" type="error" title={mount.message} showIcon/></WandUiBoundary>;
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
