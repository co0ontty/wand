import { randomBytes } from "node:crypto";
import { readdir, stat, unlink, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Express, NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";

import { asyncRoute } from "./express-async.js";
import { HttpError } from "./http-error.js";
import type { SessionRegistry } from "./session-registry.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 5;
/** Per working directory ceiling for everything ever uploaded there (in-process accounting). */
const MAX_UPLOAD_DIR_BYTES = 512 * 1024 * 1024;
const UPLOAD_DIR_NAME = ".wand-uploads";

type UploadRequest = Request & { uploadCwd?: string };

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

/**
 * Bytes already stored in an upload directory. Seeded once from disk per directory, then
 * maintained by the upload handler. Uploaded files are never rewritten, so the count only
 * needs to grow; deleting files outside the server simply makes the cap conservative.
 */
const uploadUsage = new Map<string, Promise<number>>();

function seedUploadUsage(dir: string): Promise<number> {
  let usage = uploadUsage.get(dir);
  if (!usage) {
    usage = (async () => {
      let total = 0;
      let entries: string[] = [];
      try {
        entries = await readdir(dir);
      } catch {
        return 0;
      }
      const sizes = await Promise.all(entries.map(async (name) => {
        try {
          const info = await stat(path.join(dir, name));
          return info.isFile() ? info.size : 0;
        } catch {
          return 0;
        }
      }));
      for (const size of sizes) total += size;
      return total;
    })();
    uploadUsage.set(dir, usage);
  }
  return usage;
}

async function removeFiles(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((filePath) => unlink(filePath).catch(() => undefined)));
}

/** multer 的限额错误改成稳定的 413，其他错误原样交给统一错误处理。 */
function uploadErrorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (error instanceof MulterError && (error.code === "LIMIT_FILE_SIZE" || error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE")) {
    next(new HttpError(413, "payload_too_large", error.code === "LIMIT_FILE_SIZE" ? "单个文件不能超过 10 MB。" : `一次最多上传 ${MAX_FILES} 个文件。`));
    return;
  }
  next(error);
}

export interface UploadRouteOptions {
  /** Test seam: per-directory byte ceiling. */
  maxDirBytes?: number;
}

export function registerUploadRoutes(
  app: Express,
  sessions: Pick<SessionRegistry, "getLatest">,
  options: UploadRouteOptions = {},
): void {
  const maxDirBytes = options.maxDirBytes ?? MAX_UPLOAD_DIR_BYTES;
  const storage = multer.diskStorage({
    destination(req, _file, cb) {
      const cwd = (req as UploadRequest).uploadCwd;
      if (!cwd) {
        cb(new Error("会话不存在。"), "");
        return;
      }
      const uploadDir = path.join(cwd, UPLOAD_DIR_NAME);
      // Async mkdir keeps the event loop free while a large upload is being accepted.
      mkdir(uploadDir, { recursive: true }).then(
        () => cb(null, uploadDir),
        (error: unknown) => cb(error instanceof Error ? error : new Error(String(error)), ""),
      );
    },
    filename(_req, file, cb) {
      const ts = Date.now();
      const rand = randomBytes(4).toString("hex");
      const safe = sanitizeFilename(file.originalname);
      cb(null, `${ts}-${rand}-${safe}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  });

  function requireUploadSession(req: Request, res: Response, next: NextFunction): void {
    const sessionId = req.params.id;
    // Group chats are structured relay sessions; ProcessManager does not own them.
    // Resolve through the same registry used by the rest of the session API so
    // PTY, structured and stored sessions all upload into their own cwd.
    const session = sessions.getLatest(sessionId);
    if (!session) {
      res.status(404).json({ error: "会话不存在。", code: "not_found" });
      return;
    }
    if (!session.cwd || !path.isAbsolute(session.cwd)) {
      res.status(400).json({ error: "会话工作目录无效。", code: "bad_request" });
      return;
    }
    (req as UploadRequest).uploadCwd = session.cwd;
    // Seed usage before multer writes this request's files, so they are not counted twice.
    seedUploadUsage(path.join(session.cwd, UPLOAD_DIR_NAME)).then(() => next(), next);
  }

  app.post(
    "/api/sessions/:id/upload",
    requireUploadSession,
    upload.array("files", MAX_FILES),
    uploadErrorHandler,
    asyncRoute(async (req, res) => {
      const files = (req.files as Express.Multer.File[]) || [];
      if (files.length === 0) {
        res.status(400).json({ error: "未收到文件。", code: "bad_request" });
        return;
      }

      const dir = path.join((req as UploadRequest).uploadCwd!, UPLOAD_DIR_NAME);
      const incoming = files.reduce((total, file) => total + file.size, 0);
      const current = await seedUploadUsage(dir);
      if (current + incoming > maxDirBytes) {
        await removeFiles(files.map((file) => file.path));
        throw new HttpError(413, "payload_too_large", "该会话的上传空间已满，请清理 .wand-uploads 目录后重试。");
      }
      uploadUsage.set(dir, Promise.resolve(current + incoming));

      const result = files.map((f) => ({
        originalName: f.originalname,
        savedPath: f.path,
        size: f.size,
        mimeType: f.mimetype,
      }));

      res.json({ files: result });
    }),
  );
}
