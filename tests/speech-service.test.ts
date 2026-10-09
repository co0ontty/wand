import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SpeechError, SpeechService, SPEECH_SETTINGS_KEY, parseSpeechSettings, validateSpeechWav } from "../src/speech-service.ts";
import { SPEECH_MODELS, type SpeechModel } from "../src/speech-models.ts";

export function wav(seconds = 0.2, volume = 1000): Buffer {
  const data = Buffer.alloc(44 + Math.round(16_000 * seconds) * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16_000, 24); data.writeUInt32LE(32_000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(data.length - 44, 40);
  for (let offset = 44; offset < data.length; offset += 2) data.writeInt16LE(volume, offset);
  return data;
}
const fixture = Buffer.from("verified test model");
const model = { ...SPEECH_MODELS[1], size: fixture.length, sha256: createHash("sha256").update(fixture).digest("hex") } as SpeechModel;
function harness(t: TestContext, behavior = "normal", extra: ConstructorParameters<typeof SpeechService>[2] = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "wand-speech-"));
  const values = new Map<string, unknown>();
  const executable = path.join(root, "whisper-cli");
  const log = path.join(root, "args.jsonl");
  writeFileSync(executable, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');\nif (${JSON.stringify(behavior)} === 'hang') setInterval(()=>{},100);\nelse if (${JSON.stringify(behavior)} === 'gpu-failure' && !args.includes('-ng')) process.exit(1);\nelse fs.writeFileSync(args[args.indexOf('-of')+1]+'.txt', ${JSON.stringify(behavior === "large" ? "x".repeat(40_000) : " 测试转写 hello \n")});\n`, { mode: 0o700 });
  const modelsDir = path.join(root, "speech", "models");
  mkdirSync(modelsDir, { recursive: true });
  writeFileSync(path.join(modelsDir, "ggml-base.bin"), fixture);
  const service = new SpeechService({ getPreference: (key, fallback) => (values.get(key) ?? fallback) as typeof fallback,
    setPreference: (key, value) => { values.set(key, value); } }, root, { executable, backend: "cpu", models: [model], ...extra });
  t.after(() => { service.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { root, service, values, log, modelsDir };
}

test("speech configuration rejects command/path injection and invalid model/resource budgets", () => {
  for (const patch of [{ executable: "/tmp/evil" }, { model: "../file" }, { acceleration: "cuda;touch" }, { threads: 0 }, { threads: 17 }, { threads: 1.5 }, { enabled: "true" }, null]) {
    assert.throws(() => parseSpeechSettings(patch), SpeechError);
  }
  assert.equal(parseSpeechSettings({ model: "tiny", threads: 1 }).model, "tiny");
  for (const model of SPEECH_MODELS) assert.match(model.sha256, /^[a-f0-9]{64}$/);
});

test("canonical WAV validates format, duration, exact RIFF size and silence", () => {
  assert.equal(validateSpeechWav(wav()).silent, false);
  assert.equal(validateSpeechWav(wav(0.2, 0)).silent, true);
  for (const buffer of [Buffer.alloc(1), wav(0.05), wav(60.1), Buffer.concat([wav(), Buffer.alloc(2)])]) assert.throws(() => validateSpeechWav(buffer), SpeechError);
  for (const [offset, value] of [[20, 3], [22, 2], [24, 48000], [28, 0], [32, 4], [34, 8], [40, 0]]) {
    const invalid = wav(); invalid.writeUInt16LE(value!, offset!); assert.throws(() => validateSpeechWav(invalid), SpeechError);
  }
});

test("status is opt-in, hashes downloaded models and exposes no local executable paths", async (t) => {
  const { service, values, modelsDir, root } = harness(t);
  let status = await service.status();
  assert.equal(status.ready, false); assert.equal(status.models[0]!.downloaded, true);
  assert.ok(!JSON.stringify(status).includes(root));
  service.configure({ enabled: true });
  assert.equal(values.has(SPEECH_SETTINGS_KEY), true);
  assert.equal((await service.status()).ready, true);
  writeFileSync(path.join(modelsDir, "ggml-base.bin"), Buffer.alloc(fixture.length, 1));
  status = await service.status();
  assert.equal(status.ready, false); assert.equal(status.models[0]!.downloaded, false);
});

test("CPU inference passes explicit no-gpu, returns text and deletes temporary audio", async (t) => {
  const { service, root, log } = harness(t);
  service.configure({ enabled: true, acceleration: "cpu", language: "zh", threads: 2 });
  assert.deepEqual(await service.transcribe(wav()), { text: "测试转写 hello", model: "base", backend: "cpu" });
  const args = JSON.parse(readFileSync(log, "utf8").trim()) as string[];
  assert.ok(args.includes("-ng")); assert.equal(args[args.indexOf("-l") + 1], "zh");
  assert.equal(args[args.indexOf("-t") + 1], "2");
  assert.match(args[args.indexOf("--prompt") + 1]!, /语音识别.*服务端/);
  assert.deepEqual(readdirSync(path.join(root, "speech", "tmp")), []);
  assert.equal((await service.transcribe(wav(0.2, 0))).text, "");
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
});

test("auto GPU failure falls back to CPU once; explicit GPU does not silently change engines", async (t) => {
  const { service, log } = harness(t, "gpu-failure", { backend: "metal" });
  service.configure({ enabled: true });
  assert.equal((await service.transcribe(wav())).backend, "cpu");
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);
  service.configure({ acceleration: "gpu" });
  await assert.rejects(service.transcribe(wav()), (error: SpeechError) => error.code === "ENGINE_FAILED");
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3);
});

test("cancellation rejects late results, frees the single job slot and cleans audio", async (t) => {
  const { service, root } = harness(t, "hang");
  service.configure({ enabled: true });
  const abort = new AbortController();
  const pending = service.transcribe(wav(), abort.signal);
  await assert.rejects(service.transcribe(wav()), (error: SpeechError) => error.status === 429);
  setTimeout(() => abort.abort(), 150);
  await assert.rejects(pending, (error: SpeechError) => error.code === "CANCELLED");
  assert.equal((await service.status()).busy, false);
  assert.deepEqual(readdirSync(path.join(root, "speech", "tmp")), []);
});

test("timeouts and oversized results fail rather than hang or expose engine output", async (t) => {
  const hanging = harness(t, "hang", { timeoutMs: 100 }).service;
  hanging.configure({ enabled: true });
  await assert.rejects(hanging.transcribe(wav()), (error: SpeechError) => error.code === "TIMEOUT");
  const large = harness(t, "large").service;
  large.configure({ enabled: true });
  await assert.rejects(large.transcribe(wav()), (error: SpeechError) => error.code === "INVALID_RESULT");
});

test("shutdown during model verification cannot launch a late download", async (t) => {
  let requests = 0;
  const { service, modelsDir } = harness(t, "normal", { fetch: (async () => { requests += 1; return new Response(fixture); }) as typeof fetch });
  rmSync(path.join(modelsDir, "ggml-base.bin"));
  const pending = service.startDownload("base");
  service.dispose();
  await assert.rejects(pending, (error: SpeechError) => error.code === "UNAVAILABLE");
  assert.equal(requests, 0);
});

test("download is explicit, size/hash checked, failure leaves no usable partial model", async (t) => {
  const { service, modelsDir } = harness(t, "normal", { fetch: (async () => new Response(fixture)) as typeof fetch });
  rmSync(path.join(modelsDir, "ggml-base.bin"));
  await service.startDownload("base");
  for (let i = 0; i < 100 && (await service.status()).download?.phase === "downloading"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await service.status()).models[0]!.downloaded, true);
  const failed = harness(t, "normal", { fetch: (async () => new Response(Buffer.alloc(fixture.length, 1))) as typeof fetch });
  rmSync(path.join(failed.modelsDir, "ggml-base.bin"));
  await failed.service.startDownload("base");
  for (let i = 0; i < 100 && (await failed.service.status()).download?.phase === "downloading"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await failed.service.status()).download?.phase, "failed");
  assert.deepEqual(readdirSync(failed.modelsDir), []);
});
