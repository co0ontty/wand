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

export type PlushGlobals = typeof globalThis & {
  __wandPlushRuntime?: PlushAvatarRuntime;
  __wandPlushDiagnostics?: () => Record<string, number | boolean>;
};
