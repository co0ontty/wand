import { SPEECH_MAX_SECONDS, SPEECH_SAMPLE_RATE } from "../speech-types.js";

/** Encode and downsample locally so hosts need no ffmpeg/codec dependencies. */
export function encodeSpeechWav(channels: readonly Float32Array[], sourceRate: number): ArrayBuffer {
  if (!channels.length || !Number.isFinite(sourceRate) || sourceRate < SPEECH_SAMPLE_RATE
    || !channels[0]?.length || channels.some((channel) => channel.length !== channels[0]!.length)) throw new Error("麦克风音频格式无效。");
  const frames = channels[0]!.length;
  if (frames / sourceRate > SPEECH_MAX_SECONDS + 0.05) throw new Error("语音最长 60 秒，请分段录音。");
  const count = Math.min(SPEECH_SAMPLE_RATE * SPEECH_MAX_SECONDS, Math.floor(frames * SPEECH_SAMPLE_RATE / sourceRate));
  if (count < 1600) throw new Error("录音太短，请按住麦克风说话。");
  const bytes = new ArrayBuffer(44 + count * 2);
  const view = new DataView(bytes);
  const ascii = (offset: number, value: string): void => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)); };
  ascii(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SPEECH_SAMPLE_RATE, true); view.setUint32(28, SPEECH_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, "data"); view.setUint32(40, count * 2, true);
  const ratio = sourceRate / SPEECH_SAMPLE_RATE;
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.max(start + 1, Math.floor((index + 1) * ratio));
    let sample = 0;
    for (const channel of channels) for (let source = start; source < end; source += 1) sample += channel[source] ?? 0;
    sample = Math.max(-1, Math.min(1, sample / ((end - start) * channels.length)));
    view.setInt16(44 + index * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
  }
  return bytes;
}
