/** Shared browser diagnostics transport. Never wraps/replays business requests. */
import { feedbackFeatureForApiPath } from "../feedback-feature-map.js";
import type { FeedbackFeature } from "../feedback.js";
export type ClientFeedbackFeature = FeedbackFeature;

/** Routing semantics from known API families; never inspect error text or upload a URL. */
export function feedbackFeatureForPath(url: string): ClientFeedbackFeature {
  let pathname: string;
  try { pathname = new URL(url, "https://wand.invalid").pathname; } catch { return "api"; }
  return feedbackFeatureForApiPath(pathname);
}

export type ClientFeedbackEvent = "update_failed" | "http_5xx" | "websocket_error" | "uncaught_exception" | "unhandled_rejection" | "startup_failed";
interface FeedbackRuntime {
  ready(): boolean;
  version(): string;
  secure(): boolean;
  fetch: typeof fetch;
}
let runtime: FeedbackRuntime | null = null;
const seen = new Map<string, number>();
let inFlight = 0;

export function configureClientFeedback(value: FeedbackRuntime): void { runtime = value; }

function bounded(text: string, bytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= bytes) return text;
  // Avoid a partial UTF-8 codepoint and keep within the shared protocol's byte limits.
  return new TextDecoder().decode(encoder.encode(text).subarray(0, bytes - 3)).replace(/\uFFFD$/, "") + "…";
}
function clean(text: string, max: number): string {
  return bounded(text.replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [REDACTED]")
    .replace(/((?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/(["']?(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;\r\n}]+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@"), max);
}

/** Accept only real errors or error strings, never stringify arbitrary response/request objects. */
export function reportClientError(event: ClientFeedbackEvent, error: unknown, feature?: ClientFeedbackFeature): void {
  try {
    const current = runtime;
    if (!current || !current.ready() || !current.secure() || inFlight >= 2) return;
    if (!(error instanceof Error) && typeof error !== "string") return;
    if (error instanceof Error && (error.name === "AbortError" || error.name === "CancellationError")) return;
    const name = error instanceof Error ? error.name : "Error";
    const owner = feature ?? (event === "update_failed" ? "server_update" : event === "websocket_error" ? "realtime" : event === "http_5xx" ? "api" : event === "startup_failed" ? "startup" : "runtime");
    const fingerprint = `${owner}:${event}:${name}`;
    const now = Date.now();
    if (now - (seen.get(fingerprint) ?? 0) < 5 * 60_000) return;
    if (seen.size >= 32) seen.delete(seen.keys().next().value!);
    seen.set(fingerprint, now);
    const version = current.version();
    const body = { schema: 1, source: "web", event, feature: owner,
      version: /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,80})?$/.test(version) ? version : "0.0.0",
      error: { name: clean(name, 128), message: clean(error instanceof Error ? error.message : error, 8192),
        stack: clean(error instanceof Error ? error.stack ?? "" : "", 16384) } };
    if (new TextEncoder().encode(JSON.stringify(body)).length > 32768) return;
    inFlight++;
    // Raw fetch intentionally bypasses the normal HTTP error adapter (no recursive feedback).
    void Promise.resolve().then(() => current.fetch("/api/feedback/client", { method: "POST", credentials: "same-origin", redirect: "error",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) }))
      .then(response => response.body?.cancel()).catch(() => {}).finally(() => { inFlight--; });
  } catch { /* No diagnostics failure may escape into the UI. */ }
}

export function installClientFeedbackHandlers(target: Window): () => void {
  const onError = (event: ErrorEvent) => { if (event.error instanceof Error) reportClientError("uncaught_exception", event.error); };
  const onRejection = (event: PromiseRejectionEvent) => reportClientError("unhandled_rejection", event.reason);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => { target.removeEventListener("error", onError); target.removeEventListener("unhandledrejection", onRejection); };
}
