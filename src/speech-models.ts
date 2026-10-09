/** Multilingual models (not .en); pinned upstream LFS SHA-256 and byte size. */
export const SPEECH_MODEL_REVISION = "5359861c739e955e79d9a303bcbc70fb988958b1";
export const SPEECH_MODELS = [
  { id: "tiny", label: "Whisper Tiny", description: "中英及多语言 · 低内存 CPU，速度优先", size: 77_691_713,
    sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21" },
  { id: "base", label: "Whisper Base", description: "中英及多语言 · 通用 CPU / Mac mini，均衡推荐", size: 147_951_465,
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe" },
  { id: "small", label: "Whisper Small", description: "中英及多语言 · 更高准确度，适合 Metal / CUDA 或较强 CPU", size: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b" },
] as const;
export type SpeechModel = typeof SPEECH_MODELS[number];
export function speechModel(id: string): SpeechModel | undefined {
  return SPEECH_MODELS.find((model) => model.id === id);
}
export function speechModelUrl(model: SpeechModel): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/${SPEECH_MODEL_REVISION}/ggml-${model.id}.bin`;
}
