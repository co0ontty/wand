import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler } from "express";
import { FeedbackReceiver, FeedbackReporter, FeedbackStorageError, parseClientFeedback } from "./feedback.js";

export function feedbackRequestSecrets(req: Pick<Request, "headers">): string[] {
  const authorization = req.headers.authorization ?? "";
  const bearer = /^(?:Bearer|Basic) (.+)$/i.exec(authorization)?.[1] ?? "";
  const cookie = req.headers.cookie ?? "";
  const proof = req.headers["x-wand-web-login-proof"];
  return [authorization, bearer, cookie, ...(typeof proof === "string" ? [proof] : []), ...cookie.split(";").map(item => item.slice(item.indexOf("=") + 1).trim())];
}

/** Public encrypted ingress is opt-in, globally bounded, and never uses Wand's app secret. */
export function registerFeedbackIngress(app: Express, receiver: FeedbackReceiver | null): void {
  const router = express.Router();
  let windowStart = Date.now(), keys = 0, reports = 0;
  const rate: RequestHandler = (req, res, next) => {
    if (!receiver) { res.status(404).json({ error: "Feedback receiver is disabled." }); return; }
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; keys = 0; reports = 0; }
    const allowed = req.method === "GET" ? ++keys <= 120 : ++reports <= 30;
    if (!allowed) { res.set("Retry-After", "60").status(429).json({ error: "Feedback rate limited." }); return; }
    next();
  };
  router.get("/key", rate, (_req, res) => { res.set("Cache-Control", "no-store").json(receiver!.publicInfo()); });
  router.post("/", rate, express.json({ limit: "64kb", inflate: false, strict: true }), (req, res) => {
    try {
      const result = receiver!.accept(req.body);
      if (result === "full") { res.status(507).json({ error: "Feedback storage is full." }); return; }
      res.status(202).json({ accepted: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const storageFailure = error instanceof FeedbackStorageError || ["ENOSPC", "EACCES", "EPERM", "EROFS", "EIO", "EMFILE"].includes(code ?? "");
      res.status(storageFailure ? 503 : 400).json({ error: storageFailure ? "Feedback storage unavailable." : "Invalid encrypted feedback." });
    }
  });
  const errors: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status((_error as { status?: number })?.status === 413 ? 413 : 400).json({ error: "Invalid feedback body." });
  };
  router.use(errors);
  // Exact mounts avoid accidentally exposing future /api/feedback administration routes.
  app.use("/api/feedback", router);
}

/** Session-authenticated clients relay diagnostics; they never receive the collection private key. */
export function registerFeedbackClientRoutes(app: Express, reporter: FeedbackReporter): void {
  let windowStart = Date.now(), count = 0;
  app.post("/api/feedback/client", (req, res) => {
    if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); count = 0; }
    if (++count > 60) { res.set("Retry-After", "60").status(429).json({ error: "Feedback rate limited." }); return; }
    try {
      const input = parseClientFeedback(req.body);
      if (!reporter.isEnabled) { res.status(202).json({ accepted: false }); return; }
      const accepted = reporter.captureClient(input, feedbackRequestSecrets(req));
      if (!accepted) { res.status(503).json({ error: "Feedback queue unavailable." }); return; }
      res.status(202).json({ accepted: true });
    } catch (error) {
      res.status(error instanceof RangeError ? 413 : 400).json({ error: "Invalid client feedback." });
    }
  });
}

/** Authentication is explicit even though these routes are mounted after the API auth guard. */
export function registerFeedbackAdminRoutes(app: Express, receiver: FeedbackReceiver | null, requireAdmin: RequestHandler): void {
  app.get("/api/feedback/reports", requireAdmin, (req, res, next) => {
    if (!receiver) { res.status(404).json({ error: "Feedback receiver is disabled." }); return; }
    try { res.set("Cache-Control", "no-store").json({ reports: receiver.latest(typeof req.query.taskId === "string" ? req.query.taskId : undefined) }); }
    catch (error) { next(error); }
  });
}
