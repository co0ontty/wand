import type { PlushAvatarConfig } from "../../../plush-avatar.js";

export interface PlushRenderOptions {
  config: PlushAvatarConfig;
  size: number;
  speaking: boolean;
  interactive: boolean;
  reducedMotion: boolean;
}

export interface PlushRenderHandle {
  update(options: PlushRenderOptions): void;
  dispose(): void;
}

export interface PlushAvatarRuntime {
  attach(canvas: HTMLCanvasElement, options: PlushRenderOptions,
    state: (renderer: "webgl" | "fallback", activity: "active" | "static" | "paused" | "fallback") => void): PlushRenderHandle;
}

export type PlushGlobals = typeof globalThis & {
  __wandPlushRuntime?: PlushAvatarRuntime;
  __wandPlushDiagnostics?: () => Record<string, number | boolean>;
};
