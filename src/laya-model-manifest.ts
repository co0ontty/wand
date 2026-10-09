export const LAYA_REPOSITORY = "aac6fef/laya-multilingual-mlx";
export const LAYA_REVISION = "f2b4faf51023039425946074e2cf1361d2db11d5";
export interface ModelFile { path: string; size: number; sha256: string; }
/** Exact upstream bytes, including tokenizer/config/identity/license, not an arbitrary HF repository. */
export const LAYA_FILES: readonly ModelFile[] = [
  { path: "model.safetensors", size: 643835426, sha256: "7fc5834af4d8fdfb268d272a9d1a66e5819a0daac98241651c4c888cc43adff1" },
  { path: "tokenizer/tokenizer.json", size: 34363188, sha256: "609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f" },
  { path: "encoder/config.json", size: 1938, sha256: "83f6916d13ef0f556ac461f28308dc2bffa7ebeadee8ec9e2db5812020ea5bb4" },
  { path: "mlx_config.json", size: 316, sha256: "20ec723e1365a268597cc7e8cd39495c5e2eb58311b925f8e8c165ec5855cc28" },
  { path: "rl_agent_config.json", size: 473, sha256: "9a669a70961064c3c6cc76d2afb8bc5fb10dcd8349bb66e5f7b9b1afb74440d5" },
  { path: "tokenizer/tokenizer_config.json", size: 524, sha256: "6c6b2d8e3c84ce0e671c129cd6b374b235d6f9863042a5836358d00a89bbb5a1" },
  { path: "manifest.json", size: 1773, sha256: "deb2de8ec6b1520b74866249bda632f40501440cdac29fdd90af80a3c422c778" },
  { path: "LICENSE", size: 10173, sha256: "a6cba85bc92e0cff7a450b1d873c0eaa2e9fc96bf472df0247a26bec77bf3ff9" },
  { path: "NOTICE", size: 698, sha256: "f23ae8ae701f5a43e186182e387aeef00b666daed18a946fc7c9ea827b00a8fa" },
];
export const LAYA_MODEL_BYTES = LAYA_FILES.reduce((total, file) => total + file.size, 0);
export function layaFileUrl(file: ModelFile): string {
  return `https://huggingface.co/${LAYA_REPOSITORY}/resolve/${LAYA_REVISION}/${file.path}`;
}
