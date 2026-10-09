import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildChildEnv, systemEnvValue } from "./env-utils.js";
import { SPEECH_MODELS, speechModel, speechModelUrl, type SpeechModel } from "./speech-models.js";
import { SPEECH_MAX_SECONDS, SPEECH_MAX_WAV_BYTES, SPEECH_SAMPLE_RATE, type SpeechBackend, type SpeechResult, type SpeechSettings, type SpeechStatus } from "./speech-types.js";
import type { WandStorage } from "./storage.js";

export const SPEECH_SETTINGS_KEY = "pref:speechRecognition";
export class SpeechError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}
export function defaultSpeechSettings(): SpeechSettings {
  return { enabled: false, model: "base", acceleration: "auto", language: "auto", threads: Math.max(1, Math.min(4, os.availableParallelism() - 1)) };
}
export function parseSpeechSettings(value: unknown, previous = defaultSpeechSettings()): SpeechSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SpeechError("INVALID_SETTINGS", "语音配置无效。");
  const patch = value as Record<string, unknown>;
  if (Object.keys(patch).some((key) => !["enabled", "model", "acceleration", "language", "threads"].includes(key))) {
    throw new SpeechError("INVALID_SETTINGS", "不支持的语音配置项。");
  }
  const settings = { ...previous, ...patch } as SpeechSettings;
  if (typeof settings.enabled !== "boolean" || !speechModel(settings.model)
    || !["auto", "cpu", "gpu"].includes(settings.acceleration) || !["auto", "zh", "en"].includes(settings.language)
    || !Number.isInteger(settings.threads) || settings.threads < 1 || settings.threads > 16) {
    throw new SpeechError("INVALID_SETTINGS", "请选择有效模型、运行设备、语言与 1–16 个 CPU 线程。");
  }
  return settings;
}

/** Strict canonical WAV; all clients encode this exact shape. No decoder/ffmpeg needed on the host. */
export function validateSpeechWav(audio: Buffer): { samples: number; silent: boolean } {
  if (audio.length < 44 + 3200 || audio.length > SPEECH_MAX_WAV_BYTES
    || audio.toString("ascii", 0, 4) !== "RIFF" || audio.readUInt32LE(4) !== audio.length - 8
    || audio.toString("ascii", 8, 12) !== "WAVE" || audio.toString("ascii", 12, 16) !== "fmt "
    || audio.readUInt32LE(16) !== 16 || audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1
    || audio.readUInt32LE(24) !== SPEECH_SAMPLE_RATE || audio.readUInt32LE(28) !== SPEECH_SAMPLE_RATE * 2
    || audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16
    || audio.toString("ascii", 36, 40) !== "data" || audio.readUInt32LE(40) !== audio.length - 44
    || (audio.length - 44) % 2 !== 0) {
    throw new SpeechError("INVALID_AUDIO", "请上传 0.1–60 秒、16 kHz 单声道 PCM16 WAV 音频。");
  }
  let peak = 0;
  for (let offset = 44; offset < audio.length; offset += 2) peak = Math.max(peak, Math.abs(audio.readInt16LE(offset)));
  return { samples: (audio.length - 44) / 2, silent: peak < 160 };
}

async function fileHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export interface SpeechServiceOptions {
  /** Trusted deployment configuration only, never HTTP request input. */
  executable?: string;
  backend?: SpeechBackend;
  fetch?: typeof fetch;
  timeoutMs?: number;
  models?: readonly SpeechModel[];
}

/** A single bounded job per host avoids CPU/RAM amplification. Audio is temporary, never history. */
export class SpeechService {
  private readonly root: string;
  private readonly models: readonly SpeechModel[];
  private readonly verified = new Map<string, string>();
  private readonly verifying = new Map<string, Promise<boolean>>();
  private download: SpeechStatus["download"] = null;
  private downloadAbort: AbortController | null = null;
  private active: AbortController | null = null;
  private disposed = false;
  private maintenance = false;
  private readonly initialized = new Set<string>();
  private configurationRevision = 0;

  constructor(private readonly storage: Pick<WandStorage, "getPreference" | "setPreference">, configDir: string,
    private readonly options: SpeechServiceOptions = {}) {
    this.root = path.join(configDir, "speech");
    this.models = options.models ?? SPEECH_MODELS;
  }

  settings(): SpeechSettings {
    try { return parseSpeechSettings(this.storage.getPreference(SPEECH_SETTINGS_KEY, {})); }
    catch { return defaultSpeechSettings(); }
  }
  configure(patch: unknown): SpeechSettings {
    const settings = parseSpeechSettings(patch, this.settings());
    this.storage.setPreference(SPEECH_SETTINGS_KEY, settings);
    this.configurationRevision += 1;
    return settings;
  }
  settingsRevision(): number { return this.configurationRevision; }
  acquireMaintenance(): void {
    if (this.disposed) throw new SpeechError("UNAVAILABLE", "语音服务已关闭。", 503);
    if (this.active || this.downloadAbort || this.maintenance) throw new SpeechError("BUSY", "语音识别或模型下载正在进行，请稍后初始化。", 409);
    this.maintenance = true;
  }
  releaseMaintenance(): void { this.maintenance = false; }

  /** Explicit admin health check loads the selected model using synthetic silence, without enabling it. */
  async initializeModel(id: string, signal: AbortSignal, acceleration = this.settings().acceleration): Promise<void> {
    const model = this.models.find((value) => value.id === id);
    if (!model) throw new SpeechError("INVALID_MODEL", "模型不存在。");
    const runtime = await this.runtime();
    if (!runtime.executable || !await this.modelReady(model)) throw new SpeechError("NOT_READY", "请先下载模型并安装语音运行时。", 503);
    signal.throwIfAborted();
    await mkdir(path.join(this.root, "tmp"), { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(this.root, "tmp", "check-"));
    try {
      const wav = Buffer.alloc(8044); wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
      wav.write("data", 36); wav.writeUInt32LE(8000, 40);
      const input = path.join(directory, "check.wav"), output = path.join(directory, "check");
      await writeFile(input, wav, { mode: 0o600 });
      const args = ["-m", this.modelPath(model), "-f", input, "-of", output, "-otxt", "-nt", "-l", "en", "-t", String(this.settings().threads)];
      const cpu = acceleration === "cpu" || runtime.backend === "cpu";
      try {
        await this.run(runtime.executable, [...args, ...(cpu ? ["-ng"] : [])], directory, signal, this.options.timeoutMs ?? 120_000);
      } catch (error) {
        if (acceleration !== "auto" || cpu || signal.aborted || !(error instanceof SpeechError) || error.code !== "ENGINE_FAILED") throw error;
        await this.run(runtime.executable, [...args, "-ng"], directory, signal, this.options.timeoutMs ?? 120_000);
      }
      signal.throwIfAborted();
      if (this.disposed) throw new SpeechError("UNAVAILABLE", "语音服务已关闭。", 503);
      this.initialized.add(id);
    } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  }
  private modelPath(model: SpeechModel): string { return path.join(this.root, "models", `ggml-${model.id}.bin`); }

  private async modelReady(model: SpeechModel): Promise<boolean> {
    if (this.verifying.has(model.id)) return this.verifying.get(model.id)!;
    const promise = this.verifyModel(model);
    this.verifying.set(model.id, promise);
    try { return await promise; } finally { this.verifying.delete(model.id); }
  }
  private async verifyModel(model: SpeechModel): Promise<boolean> {
    try {
      const file = this.modelPath(model);
      const info = await stat(file);
      if (!info.isFile() || info.size !== model.size) return false;
      const key = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (this.verified.get(model.id) === key) return true;
      if (await fileHash(file) !== model.sha256) return false;
      this.verified.set(model.id, key);
      return true;
    } catch { return false; }
  }

  private async runtime(): Promise<{ executable: string | null; backend: SpeechBackend }> {
    let backend = this.options.backend ?? systemEnvValue("WAND_WHISPER_BACKEND");
    if (!backend) {
      try { backend = JSON.parse(await readFile(path.join(this.root, "runtime.json"), "utf8")).backend; } catch {}
    }
    if (!["cpu", "metal", "cuda"].includes(backend ?? "")) backend = process.platform === "darwin" ? "metal" : "cpu";
    const name = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
    const explicit = this.options.executable ?? systemEnvValue("WAND_WHISPER_BIN");
    // Explicit bad paths must not silently run another binary. No shell, no request-provided command.
    const candidates = explicit ? [explicit] : [path.join(this.root, "bin", name),
      ...(buildChildEnv(true).PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name))];
    for (const candidate of candidates) {
      if (!path.isAbsolute(candidate)) continue;
      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        if ((await stat(candidate)).isFile()) return { executable: candidate, backend: backend as SpeechBackend };
      } catch {}
    }
    return { executable: null, backend: backend as SpeechBackend };
  }

  async status(): Promise<SpeechStatus> {
    const settings = this.settings();
    const runtime = await this.runtime();
    const models = await Promise.all(this.models.map(async (model) => ({ id: model.id, label: model.label,
      description: model.description, size: model.size, downloaded: await this.modelReady(model) })));
    const reason = this.disposed ? "语音服务已关闭。" : this.maintenance ? "语音运行时正在初始化，请稍后重试。" : !settings.enabled ? "服务端识别未启用，请在管理设置中启用。"
      : !runtime.executable ? "服务端尚未安装 whisper.cpp，请在服务器运行语音运行时安装脚本。"
      : !models.find((model) => model.id === settings.model)?.downloaded ? "服务端模型尚未下载或校验失败，请在管理设置中下载。"
      : settings.acceleration === "gpu" && runtime.backend === "cpu" ? "当前运行时是 CPU 版，请改为自动 / CPU 或安装 GPU 版。" : null;
    return { settings, ready: !reason, reason, runtime: { available: !!runtime.executable, backend: runtime.backend,
      platform: process.platform, arch: process.arch }, models, download: this.download ? { ...this.download } : null,
      maxDurationSeconds: SPEECH_MAX_SECONDS, busy: !!this.active || this.maintenance, initialized: this.initialized.has(settings.model) };
  }

  cancelDownload(): void { this.downloadAbort?.abort(); }

  async startDownload(id: string): Promise<void> {
    const model = this.models.find((item) => item.id === id);
    if (!model) throw new SpeechError("INVALID_MODEL", "模型不存在。");
    if (this.disposed) throw new SpeechError("UNAVAILABLE", "语音服务已关闭。", 503);
    if (this.maintenance) throw new SpeechError("BUSY", "语音运行时正在初始化，请稍后下载。", 409);
    if (this.downloadAbort) throw new SpeechError("DOWNLOAD_BUSY", "已有模型正在下载。", 409);
    if (await this.modelReady(model)) return;
    // Recheck after asynchronous verification, before reserving the only download slot.
    if (this.disposed) throw new SpeechError("UNAVAILABLE", "语音服务已关闭。", 503);
    if (this.downloadAbort) throw new SpeechError("DOWNLOAD_BUSY", "已有模型正在下载。", 409);
    const abort = new AbortController();
    this.downloadAbort = abort;
    this.download = { model: model.id, received: 0, total: model.size, phase: "downloading" };
    void this.downloadModel(model, abort).finally(() => { if (this.downloadAbort === abort) this.downloadAbort = null; });
  }
  private async downloadModel(model: SpeechModel, abort: AbortController): Promise<void> {
    const destination = this.modelPath(model);
    const partial = `${destination}.part`;
    const timer = setTimeout(() => abort.abort(), 30 * 60_000);
    timer.unref();
    try {
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const response = await (this.options.fetch ?? fetch)(speechModelUrl(model), { signal: abort.signal });
      if (!response.ok || !response.body) throw new Error("download");
      const declared = response.headers.get("content-length");
      if (declared && Number(declared) !== model.size) { await response.body.cancel(); throw new Error("size"); }
      const file = await open(partial, "w", 0o600);
      const hash = createHash("sha256");
      let received = 0;
      try {
        for await (const chunk of response.body) {
          if (abort.signal.aborted) throw new Error("cancelled");
          received += chunk.length;
          if (received > model.size) throw new Error("size");
          hash.update(chunk);
          // FileHandle.write may be partial: writeFile writes the entire bounded chunk at current position.
          await file.writeFile(chunk);
          this.download = { model: model.id, received, total: model.size, phase: "downloading" };
        }
      } finally { await file.close(); }
      if (abort.signal.aborted || received !== model.size || hash.digest("hex") !== model.sha256) throw new Error("integrity");
      await rename(partial, destination);
      this.verified.delete(model.id);
      await this.modelReady(model);
      this.download = null;
    } catch {
      await rm(partial, { force: true }).catch(() => {});
      this.download = { model: model.id, received: 0, total: model.size, phase: "failed", error: "模型下载失败或完整性校验未通过，请检查网络后重试。" };
    } finally { clearTimeout(timer); }
  }

  async transcribe(audio: Buffer, signal?: AbortSignal): Promise<SpeechResult> {
    const { silent } = validateSpeechWav(audio);
    if (signal?.aborted) throw new SpeechError("CANCELLED", "识别已取消。", 499);
    if (this.disposed) throw new SpeechError("UNAVAILABLE", "语音服务已关闭。", 503);
    if (this.active || this.maintenance) throw new SpeechError("BUSY", "服务端正在识别或初始化，请稍后重试。", 429);
    const abort = new AbortController();
    this.active = abort;
    const cancel = (): void => abort.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    let directory: string | null = null;
    try {
      const settings = this.settings();
      const model = this.models.find((item) => item.id === settings.model)!;
      const runtime = await this.runtime();
      if (!settings.enabled || !runtime.executable || !await this.modelReady(model)) {
        throw new SpeechError("NOT_READY", "服务端语音识别未就绪，请先启用并安装运行时、下载模型。", 503);
      }
      if (settings.acceleration === "gpu" && runtime.backend === "cpu") throw new SpeechError("NO_GPU", "当前是 CPU 运行时，请改为自动或 CPU。", 503);
      if (abort.signal.aborted) throw new SpeechError("CANCELLED", "识别已取消。", 499);
      let backend = settings.acceleration === "cpu" ? "cpu" as const : runtime.backend;
      if (silent) return { text: "", model: model.id, backend };
      await mkdir(path.join(this.root, "tmp"), { recursive: true, mode: 0o700 });
      directory = await mkdtemp(path.join(this.root, "tmp", "voice-"));
      const wav = path.join(directory, "audio.wav");
      await writeFile(wav, audio, { mode: 0o600 });
      const output = path.join(directory, "transcript");
      // Whisper's fixed initial vocabulary biases domain words and Simplified Chinese,
      // without rewriting the transcript or reading any private draft/history as context.
      const context = settings.language === "en" ? "Wand, code, Git, API."
        : "Wand, code, Git, API, 代码, 语音识别, 服务端, 客户端, 任务, 工作区。";
      const args = ["-m", this.modelPath(model), "-f", wav, "-of", output, "-otxt", "-nt", "-l", settings.language, "-t", String(settings.threads), "--prompt", context];
      const started = Date.now();
      const timeout = this.options.timeoutMs ?? 120_000;
      try { await this.run(runtime.executable, [...args, ...(backend === "cpu" ? ["-ng"] : [])], directory, abort.signal, timeout); }
      catch (error) {
        if (settings.acceleration !== "auto" || backend === "cpu" || abort.signal.aborted
          || !(error instanceof SpeechError) || error.code !== "ENGINE_FAILED") throw error;
        // Only local inference is retried, never a message send. Explicit GPU selection does not fallback.
        backend = "cpu";
        await rm(`${output}.txt`, { force: true });
        const remaining = timeout - (Date.now() - started);
        if (remaining <= 0) throw new SpeechError("TIMEOUT", "服务端识别超时，请选择较小模型。", 504);
        await this.run(runtime.executable, [...args, "-ng"], directory, abort.signal, remaining);
      }
      const resultFile = `${output}.txt`;
      if ((await stat(resultFile)).size > 32_768) throw new SpeechError("INVALID_RESULT", "语音识别结果异常。", 502);
      const text = (await readFile(resultFile, "utf8")).trim();
      if (text.length > 8_000 || text.includes("\0")) throw new SpeechError("INVALID_RESULT", "语音识别结果异常。", 502);
      if (abort.signal.aborted) throw new SpeechError("CANCELLED", "识别已取消。", 499);
      return { text, model: model.id, backend };
    } catch (error) {
      if (error instanceof SpeechError) throw error;
      throw new SpeechError("ENGINE_FAILED", "服务端语音识别失败，请检查运行时、模型与可用磁盘。", 503);
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      signal?.removeEventListener("abort", cancel);
      if (this.active === abort) this.active = null;
    }
  }

  private run(executable: string, args: string[], cwd: string, signal: AbortSignal, timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new SpeechError("CANCELLED", "识别已取消。", 499)); return; }
      const child = spawn(executable, args, { cwd, env: buildChildEnv(false, {
        LD_LIBRARY_PATH: systemEnvValue("LD_LIBRARY_PATH"), DYLD_LIBRARY_PATH: systemEnvValue("DYLD_LIBRARY_PATH"),
        CUDA_VISIBLE_DEVICES: systemEnvValue("CUDA_VISIBLE_DEVICES"),
      }), stdio: "ignore", windowsHide: true });
      let failure: SpeechError | null = null;
      let killTimer: NodeJS.Timeout | undefined;
      const stop = (error: SpeechError): void => {
        failure ??= error;
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
        killTimer.unref();
      };
      const cancel = (): void => stop(new SpeechError("CANCELLED", "识别已取消。", 499));
      signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => stop(new SpeechError("TIMEOUT", "服务端识别超时，请选择较小模型。", 504)), timeout);
      timer.unref();
      child.once("error", () => { failure = new SpeechError("ENGINE_FAILED", "无法启动服务端语音运行时，请检查安装。", 503); });
      child.once("close", (code) => {
        signal.removeEventListener("abort", cancel);
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (failure) reject(failure);
        else if (code !== 0) reject(new SpeechError("ENGINE_FAILED", "服务端识别失败，请尝试 CPU 或较小模型。", 502));
        else resolve();
      });
    });
  }
  dispose(): void { this.disposed = true; this.downloadAbort?.abort(); this.active?.abort(); }
}
