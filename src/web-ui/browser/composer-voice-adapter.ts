import { syncPortalMounts } from "./mount-sync";
import {
  composerVoiceController,
  type ComposerVoiceMount,
} from "../react/composer-voice/controller";

export interface BrowserComposerVoiceConfig {
  /** 录音中（含上滑取消态）才显示气泡。 */
  visible: boolean;
  canceling: boolean;
  transcript: string;
  status: string;
}

/**
 * 把语音气泡状态发布给 React。宿主常驻在 `.input-panel` 内（浮在输入框上方），
 * 非录音态不发布 mount，整条气泡不渲染 —— 等价于旧的 `.hidden`。
 */
export function syncBrowserComposerVoice(config: BrowserComposerVoiceConfig): void {
  syncPortalMounts<ComposerVoiceMount>({
    selector: "[data-composer-voice-host]",
    store: composerVoiceController,
    build(target) {
      if (!config.visible) return null;
      return {
        key: "composer-voice",
        target,
        canceling: config.canceling,
        transcript: config.transcript,
        status: config.status,
      };
    },
  });
}
