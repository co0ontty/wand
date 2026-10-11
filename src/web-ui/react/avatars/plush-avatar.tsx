import * as React from "react";
import { chuerWhiskerPath } from "../../../plush-cat-whiskers.js";
import { plushCatAppearance, catHeadWidthAt, CAT_MARKINGS } from "../../../plush-cat-appearance.js";
import { PLUSH_COLORS, isPlushCatAvatar, type PlushAvatarConfig, type PlushRenderConfig } from "../../../plush-avatar.js";
import { installStyleSheet } from "../styles.js";
import { useReducedMotion } from "../ui/motion-tokens.js";
import type { PlushAvatarRuntime, PlushGlobals, PlushRenderHandle, PlushFallbackReason, PlushLoaderDiagnostics, PlushLoaderFailure } from "./runtime-contract.js";
import { AvatarFilePropsFallback } from "./file-props-fallback.js";
import { AvatarThinking } from "./thinking.js";

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

.wand-avatar-file-fallback{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.wand-plush-avatar[data-renderer="webgl"] .wand-avatar-file-fallback{visibility:hidden}
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
  const headClip = React.useId();
  if (isPlushCatAvatar(config)) {
    const silver = config.coat === "silver", profile = plushCatAppearance(config);
    const { coat, dark, pale, iris, innerEar, nose } = profile;
    const px = (x: number) => 50 + x * 36, py = (y: number) => 50 - y * 36;
    const outline: [number, number][] = [];
    for (const side of [-1, 1]) for (let i = 0; i <= 48; i++) {
      const theta = (side < 0 ? i : 48 - i) / 48 * Math.PI;
      const y = Math.cos(theta) * profile.head[1] - 0.045;
      const ruff = !silver && y < 0.2 && y > -0.55 ? (i % 3 === 0 ? 0.035 : 0) : 0;
      outline.push([px(side * (Math.sin(theta) * catHeadWidthAt(profile, y) + ruff)), py(y)]);
    }
    const silhouette = outline.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ") + "Z";
    const eyePath = (side: number) => Array.from({ length: 65 }, (_, i) => {
      const angle = i / 64 * Math.PI * 2, cos = Math.cos(angle), sin = Math.sin(angle);
      return `${i ? "L" : "M"}${px(side * profile.eyeX + cos * profile.eyeWidth)} ${py(profile.eyeY + Math.sign(sin) * Math.pow(Math.abs(sin), 0.82) * (sin >= 0 ? profile.eyeUpper : profile.eyeLower) + side * cos * 0.018)}`;
    }).join(" ") + "Z";
    return <svg className="wand-plush-avatar-fallback" viewBox="0 0 100 100" aria-hidden="true">
      <defs><clipPath id={headClip}><path d={silhouette}/></clipPath>
        <radialGradient id={`${headClip}-jaw`} cx="50" cy={py(profile.chinY)} r={profile.chinWidth * 56} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={pale}/><stop offset=".65" stopColor={pale} stopOpacity=".97"/>
          <stop offset="1" stopColor={pale} stopOpacity=".86"/>
        </radialGradient>
      </defs>
      {[-1, 1].map(side => <g key={side} transform={`translate(${px(side * profile.earX)} ${py(profile.earY)}) rotate(${side * 16})`}>
        <path d="M-.18 -.93 Q0 -1.22 .18 -.93 L.87 .48 Q1.03 .8 .66 .83 Q0 .92 -.66 .83 Q-1.03 .8 -.87 .48Z"
          transform={`scale(${profile.ear[0] * 36} ${profile.ear[1] * 36})`} fill={coat}/>
        <path d="M-.18 -.93 Q0 -1.22 .18 -.93 L.87 .48 Q1.03 .8 .66 .83 Q0 .92 -.66 .83 Q-1.03 .8 -.87 .48Z"
          transform={`translate(0 .7) scale(${profile.ear[0] * 21} ${profile.ear[1] * 23})`} fill={innerEar}/>
      </g>)}
      <path d={silhouette} fill={coat}/>
      <g clipPath={`url(#${headClip})`}>
        <path d={silver ? "M16 63Q25 57 32 57Q35 53 44 53Q50 51 56 53Q65 53 68 57Q75 57 84 63L78 94H22Z"
          : "M10 64Q24 61 28 62Q34 64 40 54Q47 53 48 48Q49 40 52 45Q53 53 61 53Q63 61 76 62L89 66L82 94H16Z"} fill={`url(#${headClip}-jaw)`}/>
        {CAT_MARKINGS[config.coat].map((mark, i) => <path key={i}
          d={mark.points.map(([x, y], at) => `${at ? "L" : "M"}${px(x)} ${py(y)}`).join(" ")}
          fill="none" stroke={dark} strokeWidth={mark.width * 56} opacity={mark.opacity} strokeLinecap="round" strokeLinejoin="round"/>)}
      </g>
      {[-1, 1].map(side => <g key={side}>
        <path d={eyePath(side)} fill={iris} stroke="#354134" strokeWidth=".8"/>
        <ellipse cx={px(side * profile.eyeX - side * 0.008)} cy={py(profile.eyeY)} rx={profile.pupilWidth * 36} ry={profile.pupilHeight * 36} fill="#152018"/>
        <ellipse cx={px(side * profile.eyeX - 0.041)} cy={py(profile.eyeY + 0.048)} rx=".54" ry=".75" fill="#f5f2df"/>
        {(silver ? [0, 1, 2] : [0, 1, 2, 3]).map(n => <path key={n} data-whisker={silver ? "straight" : "curly"}
          d={silver ? `M${px(side * 0.18)} ${py(profile.muzzleY - n * 0.013)}Q${px(side * 0.63)} ${py(profile.muzzleY + 0.115 - n * 0.074)} ${px(side * (0.97 + (n % 2) * 0.09))} ${py(profile.muzzleY + 0.19 - n * 0.143)}`
            : chuerWhiskerPath(n, side, profile.muzzleY)}
          fill="none" stroke="#eae5d8" strokeWidth={silver ? ".3" : ".36"}/>)}
      </g>)}
      <path d={`M${px(-profile.noseWidth)} ${py(profile.noseY + profile.noseHeight * 0.4)}Q50 ${py(profile.noseY + profile.noseHeight * 0.65)} ${px(profile.noseWidth)} ${py(profile.noseY + profile.noseHeight * 0.4)}L50 ${py(profile.noseY - profile.noseHeight * 0.7)}Z`} fill={nose} stroke="#665344" strokeWidth=".45"/>
      <path d={`M50 ${py(profile.noseY - profile.noseHeight * 0.6)}V${py(profile.mouthY + 0.035)}m-4 1q4-1 8 0`} fill="none" stroke="#665344" strokeWidth=".6" strokeLinecap="round"/>
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
export function PlushAvatar({ config, size = 32, className = "", speaking = false, thinking = false, fileActivity = "idle", interactive = false, onRendererChange }: {
  config: PlushRenderConfig;
  size?: number;
  className?: string;
  speaking?: boolean;
  thinking?: boolean;
  fileActivity?: import("../../composer-avatar-activity.js").AvatarFileActivity;
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
  const latest = React.useRef({ config, size, speaking, thinking, fileActivity, interactive, reducedMotion });
  const reportRenderer = React.useRef(onRendererChange);
  reportRenderer.current = onRendererChange;
  latest.current = { config, size, speaking, thinking, fileActivity, interactive, reducedMotion };
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
  React.useEffect(() => { handle.current?.update(latest.current); }, [configKey, size, speaking, thinking, fileActivity, interactive, reducedMotion]);
  return <span className={`wand-plush-avatar ${className}`.trim()} data-plush-avatar="" data-avatar-config={configKey}
    data-avatar-breed={isPlushCatAvatar(config) ? plushCatAppearance(config).breed : undefined}
    data-file-activity={fileActivity} data-renderer={renderer} data-render-state={activity} data-fallback-reason={fallbackReason}
    title={renderer === "fallback" ? fallbackReason === "webgl-unavailable" ? "静态头像 · 当前浏览器不支持 3D"
      : fallbackReason === "runtime-load" ? "静态头像 · 3D 组件未能加载" : "静态头像 · 3D 暂不可用" : undefined}
    aria-hidden="true" style={{ width: size, height: size }}>
    <PlushFallback config={config}/><canvas ref={canvas} width={size} height={size}/>
    {fileActivity !== "idle" ? <AvatarFilePropsFallback activity={fileActivity} pawColor={isPlushCatAvatar(config) ? plushCatAppearance(config).coat : PLUSH_COLORS.find(option => option.id === config.color)?.color ?? "#ecb6a3"}/> : thinking ? <AvatarThinking/> : null}
  </span>;
}
