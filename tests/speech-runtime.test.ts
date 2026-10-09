import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import express from "express";
import { SpeechService } from "../src/speech-service.ts";
import { registerSpeechRoutes } from "../src/server-speech-routes.ts";

/** Opt-in real local model, public upstream sample; never calls a paid/cloud model. */
test("real whisper.cpp transcribes the public sample over CPU and host acceleration via HTTP", { skip: process.env.WAND_SPEECH_REAL !== "1", timeout: 600_000 }, async (t) => {
  const root = path.resolve(process.env.WAND_SPEECH_DIR || "output/server-speech/host");
  const preferences = new Map<string, unknown>();
  const speech = new SpeechService({ getPreference: (key, fallback) => (preferences.get(key) ?? fallback) as typeof fallback,
    setPreference: (key, value) => { preferences.set(key, value); } }, root);
  t.after(() => speech.dispose());
  speech.configure({ enabled: true, model: "base", threads: 2, language: "en", acceleration: "cpu" });
  assert.equal((await speech.status()).runtime.available, true, "Install runtime explicitly first");
  await speech.startDownload("base");
  for (let i = 0; i < 600 && (await speech.status()).download?.phase === "downloading"; i += 1) await new Promise(r => setTimeout(r, 500));
  const status = await speech.status();
  assert.equal(status.ready, true, status.download?.error || status.reason || "Model unavailable");
  const response = await fetch("https://raw.githubusercontent.com/ggml-org/whisper.cpp/2eeeba56e9edd762b4b38467bab96c2517163158/samples/jfk.wav");
  assert.equal(response.ok, true);
  const upstream = Buffer.from(await response.arrayBuffer());
  let fmt: Buffer | undefined, pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= upstream.length;) {
    const name = upstream.toString("ascii", offset, offset + 4), size = upstream.readUInt32LE(offset + 4);
    assert.ok(offset + 8 + size <= upstream.length);
    const chunk = upstream.subarray(offset + 8, offset + 8 + size);
    if (name === "fmt ") fmt = chunk;
    if (name === "data") pcm = chunk;
    offset += 8 + size + size % 2;
  }
  assert.ok(fmt && pcm); assert.equal(fmt.readUInt16LE(0), 1); assert.equal(fmt.readUInt16LE(2), 1);
  assert.equal(fmt.readUInt32LE(4), 16000); assert.equal(fmt.readUInt16LE(14), 16);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  fmt.copy(wav, 20, 0, 16); wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  const app = express(); app.use(express.json());
  registerSpeechRoutes(app, { speech, requireSessions: (_req, _res, next) => next(), requireAdmin: (_req, _res, next) => next() });
  const server = createServer(app); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/speech/transcribe`;
  const evidence: unknown[] = [];
  for (const acceleration of ["cpu", "auto"] as const) {
    speech.configure({ acceleration });
    const started = performance.now();
    const reply = await fetch(url, { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
    const result = await reply.json() as { text: string; backend: string };
    assert.equal(reply.status, 200, JSON.stringify(result));
    assert.match(result.text.toLowerCase(), /ask not what your country/);
    if (acceleration === "cpu") assert.equal(result.backend, "cpu");
    evidence.push({ requested: acceleration, actualBackend: result.backend, durationMs: Math.round(performance.now() - started), publicSampleTranscript: result.text });
  }
  if (process.env.WAND_SPEECH_CHINESE_WAV) {
    // The optional fixture is generated locally from the public QA sentence, not a user's recording.
    speech.configure({ language: "zh", acceleration: "auto" });
    const started = performance.now();
    const reply = await fetch(url, { method: "POST", headers: { "content-type": "audio/wav" }, body: readFileSync(process.env.WAND_SPEECH_CHINESE_WAV) });
    const result = await reply.json() as { text: string; backend: string };
    assert.equal(reply.status, 200, JSON.stringify(result));
    assert.match(result.text, /语音识别|語音識別/); assert.match(result.text, /修改代码|修改代碼/);
    evidence.push({ requested: "auto / zh", actualBackend: result.backend, durationMs: Math.round(performance.now() - started), syntheticQaTranscript: result.text });
  }
  mkdirSync(path.resolve("output/server-speech"), { recursive: true });
  writeFileSync(path.resolve("output/server-speech/runtime-evidence.json"), JSON.stringify({ realModel: true, installedService: false, runtime: status.runtime,
    model: "base", sample: "upstream public jfk.wav", canonicalWavBytes: wav.length, cases: evidence }, null, 2));
});
