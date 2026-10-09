/** Shared, transport-only speech contract. Never expose executable paths or audio. */
export type SpeechAcceleration = "auto" | "cpu" | "gpu";
export type SpeechBackend = "cpu" | "metal" | "cuda";
export interface SpeechSettings {
  enabled: boolean;
  model: string;
  acceleration: SpeechAcceleration;
  language: "auto" | "zh" | "en";
  threads: number;
}
export interface SpeechModelStatus {
  id: string;
  label: string;
  description: string;
  size: number;
  downloaded: boolean;
}
export interface SpeechStatus {
  settings: SpeechSettings;
  ready: boolean;
  reason: string | null;
  runtime: { available: boolean; backend: SpeechBackend; platform: string; arch: string };
  models: SpeechModelStatus[];
  download: { model: string; received: number; total: number; phase: "downloading" | "failed"; error?: string } | null;
  maxDurationSeconds: number;
  busy: boolean;
  initialized?: boolean;
}
export interface SpeechResult {
  text: string;
  model: string;
  backend: SpeechBackend;
}
export const SPEECH_SAMPLE_RATE = 16_000;
export const SPEECH_MAX_SECONDS = 60;
export const SPEECH_MAX_WAV_BYTES = 44 + SPEECH_SAMPLE_RATE * 2 * SPEECH_MAX_SECONDS;
