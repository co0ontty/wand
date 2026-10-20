// Dependency-free: the detached updater copies the compiled module before replacing Wand.
import { constants, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_FEEDBACK_URL = "https://feedback.huniu.fun:8443";
export const FEEDBACK_EVENTS = ["update_failed", "provider_update_failed", "daemon_update_failed", "uncaught_exception", "unhandled_rejection", "http_5xx", "websocket_error", "startup_failed"] as const;
export type FeedbackEvent = typeof FEEDBACK_EVENTS[number];
const ALGORITHM = "RSA-OAEP-256+A256GCM";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,80})?$/;
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "AggregateError", "AbortError", "TimeoutError", "HttpError", "PortInUseError"]);
const ERROR_CODES = new Set(["EACCES", "EPERM", "ENOENT", "ENOSPC", "EMFILE", "ENFILE", "EIO", "EROFS", "ENOMEM", "EADDRINUSE", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "ERR_MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED", "ERR_WORKER_OUT_OF_MEMORY", "SQLITE_ERROR", "SQLITE_BUSY", "SQLITE_FULL", "SQLITE_CORRUPT", "SQLITE_READONLY", "SQLITE_CANTOPEN"]);
const PLATFORMS = new Set(["aix", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32", "android", "unknown"]);
const ARCHES = new Set(["arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc", "ppc64", "riscv64", "s390", "s390x", "x64", "unknown"]);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FEEDBACK_CLIENT_SOURCES = ["web", "macos", "android", "ios"] as const;
export type FeedbackClientSource = typeof FEEDBACK_CLIENT_SOURCES[number];
/** Stable semantic owners, not error-text classification or user-controlled URLs. */
export const FEEDBACK_FEATURE_LABELS = {
  app_update: "应用更新", server_update: "服务端更新", provider_update: "CLI 工具更新", daemon_update: "底层组件更新",
  api: "接口请求", sessions: "会话", conversations: "对话", tasks: "任务", files: "文件",
  settings: "设置", models: "模型", authentication: "登录认证", realtime: "实时连接", runtime: "系统运行",
  startup: "服务启动", storage: "存储", repository: "代码仓库",
} as const;
export type FeedbackFeature = keyof typeof FEEDBACK_FEATURE_LABELS;
export function isFeedbackFeature(value: unknown): value is FeedbackFeature {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(FEEDBACK_FEATURE_LABELS, value);
}
export function defaultFeedbackFeature(event: FeedbackEvent, source: FeedbackReport["source"] = "server"): FeedbackFeature {
  switch (event) {
    case "update_failed": return source === "server" || source === "web" ? "server_update" : "app_update";
    case "provider_update_failed": return "provider_update";
    case "daemon_update_failed": return "daemon_update";
    case "http_5xx": return "api";
    case "websocket_error": return "realtime";
    case "startup_failed": return "startup";
    default: return "runtime";
  }
}
function feedbackUsername(name: string | undefined): string {
  // Same 24-character display-name boundary as user-profile.ts; never use os.userInfo().
  return (name ?? "").trim().replace(/[\r\n\t\x00-\x1f\x7f]/g, " ").slice(0, 24).trim() || "我";
}
export interface ClientFeedback {
  schema: 1;
  source: FeedbackClientSource;
  event: FeedbackEvent;
  version: string;
  feature?: FeedbackFeature;
  error: { name: string; code?: string; message: string; stack?: string };
}

function byteLimit(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= max ? text : bytes.subarray(0, max - 3).toString("utf8").replace(/\uFFFD$/, "") + "…";
}
/** Preserve diagnostic text while removing credentials, never serialize arbitrary error properties. */
export function sanitizeFeedbackText(text: string, secrets: readonly string[] = [], maxBytes = 8192): string {
  let safe = text;
  for (const secret of secrets.filter(s => s.length > 0).sort((a, b) => b.length - a.length).slice(0, 256)) {
    safe = safe.split(secret).join("[REDACTED]");
  }
  safe = safe
    .replace(/\bwl[pt]_[A-Za-z0-9_-]{43}\b/g, "[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [REDACTED]")
    .replace(/((?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/((?:["']?)(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|app[_-]?token|app[_-]?secret|client[_-]?secret|token|secret)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;\r\n}]+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
  return byteLimit(safe, maxBytes);
}

export function parseClientFeedback(input: unknown): ClientFeedback {
  const r = record(input), e = record(r.error);
  exactKeys(r, ["schema", "source", "event", "version", "error", ...(r.feature === undefined ? [] : ["feature"])]);
  const allowed = ["name", "message", ...(e.code === undefined ? [] : ["code"]), ...(e.stack === undefined ? [] : ["stack"])];
  exactKeys(e, allowed);
  if (r.schema !== 1 || !FEEDBACK_CLIENT_SOURCES.includes(r.source as FeedbackClientSource)
    || !FEEDBACK_EVENTS.includes(r.event as FeedbackEvent) || typeof r.version !== "string" || !VERSION.test(r.version)
    || typeof e.name !== "string" || !e.name || typeof e.message !== "string"
    || (r.feature !== undefined && !isFeedbackFeature(r.feature))
    || (e.code !== undefined && typeof e.code !== "string") || (e.stack !== undefined && typeof e.stack !== "string")) throw new Error("Invalid client feedback");
  if (Buffer.byteLength(e.name) > 128 || Buffer.byteLength(e.message) > 8192 || Buffer.byteLength((e.code ?? "") as string) > 128
    || Buffer.byteLength((e.stack ?? "") as string) > 16384 || Buffer.byteLength(JSON.stringify(r)) > 32768) throw new RangeError("Feedback too large");
  return input as ClientFeedback;
}

export interface FeedbackReport {
  schema: 1;
  id: string;
  occurredAt: string;
  event: FeedbackEvent;
  version: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  source: "server" | FeedbackClientSource;
  clientVersion: string | null;
  username: string;
  feature: FeedbackFeature;
  error: { name: string; code: string; frames: string[]; message: string; stack: string };
}
export interface FeedbackEnvelope {
  schema: 1;
  algorithm: typeof ALGORITHM;
  keyId: string;
  wrappedKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function rsaKey(key: KeyObject): KeyObject {
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== "rsa" || bits < 2048 || bits > 4096) throw new Error("Feedback requires a 2048–4096 bit RSA key");
  return key;
}
export function feedbackKeyId(key: KeyObject): string {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
}

/** Only explicit diagnostic fields are serialized; raw messages/stacks are retained, credentials removed. */
export function createFeedbackReport(event: FeedbackEvent, version: string, error?: unknown, secrets: readonly string[] = []): FeedbackReport {
  const value = error instanceof Error ? error as NodeJS.ErrnoException : null;
  const frames: string[] = [];
  for (const line of (value?.stack ?? "").split("\n").slice(1, 20)) {
    const match = line.match(/(?:\(|\s)(?:file:\/\/)?([^()]+\/[a-zA-Z0-9_-]+\.(?:js|ts)):(\d{1,7}):(\d{1,5})\)?$/);
    if (!match || path.dirname(match[1]!) !== MODULE_DIR) continue;
    frames.push(`${path.basename(match[1]!)}:${match[2]}:${match[3]}`);
    if (frames.length === 5) break;
  }
  return {
    schema: 1, id: randomUUID(), occurredAt: new Date().toISOString(), event,
    version: VERSION.test(version) ? version : "0.0.0", nodeVersion: process.versions.node,
    platform: PLATFORMS.has(process.platform) ? process.platform : "unknown",
    arch: ARCHES.has(process.arch) ? process.arch : "unknown",
    source: "server", clientVersion: null, username: "我", feature: defaultFeedbackFeature(event),
    error: { name: value && ERROR_NAMES.has(value.name) ? value.name : "Error",
      code: value?.code && ERROR_CODES.has(value.code) ? value.code : "UNKNOWN", frames,
      message: sanitizeFeedbackText(value?.message ?? (typeof error === "string" ? error : ""), secrets),
      stack: sanitizeFeedbackText(value?.stack ?? "", secrets, 16384) },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid feedback");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join() !== keys.sort().join()) throw new Error("Invalid feedback fields");
}
export function validateFeedbackReport(input: unknown): FeedbackReport {
  const r = record(input), e = record(r.error);
  exactKeys(r, ["schema", "id", "occurredAt", "event", "version", "nodeVersion", "platform", "arch", "source", "clientVersion", "username", "feature", "error"]);
  exactKeys(e, ["name", "code", "frames", "message", "stack"]);
  if (r.schema !== 1 || typeof r.id !== "string" || !UUID.test(r.id)
    || typeof r.occurredAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.occurredAt) || !Number.isFinite(Date.parse(r.occurredAt))
    || !FEEDBACK_EVENTS.includes(r.event as FeedbackEvent)
    || typeof r.version !== "string" || !VERSION.test(r.version)
    || typeof r.nodeVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(r.nodeVersion)
    || !PLATFORMS.has(r.platform as string) || !ARCHES.has(r.arch as string)
    || !(r.source === "server" || FEEDBACK_CLIENT_SOURCES.includes(r.source as FeedbackClientSource))
    || !(r.clientVersion === null || (typeof r.clientVersion === "string" && VERSION.test(r.clientVersion)))
    || typeof r.username !== "string" || !r.username || r.username.length > 24 || r.username !== feedbackUsername(r.username)
    || !isFeedbackFeature(r.feature)
    || typeof e.name !== "string" || Buffer.byteLength(e.name) > 128 || typeof e.code !== "string" || Buffer.byteLength(e.code) > 128
    || typeof e.message !== "string" || Buffer.byteLength(e.message) > 8192 || typeof e.stack !== "string" || Buffer.byteLength(e.stack) > 16384
    || !Array.isArray(e.frames) || e.frames.length > 5
    || e.frames.some(f => typeof f !== "string" || !/^[a-zA-Z0-9_-]{1,100}\.(?:js|ts):\d{1,7}:\d{1,5}$/.test(f))) throw new Error("Invalid feedback report");
  if (Buffer.byteLength(JSON.stringify(input)) > 32768) throw new Error("Feedback report too large");
  return input as FeedbackReport;
}

function decode(value: unknown, min: number, max = min): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("Invalid ciphertext");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < min || bytes.length > max || bytes.toString("base64") !== value) throw new Error("Invalid ciphertext");
  return bytes;
}
export function encryptFeedback(report: FeedbackReport, publicKey: KeyObject): FeedbackEnvelope {
  validateFeedbackReport(report);
  rsaKey(publicKey);
  const key = randomBytes(32), iv = randomBytes(12), keyId = feedbackKeyId(publicKey);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`wand-feedback:1:${keyId}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(report), "utf8"), cipher.final()]);
  const wrappedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  return { schema: 1, algorithm: ALGORITHM, keyId, wrappedKey: wrappedKey.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}
export function decryptFeedback(input: unknown, privateKey: KeyObject): FeedbackReport {
  const e = record(input);
  exactKeys(e, ["schema", "algorithm", "keyId", "wrappedKey", "iv", "tag", "ciphertext"]);
  if (e.schema !== 1 || e.algorithm !== ALGORITHM || e.keyId !== feedbackKeyId(privateKey)) throw new Error("Invalid feedback key");
  const key = privateDecrypt({ key: rsaKey(privateKey), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, decode(e.wrappedKey, 256, 512));
  const decipher = createDecipheriv("aes-256-gcm", key, decode(e.iv, 12));
  decipher.setAAD(Buffer.from(`wand-feedback:1:${e.keyId}`));
  decipher.setAuthTag(decode(e.tag, 16));
  const plaintext = Buffer.concat([decipher.update(decode(e.ciphertext, 1, 32768)), decipher.final()]);
  return validateFeedbackReport(JSON.parse(plaintext.toString("utf8")));
}

function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, data, { mode: 0o600, flag: "wx" }); renameSync(tmp, file); }
  finally { try { unlinkSync(tmp); } catch { /* already renamed */ } }
}
function reportFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => UUID.test(name.replace(/\.json$/, "")) && name.endsWith(".json"));
}

export class FeedbackReporter {
  private key: KeyObject | null = null;
  private pending: FeedbackReport[] = [];
  private seen = new Map<string, number>();
  private flight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private controller = new AbortController();
  private stopped = false;
  private dir: string;
  private url: URL;
  private enabled: boolean;
  private failures = 0;
  private nextAttempt = 0;
  constructor(private options: { configDir: string; version: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; secrets?: () => readonly string[]; username?: () => string }) {
    const env = options.env ?? process.env;
    this.enabled = env.WAND_FEEDBACK_ENABLED !== "0" && env.WAND_TEST_MODE !== "1";
    this.url = new URL(DEFAULT_FEEDBACK_URL);
    try {
      const configured = new URL(env.WAND_FEEDBACK_URL || DEFAULT_FEEDBACK_URL);
      if (configured.protocol !== "https:" || configured.username || configured.password || configured.search || configured.hash || configured.pathname !== "/") throw new Error("Invalid origin");
      this.url = configured;
    } catch {
      this.enabled = false;
      console.warn("[wand] Feedback disabled: WAND_FEEDBACK_URL must be an HTTPS origin without credentials.");
    }
    this.dir = path.join(options.configDir, "feedback-outbox", createHash("sha256").update(this.url.origin).digest("hex").slice(0, 16));
    try { this.key = rsaKey(createPublicKey(readFileSync(path.join(this.dir, "public.pem")))); } catch { /* HTTPS bootstrap on flush */ }
  }
  start(): void {
    if (!this.enabled || this.timer || this.stopped) return;
    void this.flush();
    this.timer = setInterval(() => { void this.flush(); }, 60_000);
    this.timer.unref();
  }
  get isEnabled(): boolean { return this.enabled && !this.stopped; }
  /** Never throws. Cached keys allow fatal errors to be encrypted synchronously before exit. */
  capture(event: FeedbackEvent, error?: unknown, feature?: FeedbackFeature, extraSecrets: readonly string[] = []): void {
    if (!this.isEnabled) return;
    try {
      const report = createFeedbackReport(event, this.options.version, error, [...(this.options.secrets?.() ?? []), ...extraSecrets]);
      report.username = feedbackUsername(this.options.username?.());
      if (feature) report.feature = feature;
      this.enqueue(report);
    }
    catch { /* Never affect the original error. */ }
  }
  captureClient(input: ClientFeedback, secrets: readonly string[] = []): boolean {
    if (!this.isEnabled) return false;
    try {
      const allSecrets = [...(this.options.secrets?.() ?? []), ...secrets];
      const report = createFeedbackReport(input.event, this.options.version);
      report.source = input.source; report.clientVersion = input.version;
      report.username = feedbackUsername(this.options.username?.());
      report.feature = input.feature ?? defaultFeedbackFeature(input.event, input.source);
      report.error = { name: sanitizeFeedbackText(input.error.name, allSecrets, 128), code: sanitizeFeedbackText(input.error.code ?? "UNKNOWN", allSecrets, 128), frames: [],
        message: sanitizeFeedbackText(input.error.message, allSecrets), stack: sanitizeFeedbackText(input.error.stack ?? "", allSecrets, 16384) };
      return this.enqueue(report);
    } catch { return false; /* Best effort; never repeat a client business operation. */ }
  }
  private enqueue(report: FeedbackReport): boolean {
    try {
      const fingerprint = `${report.username}:${report.source}:${report.feature}:${report.event}:${report.error.name}:${report.error.code}`;
      const now = Date.now();
      if (now - (this.seen.get(fingerprint) ?? 0) < 5 * 60_000) return true;
      if (this.key) { if (!this.persist(report)) return false; }
      else if (this.pending.length < 20) this.pending.push(report);
      else return false;
      if (this.seen.size >= 128) this.seen.delete(this.seen.keys().next().value!);
      this.seen.set(fingerprint, now);
      void this.flush();
      return true;
    } catch { return false; /* Reporting must not change application behavior or recursively report itself. */ }
  }
  private persist(report: FeedbackReport): boolean {
    privateDir(this.dir);
    if (reportFiles(this.dir).length >= 100) return false;
    atomicWrite(path.join(this.dir, `${report.id}.json`), JSON.stringify(encryptFeedback(report, this.key!)));
    return true;
  }
  flush(): Promise<void> {
    if (!this.enabled || this.stopped || Date.now() < this.nextAttempt) return Promise.resolve();
    if (this.flight) return this.flight;
    this.flight = this.drain().then(() => { this.failures = 0; this.nextAttempt = 0; }).catch(() => {
      this.nextAttempt = Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(this.failures++, 5));
    }).finally(() => { this.flight = null; });
    return this.flight;
  }
  private async request(route: string, init?: RequestInit): Promise<Response> {
    return (this.options.fetch ?? fetch)(new URL(route, this.url), { ...init, redirect: "error",
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(3000)]) });
  }
  private async drain(): Promise<void> {
    if (!this.key) {
      const response = await this.request("/api/feedback/key");
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Feedback key unavailable"); }
      // Bound decoded response bytes, including chunked/compressed responses.
      const reader = response.body.getReader();
      let bytes = Buffer.alloc(0);
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          if (bytes.length + item.value.length > 8192) throw new Error("Feedback key too large");
          bytes = Buffer.concat([bytes, item.value]);
        }
      } finally { await reader.cancel(); }
      const payload = record(JSON.parse(bytes.toString("utf8")));
      if (payload.schema !== 1 || payload.algorithm !== ALGORITHM || typeof payload.publicKey !== "string") throw new Error("Invalid feedback public key");
      const key = rsaKey(createPublicKey(payload.publicKey));
      if (feedbackKeyId(key) !== payload.keyId) throw new Error("Invalid feedback key id");
      privateDir(this.dir);
      atomicWrite(path.join(this.dir, "public.pem"), key.export({ format: "pem", type: "spki" }).toString());
      this.key = key;
    }
    while (this.pending.length) {
      if (!this.persist(this.pending[0]!)) break;
      this.pending.shift();
    }
    // At most 20 reports per minute/flush; retry ciphertext with the same report id.
    for (const file of reportFiles(this.dir).slice(0, 20)) {
      if (this.stopped) break;
      const target = path.join(this.dir, file);
      if (statSync(target).size > 65536) continue;
      const response = await this.request("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: readFileSync(target, "utf8") });
      await response.body?.cancel();
      if (!response.ok) throw new Error("Feedback delivery unavailable");
      unlinkSync(target);
    }
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
  }
}

export class FeedbackStorageError extends Error {
  constructor(readonly cause: unknown) { super("Feedback storage unavailable"); this.name = "FeedbackStorageError"; }
}

export interface FeedbackSink {
  accept(report: FeedbackReport, envelope: FeedbackEnvelope): "stored" | "duplicate" | "full";
  latest(taskId?: string): Array<{ receivedAt: string; envelope: FeedbackEnvelope }>;
}

/** Explicitly enabled on the collection host only; reports stay encrypted on disk. */
export class FeedbackReceiver {
  readonly privateKey: KeyObject;
  readonly dir: string;
  constructor(configDir: string, privateKeyFile: string, private sink?: FeedbackSink) {
    const mode = statSync(privateKeyFile).mode;
    if (process.platform !== "win32" && (mode & 0o077) !== 0) throw new Error("Feedback private key must be owner-only (chmod 600)");
    this.privateKey = rsaKey(createPrivateKey(readFileSync(privateKeyFile)));
    this.dir = path.join(configDir, "feedback-inbox");
    if (!sink) privateDir(this.dir);
  }
  publicInfo(): object {
    return { schema: 1, algorithm: ALGORITHM, keyId: feedbackKeyId(this.privateKey), publicKey: createPublicKey(this.privateKey).export({ format: "pem", type: "spki" }).toString() };
  }
  accept(envelope: unknown): "stored" | "duplicate" | "full" {
    const report = decryptFeedback(envelope, this.privateKey);
    if (this.sink) {
      try { return this.sink.accept(report, envelope as FeedbackEnvelope); }
      catch (error) { throw new FeedbackStorageError(error); }
    }
    const file = path.join(this.dir, `${report.id}.json`);
    if (existsSync(file)) return "duplicate";
    if (reportFiles(this.dir).length >= 2000) return "full";
    // Validate without persisting plaintext, IP addresses, headers, or identity.
    atomicWrite(file, JSON.stringify({ receivedAt: new Date().toISOString(), envelope }));
    return "stored";
  }
  latest(taskId?: string): Array<{ receivedAt: string; report: FeedbackReport }> {
    if (this.sink) return this.sink.latest(taskId).flatMap(stored => {
      try { return [{ receivedAt: stored.receivedAt, report: decryptFeedback(stored.envelope, this.privateKey) }]; }
      catch { return []; }
    });
    const files = reportFiles(this.dir).map(name => {
      const file = path.join(this.dir, name);
      return { file, mtime: statSync(file).mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime).slice(0, 50);
    return files.flatMap(({ file }) => {
      try {
        if (statSync(file).size > 65536) return [];
        const stored = JSON.parse(readFileSync(file, "utf8"));
        return [{ receivedAt: stored.receivedAt as string, report: decryptFeedback(stored.envelope, this.privateKey) }];
      } catch { return []; } // Old keys/corrupt files are preserved, not silently deleted.
    });
  }
}
