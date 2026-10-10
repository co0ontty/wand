import * as React from "react";
import { PLUSH_COLORS, type PlushAvatarConfig } from "../../../plush-avatar.js";
import { installStyleSheet } from "../styles.js";
import { useReducedMotion } from "../ui/motion-tokens.js";
import type { PlushAvatarRuntime, PlushGlobals, PlushRenderHandle } from "./runtime-contract.js";

const CHUNK_SRC = "${plushAvatarChunkSrc}";
let pending: Promise<PlushAvatarRuntime> | null = null;

function loadRuntime(): Promise<PlushAvatarRuntime> {
  const globals = globalThis as PlushGlobals;
  if (globals.__wandPlushRuntime) return Promise.resolve(globals.__wandPlushRuntime);
  if (pending) return pending;
  pending = new Promise<PlushAvatarRuntime>((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = CHUNK_SRC;
    const timeout = window.setTimeout(() => { script.remove(); reject(new Error("头像加载超时")); }, 15_000);
    script.onload = () => {
      window.clearTimeout(timeout);
      const runtime = globals.__wandPlushRuntime;
      if (runtime) resolve(runtime);
      else { script.remove(); reject(new Error("头像组件未能加载")); }
    };
    script.onerror = () => { window.clearTimeout(timeout); script.remove(); reject(new Error("头像组件下载失败")); };
    document.head.append(script);
  }).catch((error: unknown) => { pending = null; throw error; });
  return pending;
}

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
function PlushFallback({ config }: { config: PlushAvatarConfig }): React.ReactElement {
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
export function PlushAvatar({ config, size = 32, className = "", speaking = false, interactive = false }: {
  config: PlushAvatarConfig;
  size?: number;
  className?: string;
  speaking?: boolean;
  interactive?: boolean;
}): React.ReactElement {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const handle = React.useRef<PlushRenderHandle | null>(null);
  const reducedMotion = useReducedMotion();
  const [renderer, setRenderer] = React.useState<"loading" | "webgl" | "fallback">("loading");
  const [activity, setActivity] = React.useState("static");
  const configKey = JSON.stringify(config);
  const latest = React.useRef({ config, size, speaking, interactive, reducedMotion });
  latest.current = { config, size, speaking, interactive, reducedMotion };
  React.useEffect(() => {
    installStyleSheet("wand-plush-avatar-styles", styles);
    const node = canvas.current;
    if (!node) return;
    let alive = true;
    const attach = () => {
      loadRuntime().then(runtime => {
        if (!alive) return;
        handle.current = runtime.attach(node, latest.current, (next, state) => {
          if (alive) { setRenderer(next); setActivity(state); }
        });
      }, () => { if (alive) { setRenderer("fallback"); setActivity("fallback"); } });
    };
    // Hidden lists do not download WebGL or acquire a context until an avatar becomes visible.
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); attach(); }
    }, { rootMargin: "48px" });
    observer.observe(node);
    return () => { alive = false; observer.disconnect(); handle.current?.dispose(); handle.current = null; };
  }, []);
  React.useEffect(() => { handle.current?.update(latest.current); }, [configKey, size, speaking, interactive, reducedMotion]);
  return <span className={`wand-plush-avatar ${className}`.trim()} data-plush-avatar="" data-avatar-config={configKey}
    data-renderer={renderer} data-render-state={activity} title={renderer === "fallback" ? "静态头像 · 3D 暂不可用" : undefined}
    aria-hidden="true" style={{ width: size, height: size }}>
    <PlushFallback config={config}/><canvas ref={canvas} width={size} height={size}/>
  </span>;
}
