import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { LocalModelSetupService } from "../src/local-model-setup.ts";
import { ModelFileStore } from "../src/model-file-store.ts";
import { DecisionService } from "../src/decision-service.ts";
import { DecisionError, type LocalDecisionConfig } from "../src/decision-types.ts";
import { SpeechService } from "../src/speech-service.ts";
import type { ModelFile } from "../src/laya-model-manifest.ts";
import { SPEECH_MODELS, type SpeechModel } from "../src/speech-models.ts";

const bytes = Buffer.from("fixed model fixture"), hash = createHash("sha256").update(bytes).digest("hex");
const files: ModelFile[] = [{ path: "model.safetensors", size: bytes.length, sha256: hash }];
const speechModel = { ...SPEECH_MODELS[1], size: bytes.length, sha256: hash } as SpeechModel;
function harness(t: TestContext, extras: Record<string, unknown> = {}, speechExtras: ConstructorParameters<typeof SpeechService>[2] = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "wand-model-setup-"));
  const model = path.join(root, "existing"); mkdirSync(model); writeFileSync(path.join(model, files[0]!.path), bytes);
  let config: LocalDecisionConfig = { enabled: false, pythonPath: process.execPath, modelPath: model };
  const decisions = new DecisionService(config, { workerPath: path.resolve("tests/fixtures/decision-worker.mjs"), supported: () => true, timeoutMs: 1500 });
  const pref = new Map();
  const executable = path.join(root, "whisper-cli");
  writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);fs.writeFileSync(args[args.indexOf('-of')+1]+'.txt','');\n`, { mode: 0o700 });
  const speech = new SpeechService({ getPreference: (key, fallback) => pref.get(key) ?? fallback, setPreference: (key, value) => { pref.set(key, value); } }, root,
    { executable, backend: "cpu", models: [speechModel], fetch: (async () => new Response(bytes)) as typeof fetch, ...speechExtras });
  mkdirSync(path.join(root, "speech", "models"), { recursive: true }); writeFileSync(path.join(root, "speech", "models", "ggml-base.bin"), bytes);
  const models = new LocalModelSetupService({ configDir: root, decisions, speech, layaFiles: files, supportedLaya: () => true,
    decisionConfig: () => config, configureDecision: (next) => { decisions.configure(next); config = next; },
    fetch: (async () => new Response(bytes)) as typeof fetch, checkRuntime: async () => true, ...extras });
  t.after(async () => { models.dispose(); speech.dispose(); decisions.dispose(); await new Promise(r => setTimeout(r, 80)); rmSync(root, { recursive: true, force: true }); });
  return { root, model, models, decisions, speech, config: () => config };
}
async function finish(models: LocalModelSetupService, kind: "laya" | "speech") {
  for (let i = 0; i < 200; i += 1) {
    const value = (await models.status())[kind];
    if (value.operation && ["completed", "failed", "cancelled"].includes(value.operation.phase) && !value.busy) return value;
    await new Promise(r => setTimeout(r, 10));
  }
  throw Error("Model setup did not settle");
}

test("model management projects installed resources without paths and rejects command/URL injection", async t => {
  const h = harness(t);
  const status = await h.models.status();
  assert.equal(status.laya.downloaded, true); assert.equal(status.laya.runtimeAvailable, true);
  assert.equal(status.laya.enabled, false); assert.ok(!JSON.stringify(status).includes(h.root));
  for (const raw of [{ model: "../evil" }, { command: "rm" }, { url: "https://evil.test" }, { pythonPath: "/tmp/x" }, { backend: "cuda;rm" }]) {
    assert.throws(() => h.models.start("speech", "initialize", raw), DecisionError);
  }
});

test("LAYA initialization loads existing verified model but never implicitly enables it", async t => {
  const h = harness(t);
  h.models.start("laya", "initialize", {});
  assert.throws(() => h.models.start("laya", "initialize", {}), /安装任务/);
  const status = await finish(h.models, "laya");
  assert.equal(status.operation?.phase, "completed"); assert.equal(status.initialized, true);
  assert.equal(h.config().enabled, false); assert.equal(h.config().modelPath, h.model);
  h.models.setLayaEnabled(true); assert.equal(h.config().enabled, true);
});

test("active decision cannot be interrupted by init or settings", async t => {
  const h = harness(t); h.models.setLayaEnabled(true);
  const abort = new AbortController();
  const pending = h.decisions.evaluate({ state: "stall", questions: { x: { type: "noul", instructions: "x" } } }, "client", abort.signal);
  assert.throws(() => h.models.start("laya", "initialize", {}), /正在执行/);
  assert.throws(() => h.models.setLayaEnabled(false), /正在执行/);
  abort.abort(); await assert.rejects(pending, /取消/);
});

test("speech initialization checks actual CLI/model while disabled, restores admission and cleans synthetic audio", async t => {
  const h = harness(t);
  h.models.start("speech", "initialize", { model: "base" });
  await assert.rejects(h.speech.transcribe(Buffer.alloc(1)), /WAV/);
  const status = await finish(h.models, "speech");
  assert.equal(status.operation?.phase, "completed"); assert.equal(status.initialized, true);
  assert.equal(status.enabled, false); assert.equal(status.busy, false);
  assert.deepEqual(readdirSync(path.join(h.root, "speech", "tmp")), []);
});

test("fixed file downloads validate full size/hash, preserve completed bytes on retry, and remove bad partials", async t => {
  const h = harness(t); rmSync(path.join(h.model, files[0]!.path));
  h.models.start("laya", "download", {});
  assert.equal((await finish(h.models, "laya")).operation?.phase, "completed");
  assert.equal((await h.models.status()).laya.downloaded, true);
  assert.equal(h.config().enabled, false);
  const store = new ModelFileStore((async () => new Response(Buffer.alloc(bytes.length, 0))) as typeof fetch);
  const target = path.join(h.root, "invalid");
  await assert.rejects(store.download(target, files, () => "https://fixed.test", new AbortController().signal, () => {}), /hash/);
  assert.deepEqual(readdirSync(target), []);
  await assert.rejects(store.download(target, [{ ...files[0]!, path: "../evil" }], () => "https://fixed.test", new AbortController().signal, () => {}), /manifest/);
});

test("cancel during runtime setup preserves verified models and allows retry without changing enabled state", async t => {
  let started!: () => void;
  const installing = new Promise<void>(resolve => { started = resolve; });
  let h!: ReturnType<typeof harness>;
  h = harness(t, {
    decisionConfig: () => ({ enabled: false, pythonPath: "", modelPath: h.model }),
    run: async (_executable: string, args: string[], _cwd: string, signal: AbortSignal) => {
      assert.ok(args[0]!.endsWith("install-laya-runtime.js"));
      assert.ok(args.includes("--events")); started();
      await new Promise<void>((_resolve, reject) => { signal.addEventListener("abort", () => reject(Error("Cancelled")), { once: true }); });
    },
  });
  h.models.start("laya", "initialize", {}); await installing;
  h.models.cancel("laya");
  const status = await finish(h.models, "laya");
  assert.equal(status.operation?.phase, "cancelled"); assert.equal(status.downloaded, true); assert.equal(status.enabled, false);
  assert.equal(readFileSync(path.join(h.model, files[0]!.path)).toString(), bytes.toString());
});

test("unsupported LAYA is reported clearly without a fallback runtime or implicit downloads", async t => {
  const h = harness(t, { supportedLaya: () => false });
  assert.equal((await h.models.status()).laya.supported, false);
  assert.throws(() => h.models.start("laya", "download", {}), /Apple Silicon/);
  assert.throws(() => h.models.setLayaEnabled(true), /不支持/);
});

test("one click activation reuses verified resources, checks model and persists enabled only after success", async t => {
  const h = harness(t);
  assert.equal(h.speech.settings().enabled, false);
  await h.models.setSpeechEnabled(true);
  assert.throws(() => h.models.start("speech", "initialize", {}), /安装任务/);
  const value = await finish(h.models, "speech");
  assert.equal(value.operation?.action, "activate");
  assert.equal(value.operation?.phase, "completed");
  assert.equal(value.enabled, true); assert.equal(value.initialized, true);
  assert.equal((await h.speech.status()).ready, true);
  await h.models.setSpeechEnabled(false);
  assert.equal(h.speech.settings().enabled, false);
});

test("one click activation downloads missing model before initialization, and failed integrity never enables it", async t => {
  for (const valid of [true, false]) {
    const h = harness(t, {}, { fetch: (async () => new Response(valid ? bytes : Buffer.alloc(bytes.length))) as typeof fetch });
    rmSync(path.join(h.root, "speech", "models", "ggml-base.bin"));
    await h.models.setSpeechEnabled(true);
    const value = await finish(h.models, "speech");
    assert.equal(value.operation?.phase, valid ? "completed" : "failed");
    assert.equal(value.enabled, valid); assert.equal(value.downloaded, valid);
  }
});

test("disabling during initialization cancels activation and prevents a late success from re-enabling", async t => {
  const h = harness(t);
  let started!: () => void, release!: () => void;
  const checking = new Promise<void>(r => { started = r; });
  const late = new Promise<void>(r => { release = r; });
  h.speech.initializeModel = async () => { started(); await late; };
  await h.models.setSpeechEnabled(true); await checking;
  await h.models.setSpeechEnabled(false); release();
  const value = await finish(h.models, "speech");
  assert.equal(value.operation?.phase, "cancelled");
  assert.equal(value.enabled, false); assert.equal(value.busy, false);
});

test("initialization failures leave activation off and permit a later retry", async t => {
  const h = harness(t);
  const initialize = h.speech.initializeModel.bind(h.speech);
  h.speech.initializeModel = async () => { throw Error("model load failed"); };
  await h.models.setSpeechEnabled(true);
  assert.equal((await finish(h.models, "speech")).operation?.phase, "failed");
  assert.equal(h.speech.settings().enabled, false);
  h.speech.initializeModel = initialize;
  await h.models.setSpeechEnabled(true);
  assert.equal((await finish(h.models, "speech")).enabled, true);
});

test("unsupported speech exposes its concrete prerequisite and rejects activation without downloading", async t => {
  const h = harness(t, { speechSupport: async () => ({ supported: false, reason: "缺少 CMake" }) });
  const value = (await h.models.status()).speech;
  assert.equal(value.supported, false); assert.equal(value.supportReason, "缺少 CMake");
  await assert.rejects(h.models.setSpeechEnabled(true), /CMake/);
  assert.equal((await h.models.status()).speech.operation, null);
  await h.models.setSpeechEnabled(false);
});

test("off invalidates an enabling request still checking host support", async t => {
  let release!: () => void, started!: () => void;
  const checking = new Promise<void>(r => { started = r; });
  const wait = new Promise<void>(r => { release = r; });
  const h = harness(t, { speechSupport: async () => { started(); await wait; return { supported: true, reason: null }; } });
  const enable = h.models.setSpeechEnabled(true); await checking;
  await h.models.setSpeechEnabled(false); release(); await enable;
  assert.equal((await h.models.status()).speech.operation, null);
  assert.equal(h.speech.settings().enabled, false);
});

test("activation installs a missing runtime using only the fixed installer before enabling", async t => {
  let h!: ReturnType<typeof harness>, cli = "", installed = false;
  h = harness(t, {
    speechSupport: async () => ({ supported: true, reason: null }),
    run: async (_executable: string, args: string[]) => {
      assert.ok(args[0]!.endsWith("install-speech-runtime.js"));
      assert.ok(args.includes("--events"));
      writeFileSync(path.join(h.root, "whisper-cli"), cli, { mode: 0o700 }); installed = true;
    },
  });
  cli = readFileSync(path.join(h.root, "whisper-cli"), "utf8"); rmSync(path.join(h.root, "whisper-cli"));
  assert.equal((await h.speech.status()).runtime.available, false);
  await h.models.setSpeechEnabled(true);
  assert.equal((await finish(h.models, "speech")).enabled, true);
  assert.equal(installed, true);
});

test("a native client changing speech settings invalidates a pending one click activation", async t => {
  const h = harness(t);
  let release!: () => void, started!: () => void;
  const checking = new Promise<void>(r => { started = r; });
  const late = new Promise<void>(r => { release = r; });
  h.speech.initializeModel = async () => { started(); await late; };
  await h.models.setSpeechEnabled(true); await checking;
  h.speech.configure({ enabled: false, language: "zh" }); release();
  const value = await finish(h.models, "speech");
  assert.equal(value.enabled, false); assert.match(value.operation?.error || "", /其他操作修改/);
  assert.equal(h.speech.settings().language, "zh");
});

test("status reads enabled settings after asynchronous resource probes", async t => {
  const h = harness(t);
  let started!: () => void, releaseInitialization!: () => void;
  const initializing = new Promise<void>(resolve => { started = resolve; });
  const initialization = new Promise<void>(resolve => { releaseInitialization = resolve; });
  h.speech.initializeModel = async () => { started(); await initialization; };
  await h.models.setSpeechEnabled(true);
  await initializing;
  const internal = h.speech as unknown as { runtime: () => Promise<unknown> };
  const runtime = internal.runtime.bind(h.speech);
  let captured!: () => void, releaseRuntime!: () => void;
  const snapshotStarted = new Promise<void>(resolve => { captured = resolve; });
  const continueSnapshot = new Promise<void>(resolve => { releaseRuntime = resolve; });
  internal.runtime = async () => { captured(); await continueSnapshot; return runtime(); };
  const snapshot = h.models.status();
  await snapshotStarted;
  releaseInitialization();
  for (let n = 0; n < 100 && !h.speech.settings().enabled; n++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(h.speech.settings().enabled, true);
  await new Promise(resolve => setTimeout(resolve, 1));
  releaseRuntime();
  const status = (await snapshot).speech;
  assert.equal(status.operation?.phase, "completed");
  assert.equal(status.busy, false);
  assert.equal(status.enabled, true);
});

test("speech status uses settings changed while resources were being probed", async t => {
  const h = harness(t);
  const internal = h.speech as unknown as { runtime: () => Promise<unknown> };
  const runtime = internal.runtime.bind(h.speech);
  let started!: () => void, release!: () => void;
  const probing = new Promise<void>(resolve => { started = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  internal.runtime = async () => { started(); await proceed; return runtime(); };
  const snapshot = h.speech.status();
  await probing;
  h.speech.configure({ enabled: true, acceleration: "gpu", language: "zh" });
  release();
  const status = await snapshot;
  assert.equal(status.settings.enabled, true);
  assert.equal(status.settings.acceleration, "gpu");
  assert.equal(status.settings.language, "zh");
  assert.equal(status.runtime.available, true);
  assert.equal(status.runtime.backend, "cpu");
  assert.equal(status.ready, false);
  assert.match(status.reason || "", /CPU/);
});
