import type { RequestHandler } from "express";
import type { UploadRepository } from "./storage/uploads-repository.js";

/** Runs after authentication, before either input owner starts dispatch. */
export function uploadReferenceGuard(uploads: Pick<UploadRepository, "retainManagedUploadReferences">): RequestHandler {
  return (req, _res, next) => {
    if (req.method !== "POST" || !req.body) { next(); return; }
    const match = req.path.match(/^\/(?:sessions|structured-sessions)\/([^/]+)\/(?:input|messages)$/);
    if (!match) { next(); return; }
    let sessionId: string;
    try { sessionId = decodeURIComponent(match[1]!); } catch { next(); return; }
    try { uploads.retainManagedUploadReferences(sessionId, JSON.stringify(req.body)); next(); }
    catch (error) { next(error); }
  };
}
