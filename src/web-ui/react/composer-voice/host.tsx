import { useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import { Bubble } from "@ant-design/x";
import { WandUiBoundary } from "../theme";
import {
  composerVoiceController,
  type ComposerVoiceMount,
} from "./controller";

/** Recording gestures and transcription revisions remain owned by the browser controller. */
export function ComposerVoiceBubble({ mount }: { mount: ComposerVoiceMount }): React.ReactElement {
  return <WandUiBoundary><div id="voice-transcript-bubble" aria-live="polite">
    <Bubble content={mount.transcript || mount.status} footer={mount.transcript ? mount.status : undefined}
      variant="outlined"/>
  </div></WandUiBoundary>;
}

export function ComposerVoiceHost(): React.ReactElement[] {
  const snapshot = useSyncExternalStore(
    composerVoiceController.subscribe,
    composerVoiceController.getSnapshot,
    composerVoiceController.getSnapshot,
  );

  return snapshot.mounts.map((mount) => createPortal(
    <ComposerVoiceBubble mount={mount} />,
    mount.target,
    mount.key,
  ));
}
