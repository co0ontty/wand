import assert from "node:assert/strict";
import test from "node:test";
import { encodeSpeechWav } from "../src/web-ui/speech-audio.ts";
import { BrowserSpeechInput, localSpeechSupported } from "../src/web-ui/react/speech/repository.ts";
import { validateSpeechWav } from "../src/speech-service.ts";

function callbacks() {
  const finals: string[] = [], errors: string[] = [], statuses: string[] = [];
  return { finals, errors, statuses, value: { onPartial: () => {}, onStatus: (status: string) => { statuses.push(status); },
    onProcessing: () => {}, onFinal: (text: string) => { finals.push(text); }, onError: (error: string) => { errors.push(error); } } };
}
function globals(values: Record<string, unknown>) {
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } };
}

test("web encoder downmixes and downsamples to canonical mono PCM16 WAV with bounded duration", () => {
  const channels = [new Float32Array(4800).fill(0.25), new Float32Array(4800).fill(0.75)];
  const wav = Buffer.from(encodeSpeechWav(channels, 48000));
  assert.equal(wav.length, 3244); assert.equal(wav.readInt16LE(44), 16384);
  assert.equal(validateSpeechWav(wav).samples, 1600);
  assert.throws(() => encodeSpeechWav([new Float32Array(100)], 48000), /太短/);
  assert.throws(() => encodeSpeechWav([new Float32Array(48000 * 61)], 48000), /60 秒/);
  assert.throws(() => encodeSpeechWav([new Float32Array(4800), new Float32Array(1)], 48000), /格式/);
});

test("web local mode refuses vendor cloud engines without processLocally", async () => {
  const restore = globals({ window: { isSecureContext: true, SpeechRecognition: class {} } });
  try {
    assert.equal(localSpeechSupported(), false);
    const events = callbacks();
    await new BrowserSpeechInput("local", events.value).start();
    assert.equal(events.errors.length, 1); assert.match(events.errors[0]!, /不支持客户端本地/);
    assert.deepEqual(events.finals, []);
  } finally { restore(); }
});

test("cancelled web permission requests stop late microphone streams without recording/uploading", async () => {
  let resolvePermission!: (stream: unknown) => void;
  let stopped = 0, recordings = 0;
  const permission = new Promise(resolve => { resolvePermission = resolve; });
  const restore = globals({ window: { isSecureContext: true }, navigator: { mediaDevices: { getUserMedia: () => permission } },
    MediaRecorder: class { constructor() { recordings += 1; } },
    fetch: async () => new Response(JSON.stringify({ ready: true }), { headers: { "content-type": "application/json" } }),
  });
  try {
    const events = callbacks(), input = new BrowserSpeechInput("server", events.value);
    const starting = input.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    input.cancel();
    resolvePermission({ getTracks: () => [{ stop: () => { stopped += 1; } }] });
    await starting;
    assert.equal(stopped, 1); assert.equal(recordings, 0); assert.deepEqual(events.finals, []); assert.deepEqual(events.errors, []);
  } finally { restore(); }
});

test("auto-finish can be vetoed in the cancel zone without uploading audio", async () => {
  let limit: (() => void) | undefined, uploads = 0, stopped = 0;
  const originalSetTimeout = setTimeout, originalClearTimeout = clearTimeout;
  const restore = globals({ window: { isSecureContext: true }, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { stopped += 1; } }] }) } },
    MediaRecorder: class { state = "inactive"; start() { this.state = "recording"; } stop() { this.state = "inactive"; } },
    setTimeout: (callback: () => void, ms: number) => { if (ms === 60000) { limit = callback; return 1; } return originalSetTimeout(callback, ms); },
    clearTimeout: (timer: any) => { if (timer !== 1) originalClearTimeout(timer); },
    fetch: async (url: string) => { if (url.includes("transcribe")) uploads += 1; return new Response(JSON.stringify({ ready: true }), { headers: { "content-type": "application/json" } }); },
  });
  try {
    const events = callbacks();
    const input = new BrowserSpeechInput("server", { ...events.value, onProcessing: () => input.cancel() });
    await input.start(); assert.ok(limit); limit();
    assert.equal(stopped, 1); assert.equal(uploads, 0); assert.deepEqual(events.finals, []); assert.deepEqual(events.errors, []);
  } finally { restore(); }
});

test("not-ready servers are reported without opening the microphone or changing mode", async () => {
  let mic = 0;
  const restore = globals({ window: { isSecureContext: true }, navigator: { mediaDevices: { getUserMedia: () => { mic += 1; } } }, MediaRecorder: class {},
    fetch: async () => new Response(JSON.stringify({ ready: false, reason: "模型未下载" }), { headers: { "content-type": "application/json" } }),
  });
  try { const events = callbacks(); await new BrowserSpeechInput("server", events.value).start(); assert.equal(mic, 0); assert.deepEqual(events.errors, ["模型未下载"]); }
  finally { restore(); }
});
