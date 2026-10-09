import express, { type Express, type RequestHandler, type ErrorRequestHandler } from "express";
import { SpeechError, type SpeechService } from "./speech-service.js";
import { SPEECH_MAX_WAV_BYTES } from "./speech-types.js";
import type { SpeechPolisherService } from "./speech-polisher-service.js";

/** Mounted behind /api authentication. Clients may transcribe, only admins configure/download. */
export function registerSpeechRoutes(app: Express, deps: {
  speech: SpeechService;
  requireSessions: RequestHandler;
  requireAdmin: RequestHandler;
  polisher?: Pick<SpeechPolisherService, "polish">;
}): void {
  const noStore: RequestHandler = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
  app.use("/api/speech", noStore, deps.requireSessions);
  app.get("/api/speech/status", async (_req, res, next) => {
    try { res.json(await deps.speech.status()); } catch (error) { next(error); }
  });
  app.patch("/api/speech/settings", deps.requireAdmin, async (req, res, next) => {
    try { deps.speech.configure(req.body); res.json(await deps.speech.status()); } catch (error) { next(error); }
  });
  app.post("/api/speech/models/:id/download", deps.requireAdmin, async (req, res, next) => {
    try { await deps.speech.startDownload(req.params.id); res.status(202).json(await deps.speech.status()); }
    catch (error) { next(error); }
  });
  // Bound raw uploads as well as inference; don't buffer unbounded concurrent audio requests.
  let uploads = 0;
  const admission: RequestHandler = (req, res, next) => {
    if (!req.is("audio/wav")) { res.status(415).json({ error: "请上传 audio/wav 音频。", code: "INVALID_AUDIO_TYPE" }); return; }
    if (uploads >= 2) { res.status(429).json({ error: "语音服务繁忙，请稍后重试。", code: "BUSY" }); return; }
    uploads += 1;
    let released = false;
    const release = (): void => { if (!released) { released = true; uploads -= 1; } };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
  app.post("/api/speech/transcribe", admission, express.raw({ type: "audio/wav", limit: SPEECH_MAX_WAV_BYTES }), async (req, res, next) => {
    const started = Date.now();
    const abort = new AbortController();
    const disconnected = (): void => { if (!res.writableEnded) abort.abort(); };
    res.once("close", disconnected);
    try {
      if (!Buffer.isBuffer(req.body)) throw new SpeechError("INVALID_AUDIO", "未收到 WAV 音频。");
      const result = await deps.speech.transcribe(req.body, abort.signal);
      const polished = deps.polisher ? await deps.polisher.polish(result.text, abort.signal, Math.min(45_000, 123_000 - (Date.now() - started))).catch(() => {
        abort.signal.throwIfAborted();
        return { text: result.text, originalText: result.text, optimized: false,
          optimizationError: "口述整理暂不可用，已保留原始转写。" };
      }) : null;
      if (!res.destroyed) res.json({ ...result, ...(polished ?? {}) });
    } catch (error) { if (!res.destroyed) next(error); }
    finally { res.off("close", disconnected); }
  });
  const errors: ErrorRequestHandler = (error, _req, res, next) => {
    if (error instanceof SpeechError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    if (error?.type === "entity.too.large") { res.status(413).json({ error: "语音最长 60 秒。", code: "AUDIO_TOO_LARGE" }); return; }
    next(error);
  };
  app.use("/api/speech", errors);
}
