import * as React from "react";
import { PLUSH_COLORS, isPlushCatAvatar, type PlushAvatarConfig, type PlushRenderConfig } from "../../../plush-avatar.js";
import { installStyleSheet } from "../styles.js";
import { useReducedMotion } from "../ui/motion-tokens.js";
import type { PlushAvatarRuntime, PlushGlobals, PlushRenderHandle, PlushFallbackReason, PlushLoaderDiagnostics, PlushLoaderFailure } from "./runtime-contract.js";

const CHUNK_SRC = "${plushAvatarChunkSrc}";
const MAX_LOAD_ATTEMPTS = 3;
const MAX_ONLINE_RECOVERIES = 1;
const RETRY_DELAYS_MS = [750, 2_000];
let pending: Promise<PlushAvatarRuntime> | null = null;
let exhausted = false;
let onlineRecoveries = 0;
const recoveryListeners = new Set<() => void>();
const loaderState: PlushLoaderDiagnostics = {
  status: "idle", assetPath: CHUNK_SRC.split("?")[0], attempts: 0, cycleAttempts: 0,
  maxCycleAttempts: MAX_LOAD_ATTEMPTS, onlineRecoveries: 0, maxOnlineRecoveries: MAX_ONLINE_RECOVERIES, startedAt: 0, finishedAt: 0,
};
(globalThis as PlushGlobals).__wandPlushLoaderDiagnostics = () => ({ ...loaderState });

function downloadRuntime(): Promise<PlushAvatarRuntime> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    let settled = false;
    const finish = (failure?: PlushLoaderFailure) => {
      if (settled) return;
      settled = true; window.clearTimeout(timeout); script.onload = script.onerror = null;
      if (failure) { script.remove(); reject(failure); }
      else resolve((globalThis as PlushGlobals).__wandPlushRuntime!);
    };
    const timeout = window.setTimeout(() => finish("timeout"), 15_000);
    script.async = true;
    script.onload = () => finish((globalThis as PlushGlobals).__wandPlushRuntime ? undefined : "loaded-missing-runtime");
    script.onerror = () => finish("download");
    // Chrome can coalesce identical URLs with a timed-out script that is still downloading.
    // Keep the asset version, but give a retry its own request identity.
    const src = loaderState.attempts <= 1 ? CHUNK_SRC
      : `${CHUNK_SRC}${CHUNK_SRC.includes("?") ? "&" : "?"}wandPlushRetry=${loaderState.attempts}`;
    try { script.src = src; document.head.append(script); }
    catch { finish("download"); }
  });
}

function loadRuntime(): Promise<PlushAvatarRuntime> {
  const globals = globalThis as PlushGlobals;
  if (globals.__wandPlushRuntime) {
    loaderState.status = "ready"; loaderState.failure = undefined;
    return Promise.resolve(globals.__wandPlushRuntime);
  }
  if (pending) return pending;
  if (exhausted) return Promise.reject(loaderState.failure);
  loaderState.status = "loading"; loaderState.startedAt = Date.now(); loaderState.finishedAt = 0;
  loaderState.cycleAttempts = 0;
  pending = (async () => {
    for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt++) {
      if (attempt) await new Promise<void>(resolve => window.setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
      // A previously timed-out response may finish before the next bounded attempt.
      if (globals.__wandPlushRuntime) { loaderState.status = "ready"; loaderState.failure = undefined; loaderState.finishedAt = Date.now(); return globals.__wandPlushRuntime; }
      loaderState.attempts++; loaderState.cycleAttempts++;
      try {
        const runtime = await downloadRuntime();
        loaderState.status = "ready"; loaderState.failure = undefined; loaderState.finishedAt = Date.now();
        return runtime;
      } catch (failure: unknown) {
        loaderState.failure = failure === "timeout" || failure === "loaded-missing-runtime" ? failure : "download";
      }
    }
    exhausted = true; loaderState.status = "failed"; loaderState.finishedAt = Date.now();
    throw loaderState.failure;
  })().finally(() => { pending = null; });
  return pending;
}

function recoverRuntime(online: boolean): boolean {
  if (pending || loaderState.status !== "failed" || !recoveryListeners.size) return false;
  if (online && onlineRecoveries >= MAX_ONLINE_RECOVERIES) return false;
  if (online) loaderState.onlineRecoveries = ++onlineRecoveries;
  exhausted = false;
  for (const retry of recoveryListeners) retry();
  return true;
}
const onOnline = () => { recoverRuntime(true); };

/** Explicit resource retry only; this never resets WebGL or changes avatar data. */
export function retryPlushAvatarRuntime(): boolean { return recoverRuntime(false); }

const styles = String.raw`
.wand-plush-avatar{position:relative;display:inline-grid;flex:none;place-items:center;overflow:visible;isolation:isolate;vertical-align:middle;line-height:0}
.wand-plush-avatar canvas,.wand-plush-avatar-fallback{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none}
.wand-plush-avatar canvas{opacity:0}
.wand-plush-avatar[data-renderer="webgl"] canvas{opacity:1}
.wand-plush-avatar[data-renderer="webgl"] .wand-plush-avatar-fallback{visibility:hidden}
`;

const SHAPE_PATHS: Record<PlushAvatarConfig["shape"], string> = {
  heart: "M50 84C42 80 13 61 13 35C13 13 37 9 50 27C63 9 87 13 87 35C87 61 58 80 50 84Z",
  triangle: "M42 20Q50 7 58 20L86 68Q95 86 76 87H24Q5 86 14 68Z",
  diamond: "M41 15Q50 6 59 15L85 41Q94 50 85 59L59 85Q50 94 41 85L15 59Q6 50 15 41Z",
  round: "M88 50A38 38 0 1 1 12 50A38 38 0 1 1 88 50Z",
  square: "M32 14H68Q86 14 86 32V68Q86 86 68 86H32Q14 86 14 68V32Q14 14 32 14Z",
  capsule: "M50 9Q79 9 79 39V61Q79 91 50 91Q21 91 21 61V39Q21 9 50 9Z",
};

/** Honest static fallback: the same configured silhouette, not an imitation animation. */
function PlushFallback({ config }: { config: PlushRenderConfig }): React.ReactElement {
  if (isPlushCatAvatar(config)) {
    const silver = config.coat === "silver";
    const coat = silver ? "#9dabb8" : "#f49335", dark = silver ? "#687b8d" : "#bc651c";
    return <svg className="wand-plush-avatar-fallback" viewBox="0 0 100 100" aria-hidden="true">
      <path d="M14 39L18 8L39 28H61L82 8L86 39V67Q86 87 64 88H36Q14 87 14 67Z" fill={coat}/>
      <path d="M18 8L18 34L25 29L26 14ZM82 8L82 34L75 29L74 14Z" fill={dark}/>
      <rect x="29" y="43" width="17" height="14" rx="4" fill="#fffdfa"/><rect x="54" y="43" width="17" height="14" rx="4" fill="#fffdfa"/>
      <rect x="37" y="44" width="9" height="9" rx="2" fill={silver ? "#428e61" : "#25211e"}/>
      <rect x="54" y="44" width="9" height="9" rx="2" fill={silver ? "#428e61" : "#25211e"}/>
      <path d="M46 62H54Q58 62 54 67L50 70L46 67Q42 62 46 62" fill="#ed8799"/>
      <path d="M50 70v4m0 0q-5 5-9 1m9-1q5 5 9 1" fill="none" stroke={dark} strokeWidth="2" strokeLinecap="round"/>
      <path d="M22 65v8M78 65v8" stroke={dark} strokeWidth="6" strokeLinecap="round"/>
    </svg>;
  }
  const color = PLUSH_COLORS.find(option => option.id === config.color)?.color ?? "#ecb6a3";
  return <svg className="wand-plush-avatar-fallback" viewBox="0 0 100 100" aria-hidden="true">
    <path d={SHAPE_PATHS[config.shape]} fill={color}/>
    <ellipse cx="38" cy="51" rx="2.6" ry="4" fill="#25211e"/><ellipse cx="62" cy="51" rx="2.6" ry="4" fill="#25211e"/>
    <path d="M45 62Q50 68 55 62" fill="none" stroke="#25211e" strokeWidth="2.3" strokeLinecap="round"/>
    {config.glasses !== "none" ? <g fill="none" stroke={config.glasses === "gold" ? "#a88143" : "#302d29"} strokeWidth={config.glasses === "gold" ? 1.4 : 2.2}>
      <circle cx="38" cy="50" r="10"/><circle cx="62" cy="50" r="10"/><path d="M48 49Q50 47 52 49M28 48H18M72 48H82"/>
    </g> : null}
    {config.hat === "beanie" ? <g fill="#b96843"><path d="M23 28Q24 2 50 2Q76 2 77 28Z"/><rect x="20" y="21" width="60" height="10" rx="4"/><circle cx="50" cy="4" r="7"/></g> : null}
    {config.hat === "beret" ? <g fill="#e9dfca"><ellipse cx="51" cy="19" rx="33" ry="12" transform="rotate(12 51 19)"/><path d="M54 9L55 3" stroke="#d4c6a9" strokeWidth="4"/></g> : null}
  </svg>;
}

/** Shared real 3D identity. Speaking is an explicit audio state, never inferred from task activity. */
export function PlushAvatar({ config, size = 32, className = "", speaking = false, interactive = false, onRendererChange }: {
  config: PlushRenderConfig;
  size?: number;
  className?: string;
  speaking?: boolean;
  interactive?: boolean;
  onRendererChange?(renderer: "loading" | "webgl" | "fallback", reason?: PlushFallbackReason): void;
}): React.ReactElement {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const handle = React.useRef<PlushRenderHandle | null>(null);
  const reducedMotion = useReducedMotion();
  const [renderer, setRenderer] = React.useState<"loading" | "webgl" | "fallback">("loading");
  const [activity, setActivity] = React.useState("static");
  const [fallbackReason, setFallbackReason] = React.useState<PlushFallbackReason | undefined>();
  const configKey = JSON.stringify(config);
  const latest = React.useRef({ config, size, speaking, interactive, reducedMotion });
  const reportRenderer = React.useRef(onRendererChange);
  reportRenderer.current = onRendererChange;
  latest.current = { config, size, speaking, interactive, reducedMotion };
  React.useEffect(() => {
    installStyleSheet("wand-plush-avatar-styles", styles);
    const node = canvas.current;
    if (!node) return;
    let alive = true;
    let attaching = false;
    let resourceFailed = false;
    let reported = "";
    const notifyRenderer = (next: "loading" | "webgl" | "fallback", reason?: PlushFallbackReason) => {
      const key = `${next}:${reason ?? ""}`;
      if (reported !== key) { reported = key; reportRenderer.current?.(next, reason); }
    };
    notifyRenderer("loading");
    const attach = () => {
      if (!alive || attaching || handle.current) return;
      attaching = true; resourceFailed = false;
      setRenderer("loading"); setActivity("static"); setFallbackReason(undefined); notifyRenderer("loading");
      loadRuntime().then(runtime => {
        attaching = false;
        if (!alive) return;
        handle.current = runtime.attach(node, latest.current, (next, state, reason) => {
          if (alive) { setRenderer(next); setActivity(state); setFallbackReason(reason); notifyRenderer(next, reason); }
        });
      }, () => { attaching = false; resourceFailed = true; if (alive) { setRenderer("fallback"); setActivity("fallback"); setFallbackReason("runtime-load"); notifyRenderer("fallback", "runtime-load"); } });
    };
    // Hidden lists do not download WebGL or acquire a context until an avatar becomes visible.
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); attach(); }
    }, { rootMargin: "48px" });
    observer.observe(node);
    const retry = () => { if (resourceFailed) attach(); };
    if (!recoveryListeners.size) window.addEventListener("online", onOnline);
    recoveryListeners.add(retry);
    return () => {
      recoveryListeners.delete(retry);
      if (!recoveryListeners.size) window.removeEventListener("online", onOnline);
      alive = false; observer.disconnect(); handle.current?.dispose(); handle.current = null;
    };
  }, []);
  React.useEffect(() => { handle.current?.update(latest.current); }, [configKey, size, speaking, interactive, reducedMotion]);
  return <span className={`wand-plush-avatar ${className}`.trim()} data-plush-avatar="" data-avatar-config={configKey}
    data-renderer={renderer} data-render-state={activity} data-fallback-reason={fallbackReason}
    title={renderer === "fallback" ? fallbackReason === "webgl-unavailable" ? "静态头像 · 当前浏览器不支持 3D"
      : fallbackReason === "runtime-load" ? "静态头像 · 3D 组件未能加载" : "静态头像 · 3D 暂不可用" : undefined}
    aria-hidden="true" style={{ width: size, height: size }}>
    <PlushFallback config={config}/><canvas ref={canvas} width={size} height={size}/>
  </span>;
}
