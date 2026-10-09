import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import express from "express";
import { registerSpeechRoutes } from "../src/server-speech-routes.ts";
import { SpeechError, type SpeechService } from "../src/speech-service.ts";
import { SPEECH_MAX_WAV_BYTES } from "../src/speech-types.ts";

async function harness(t: TestContext) {
  let transcriptions = 0;
  let downloads = 0;
  const app = express();
  app.use(express.json());
  app.use("/api", (req, res, next) => {
    if (!req.headers.authorization) { res.status(401).json({ error: "unauthorized" }); return; }
    next();
  });
  registerSpeechRoutes(app, {
    speech: { status: async () => ({ ready: true }), configure: () => {}, startDownload: async () => { downloads += 1; },
      transcribe: async (audio: Buffer) => { transcriptions += 1; if (audio.length < 44) throw new SpeechError("INVALID_AUDIO", "无效音频"); return { text: "转写" }; } } as unknown as SpeechService,
    requireSessions: (req, res, next) => { if (req.headers.authorization === "files") res.status(403).end(); else next(); },
    requireAdmin: (req, res, next) => { if (req.headers.authorization !== "admin") res.status(403).end(); else next(); },
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, counts: () => ({ transcriptions, downloads }) };
}

test("speech endpoints require authentication/sessions; model download and config require admin", async (t) => {
  const { url, counts } = await harness(t);
  assert.equal((await fetch(`${url}/api/speech/status`)).status, 401);
  assert.equal((await fetch(`${url}/api/speech/status`, { headers: { authorization: "files" } })).status, 403);
  const status = await fetch(`${url}/api/speech/status`, { headers: { authorization: "app" } });
  assert.equal(status.status, 200); assert.equal(status.headers.get("cache-control"), "no-store");
  for (const [route, method] of [["settings", "PATCH"], ["models/base/download", "POST"]]) {
    assert.equal((await fetch(`${url}/api/speech/${route}`, { method, headers: { authorization: "app", "content-type": "application/json" }, body: "{}" })).status, 403);
  }
  assert.equal(counts().downloads, 0);
  assert.equal((await fetch(`${url}/api/speech/models/base/download`, { method: "POST", headers: { authorization: "admin" } })).status, 202);
  assert.equal(counts().downloads, 1);
});

test("raw WAV route bounds uploads and returns structured safe errors", async (t) => {
  const { url, counts } = await harness(t);
  const send = (body: Buffer, type = "audio/wav") => fetch(`${url}/api/speech/transcribe`, { method: "POST", headers: { authorization: "app", "content-type": type }, body });
  assert.equal((await send(Buffer.alloc(44), "audio/webm")).status, 415);
  assert.equal((await send(Buffer.alloc(SPEECH_MAX_WAV_BYTES + 1))).status, 413);
  const invalid = await send(Buffer.alloc(1));
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, "INVALID_AUDIO");
  const valid = await send(Buffer.alloc(44));
  assert.equal(valid.status, 200); assert.deepEqual(await valid.json(), { text: "转写" });
  assert.equal(counts().transcriptions, 2);
});
