import { useSyncExternalStore } from "react";
import * as React from "react";
import { createPortal } from "react-dom";
import {
  composerVoiceController,
  type ComposerVoiceMount,
} from "./controller";

function bubbleClassName(mount: ComposerVoiceMount): string {
  let className = "voice-transcript-bubble";
  if (mount.canceling) className += " is-canceling";
  if (mount.transcript) className += " has-text";
  return className;
}

/**
 * 语音转写气泡。`.voice-wave` 四根条与 `.voice-bubble-arrow` 是纯装饰，
 * 保留原结构与 `aria-hidden`。录音中才渲染 —— 等价于旧的 `.hidden`。
 */
export function ComposerVoiceBubble({ mount }: { mount: ComposerVoiceMount }): React.ReactElement {
  return (
    <div id="voice-transcript-bubble" className={bubbleClassName(mount)} aria-live="polite">
      <div className="voice-transcript-text">{mount.transcript}</div>
      <div className="voice-transcript-hint">
        <span className="voice-wave" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <span className="voice-transcript-status">{mount.status}</span>
      </div>
      <span className="voice-bubble-arrow" aria-hidden="true"></span>
    </div>
  );
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
