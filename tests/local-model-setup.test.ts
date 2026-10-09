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
function harness(t: TestContext, extras: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "wand-model-setup-"));
  const model = path.join(root, "existing"); mkdirSync(model); writeFileSync(path.join(model, files[0]!.path), bytes);
  let config: LocalDecisionConfig = { enabled: false, pythonPath: process.execPath, modelPath: model };
  const decisions = new DecisionService(config, { workerPath: path.resolve("tests/fixtures/decision-worker.mjs"), supported: () => true, timeoutMs: 1500 });
  const pref = new Map();
  const executable = path.join(root, "whisper-cli");
  writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);fs.writeFileSync(args[args.indexOf('-of')+1]+'.txt','');\n`, { mode: 0o700 });
  const speech = new SpeechService({ getPreference: (key, fallback) => pref.get(key) ?? fallback, setPreference: (key, value) => { pref.set(key, value); } }, root,
    { executable, backend: "cpu", models: [speechModel] });
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
