import type { PlushRenderConfig } from "../../../plush-avatar.js";

export interface PlushRenderOptions {
  config: PlushRenderConfig;
  size: number;
  speaking: boolean;
  interactive: boolean;
  reducedMotion: boolean;
}

export interface PlushRenderHandle {
  update(options: PlushRenderOptions): void;
  dispose(): void;
}

export type PlushFallbackReason = "runtime-load" | "canvas-unavailable" | "webgl-unavailable" | "context-lost" | "render-failed" | "shader-compile-failed";

export interface PlushAvatarRuntime {
  attach(canvas: HTMLCanvasElement, options: PlushRenderOptions,
    state: (renderer: "webgl" | "fallback", activity: "active" | "static" | "paused" | "fallback", reason?: PlushFallbackReason) => void): PlushRenderHandle;
}

export type PlushLoaderFailure = "download" | "timeout" | "loaded-missing-runtime";
export interface PlushLoaderDiagnostics {
  status: "idle" | "loading" | "ready" | "failed";
  assetPath: string;
  attempts: number;
  cycleAttempts: number;
  maxCycleAttempts: number;
  onlineRecoveries: number;
  maxOnlineRecoveries: number;
  startedAt: number;
  finishedAt: number;
  failure?: PlushLoaderFailure;
}

export type PlushGlobals = typeof globalThis & {
  __wandPlushRuntime?: PlushAvatarRuntime;
  __wandPlushLoaderDiagnostics?: () => Readonly<PlushLoaderDiagnostics>;
  __wandPlushDiagnostics?: () => Record<string, number | boolean>;
};
