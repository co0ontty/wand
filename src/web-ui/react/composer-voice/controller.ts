/**
 * 语音转写气泡（`#voice-transcript-bubble`）的 portal 渲染契约。
 *
 * 旧实现由 `startVoiceRecording` / `handleVoiceMove` / `resetVoiceRecordingUI`
 * 直接读写 `#voice-transcript-bubble`、`#voice-transcript-text`、
 * `#voice-transcript-status` 三个节点（切 `.hidden` / `.is-canceling` /
 * `.has-text`，写 `textContent`）。现在这三个值进 `voiceState` 快照，React 渲染。
 *
 * `.has-text` 由 `transcript !== ""` 推导（旧代码就是 `toggle("has-text", !!transcript)`），
 * `.voice-transcript-bubble:not(.has-text) .voice-transcript-text::before` 依赖它。
 *
 * 录制按钮 `#voice-record-btn` 不在这里：它的 pointer 监听由 legacy 直接绑在节点上，
 * 单独一个切片处理。
 *
 * 幂等注册表见 `../composer-portal/mount-store`。
 */
import { MountStore, type MountSnapshot } from "../composer-portal/mount-store";

export interface ComposerVoiceState {
  /** 上滑到取消区（`.is-canceling`）。 */
  readonly canceling: boolean;
  /** 累积的转写文字；非空即 `.has-text`。 */
  readonly transcript: string;
  readonly status: string;
}

export interface ComposerVoiceMount extends ComposerVoiceState {
  readonly key: string;
  readonly target: HTMLElement;
}

export interface ComposerVoiceSnapshot extends MountSnapshot<ComposerVoiceMount> {}

function sameMount(a: ComposerVoiceMount, b: ComposerVoiceMount): boolean {
  return a.target === b.target
    && a.canceling === b.canceling
    && a.transcript === b.transcript
    && a.status === b.status;
}

export class ComposerVoiceController extends MountStore<ComposerVoiceMount> {
  constructor() {
    super(sameMount);
  }
}

export const composerVoiceController = new ComposerVoiceController();
