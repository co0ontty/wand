import type { SpeechResult, SpeechStatus } from "../../../speech-types.js";
import { encodeSpeechWav } from "../../speech-audio.js";
import { requestJson } from "../http-adapter";

export type SpeechMode = "server" | "local";
export function speechInputDescription(mode: SpeechMode): string {
  return mode === "local" ? "浏览器端侧识别，音频不上传。识别结果填入草稿，核对后发送。"
    : "音频发送到当前 Wand 主机进行本地转写；文字可交给口述整理师配置的模型整理。结果填入草稿，核对后发送。";
}
export const SPEECH_MODE_KEY = "wand.voiceRecognitionMode";
export function readSpeechMode(): SpeechMode {
  try { return localStorage.getItem(SPEECH_MODE_KEY) === "local" ? "local" : "server"; } catch { return "server"; }
}
export function saveSpeechMode(mode: SpeechMode): void {
  try { localStorage.setItem(SPEECH_MODE_KEY, mode); } catch {}
  window.dispatchEvent(new Event("wand-voice-settings-change"));
}
interface LocalRecognizer {
  processLocally: boolean;
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface LocalRecognizerConstructor {
  new(): LocalRecognizer;
  available?(options: { langs: string[]; processLocally: boolean }): Promise<string>;
  install?(options: { langs: string[]; processLocally: boolean }): Promise<boolean>;
}
function localConstructor(): LocalRecognizerConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const globals = window as unknown as { SpeechRecognition?: LocalRecognizerConstructor; webkitSpeechRecognition?: LocalRecognizerConstructor };
  return globals.SpeechRecognition ?? globals.webkitSpeechRecognition;
}
export function localSpeechSupported(): boolean {
  const Constructor = localConstructor();
  try { return !!Constructor && "processLocally" in new Constructor(); } catch { return false; }
}
export async function installLocalSpeech(): Promise<void> {
  const Constructor = localConstructor();
  if (!Constructor?.install || !localSpeechSupported()) throw new Error("当前浏览器不支持端侧识别，请使用服务端识别或原生客户端。");
  if (!await Constructor.install({ langs: [navigator.language || "zh-CN"], processLocally: true })) throw new Error("浏览器语言包安装失败，请在浏览器设置中检查后重试。");
}

export interface BrowserSpeechCallbacks {
  onPartial(text: string): void;
  onStatus(status: string): void;
  onProcessing(): void;
  onFinal(text: string, notice?: string): void;
  onError(message: string): void;
}

/** Hardware/request lifecycle only. Composer owners capture the destination/revision themselves. */
export class BrowserSpeechInput {
  private abort = new AbortController();
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private local: LocalRecognizer | null = null;
  private decoder: AudioContext | null = null;
  private chunks: Blob[] = [];
  private chunkBytes = 0;
  private text = "";
  private released = false;
  private done = false;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private finalTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly mode: SpeechMode, private readonly callbacks: BrowserSpeechCallbacks) {}
  async start(): Promise<void> {
    try {
      if (!window.isSecureContext) throw new Error("麦克风需要 HTTPS 或 localhost，请使用安全连接。");
      if (this.mode === "local") { await this.startLocal(); return; }
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("当前浏览器不支持录音，请使用原生客户端。");
      const status = await requestJson<SpeechStatus>("/api/speech/status", { signal: this.abort.signal });
      if (!status.ready) throw new Error(status.reason || "服务端识别未就绪，请检查语音设置。");
      if (this.done) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (this.done) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      const recorder = new MediaRecorder(stream);
      this.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (this.done || !event.data.size) return;
        this.chunkBytes += event.data.size;
        if (this.chunkBytes > 8 * 1024 * 1024) { this.fail("录音数据过大，请分段录音。"); return; }
        this.chunks.push(event.data);
      };
      recorder.onerror = () => this.fail("录音失败，请检查麦克风后重试。");
      recorder.onstop = () => { void this.finishServer(recorder.mimeType); };
      recorder.start(1000);
      this.started = true;
      this.callbacks.onStatus("正在聆听…上滑取消 · 最长 60 秒");
      this.timer = setTimeout(() => this.finish(), 60_000);
    } catch (error) { if (!this.done) this.fail(error instanceof Error ? error.message : "无法启动语音输入。"); }
  }
  private async startLocal(): Promise<void> {
    const Constructor = localConstructor();
    if (!Constructor || !localSpeechSupported()) throw new Error("当前浏览器不支持客户端本地识别，请切换服务端识别。");
    if (Constructor.available && await Constructor.available({ langs: [navigator.language || "zh-CN"], processLocally: true }) !== "available") {
      throw new Error("浏览器端侧语言包未就绪，请在语音设置中下载语言包。");
    }
    if (this.done) return;
    const local = new Constructor();
    this.local = local;
    local.processLocally = true; // Never silently invoke vendor cloud speech under a local label.
    local.lang = navigator.language || "zh-CN";
    local.continuous = true;
    local.interimResults = true;
    local.onresult = (event) => {
      if (this.done) return;
      this.text = Array.from(event.results, (result) => result[0].transcript).join("");
      this.callbacks.onPartial(this.text);
    };
    local.onerror = () => { if (!this.done) this.fail("客户端本地识别失败，请检查浏览器语言包与麦克风权限。"); };
    local.onend = () => { if (!this.done) { if (this.released) this.deliver(this.text); else this.fail("本地识别已结束，请松开后重试。"); } };
    local.start();
    this.started = true;
    this.callbacks.onStatus("客户端本地识别 · 上滑取消");
    this.timer = setTimeout(() => this.finish(), 60_000);
  }
  finish(): void {
    if (this.done || this.released) return;
    if (!this.started) { this.cancel(); this.callbacks.onError("录音尚未开始，请授权后重新按住说话。"); return; }
    this.released = true;
    if (this.timer) clearTimeout(this.timer);
    this.callbacks.onProcessing();
    if (this.done) return; // The owner can veto an auto-finish while the pointer is in the cancel zone.
    this.callbacks.onStatus(this.mode === "server" ? "服务端识别中…" : "本地识别中…");
    try {
      if (this.local) { this.local.stop(); this.finalTimer = setTimeout(() => this.deliver(this.text), 1500); }
      else if (this.recorder && this.recorder.state !== "inactive") { this.recorder.stop(); this.stopTracks(); }
      else this.fail("录音已中断，请重试。");
    } catch { this.fail("录音结束失败，请检查麦克风后重试。"); }
  }
  private async finishServer(type: string): Promise<void> {
    this.stopTracks();
    if (this.done) return;
    if (!this.released) { this.fail("录音已中断，请重试。"); return; }
    try {
      const compressed = new Blob(this.chunks, { type });
      this.chunks = [];
      const decoder = new AudioContext();
      this.decoder = decoder;
      const decoded = await decoder.decodeAudioData(await compressed.arrayBuffer());
      if (this.done) return;
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, channel) => decoded.getChannelData(channel));
      const wav = encodeSpeechWav(channels, decoded.sampleRate);
      await decoder.close(); this.decoder = null;
      this.finalTimer = setTimeout(() => this.fail("服务端识别超时，请选择较小模型后重试。"), 125_000);
      const result = await requestJson<SpeechResult>("/api/speech/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: wav, signal: this.abort.signal });
      if (typeof result.text !== "string" || result.text.length > 8000) throw new Error("服务端转写结果无效。");
      this.deliver(result.text, result.optimizationError);
    } catch (error) { if (!this.done) this.fail(error instanceof Error ? error.message : "语音识别失败。"); }
  }
  private stopTracks(): void { this.stream?.getTracks().forEach((track) => track.stop()); this.stream = null; }
  private deliver(text: string, notice?: string): void { if (this.done) return; this.cancel(); this.callbacks.onFinal(text.trim(), notice); }
  private fail(message: string): void { if (this.done) return; this.cancel(); this.callbacks.onError(message); }
  cancel(): void {
    if (this.done) return;
    this.done = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    if (this.finalTimer) clearTimeout(this.finalTimer);
    if (this.local) { this.local.onend = null; this.local.onerror = null; this.local.onresult = null; try { this.local.abort(); } catch {} }
    if (this.recorder) {
      this.recorder.onstop = null; this.recorder.ondataavailable = null; this.recorder.onerror = null;
      if (this.recorder.state !== "inactive") { try { this.recorder.stop(); } catch {} }
    }
    this.stopTracks();
    void this.decoder?.close().catch(() => {}); this.decoder = null;
    this.chunks = [];
  }
}
