/**
 * Whether the bottom composer head may run a live 3D scene.
 * Facts come from the browser: CPU count, device memory when exposed,
 * and WebGL's own major-performance-caveat flag plus texture limit.
 * Missing optional facts are not treated as weak. No GPU name matching.
 */
export const AVATAR_LIVE_MIN_CORES = 4;
export const AVATAR_LIVE_MIN_MEMORY_GB = 4;
export const AVATAR_LIVE_MIN_TEXTURE = 2048;

export interface AvatarHardwareFacts {
  /** navigator.hardwareConcurrency. Undefined when the browser withholds it. */
  cores?: number;
  /** navigator.deviceMemory in GB. Chromium only; undefined is not a failure. */
  memoryGb?: number;
  /** A WebGL context exists at all. */
  webgl: boolean;
  /** Context still exists when the browser is asked to refuse a major performance caveat. */
  webglWithoutCaveat: boolean;
  /** MAX_TEXTURE_SIZE. 0 when no context could be read. */
  maxTextureSize: number;
}

export type AvatarRenderChoice = "live" | "static";

export function avatarRenderChoice(facts: AvatarHardwareFacts): AvatarRenderChoice {
  if (!facts.webgl || !facts.webglWithoutCaveat) return "static";
  if (facts.maxTextureSize > 0 && facts.maxTextureSize < AVATAR_LIVE_MIN_TEXTURE) return "static";
  if (facts.cores !== undefined && facts.cores < AVATAR_LIVE_MIN_CORES) return "static";
  if (facts.memoryGb !== undefined && facts.memoryGb < AVATAR_LIVE_MIN_MEMORY_GB) return "static";
  return "live";
}

type WebGLProbe = WebGLRenderingContext | WebGL2RenderingContext;

function probeContext(canvas: HTMLCanvasElement, failIfMajorPerformanceCaveat: boolean): WebGLProbe | null {
  const attributes = {
    alpha: true, antialias: false, depth: false, stencil: false, failIfMajorPerformanceCaveat,
  };
  return (canvas.getContext("webgl2", attributes) as WebGL2RenderingContext | null)
    ?? (canvas.getContext("webgl", attributes) as WebGLRenderingContext | null);
}

/** Read the hardware facts this browser will actually expose. Safe outside a document. */
export function readAvatarHardware(): AvatarHardwareFacts {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  const cores = nav && Number.isFinite(nav.hardwareConcurrency) ? nav.hardwareConcurrency : undefined;
  const memoryGb = nav && Number.isFinite(nav.deviceMemory) ? nav.deviceMemory : undefined;
  if (typeof document === "undefined") {
    return { cores, memoryGb, webgl: false, webglWithoutCaveat: false, maxTextureSize: 0 };
  }
  const canvas = document.createElement("canvas");
  try {
    const cautious = probeContext(canvas, true);
    const context = cautious ?? probeContext(canvas, false);
    const maxTextureSize = context ? Number(context.getParameter(context.MAX_TEXTURE_SIZE)) || 0 : 0;
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return {
      cores, memoryGb, maxTextureSize,
      webgl: Boolean(context), webglWithoutCaveat: Boolean(cautious),
    };
  } catch {
    return { cores, memoryGb, webgl: false, webglWithoutCaveat: false, maxTextureSize: 0 };
  }
}

let cachedChoice: AvatarRenderChoice | null = null;

/** One probe per page. Later composer mounts must not recreate a throwaway WebGL context. */
export function resolveComposerAvatarChoice(): AvatarRenderChoice {
  if (!cachedChoice) cachedChoice = avatarRenderChoice(readAvatarHardware());
  return cachedChoice;
}

export function cachedComposerAvatarChoice(): AvatarRenderChoice | null {
  return cachedChoice;
}
