import { randomBytes } from "node:crypto";
import { readdir, stat, lstat, realpath, unlink, mkdir, open } from "node:fs/promises";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type { Express, NextFunction, Request, Response } from "express";
import multer, { MulterError } from "multer";

import { asyncRoute } from "./express-async.js";
import { HttpError } from "./http-error.js";
import type { SessionRegistry } from "./session-registry.js";
import type { UploadRepository, ManagedUpload } from "./storage/uploads-repository.js";
import { assertPlainTempPath, createManagedTemporary } from "./managed-temp.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 5;
/** Per working directory ceiling for everything ever uploaded there (in-process accounting). */
const MAX_UPLOAD_DIR_BYTES = 512 * 1024 * 1024;
const UPLOAD_DIR_NAME = ".wand-uploads";

type UploadRequest = Request & { uploadCwd?: string; uploadTemporary?: ReturnType<typeof createManagedTemporary>; uploadClosed?: boolean; uploadWriters?: Set<WriteStream> };

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

/**
 * Bytes already stored in an upload directory. Seeded once from disk per directory, then
 * maintained by the upload handler. Uploaded files are never rewritten, so the count only
 * needs to grow; deleting files outside the server simply makes the cap conservative.
 */
const uploadUsage = new Map<string, Promise<number>>();

export function invalidateUploadUsage(cwd: string): void { uploadUsage.delete(path.join(cwd, UPLOAD_DIR_NAME)); }

async function reserveUploadUsage(dir: string, incoming: number, maximum: number): Promise<boolean> {
  for (;;) {
    const pending = seedUploadUsage(dir);
    const current = await pending;
    if (uploadUsage.get(dir) !== pending) continue;
    if (current + incoming > maximum) return false;
    uploadUsage.set(dir, Promise.resolve(current + incoming));
    return true;
  }
}

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
  if (_req.aborted) return;
  if (error instanceof MulterError && (error.code === "LIMIT_FILE_SIZE" || error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE")) {
    next(new HttpError(413, "payload_too_large", error.code === "LIMIT_FILE_SIZE" ? "单个文件不能超过 10 MB。" : `一次最多上传 ${MAX_FILES} 个文件。`));
    return;
  }
  next(error);
}

export interface UploadRouteOptions {
  /** Test seam: per-directory byte ceiling. */
  maxDirBytes?: number;
  uploads?: Pick<UploadRepository, "recordManagedUploads">;
  temporaryRoot?: string;
}

export function registerUploadRoutes(
  app: Express,
  sessions: Pick<SessionRegistry, "getLatest">,
  options: UploadRouteOptions = {},
): void {
  const maxDirBytes = options.maxDirBytes ?? MAX_UPLOAD_DIR_BYTES;
  const storage: multer.StorageEngine = {
    _handleFile(req, file, cb) {
      void (async () => {
        const request = req as UploadRequest;
        const cwd = request.uploadCwd;
        if (!cwd) throw new Error("会话不存在。");
        const uploadDir = path.join(await realpath(cwd), UPLOAD_DIR_NAME);
        assertPlainTempPath(uploadDir);
        await mkdir(uploadDir, { recursive: true, mode: 0o700 });
        assertPlainTempPath(uploadDir);
        if (request.uploadClosed || req.aborted) throw new Error("Upload closed before receiving files.");
        if (options.temporaryRoot) request.uploadTemporary ??= createManagedTemporary("upload-stage", options.temporaryRoot);
        const destination = request.uploadTemporary?.directory ?? path.join(cwd, UPLOAD_DIR_NAME);
        const filename = `${Date.now()}-${randomBytes(4).toString("hex")}-${sanitizeFilename(file.originalname)}`;
        const filePath = path.join(destination, filename);
        const output = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
        const writers = request.uploadWriters ??= new Set();
        writers.add(output);
        let opened = false;
        output.once("open", () => { opened = true; });
        output.once("close", () => writers.delete(output));
        try {
          // pipeline closes the disk descriptor when the multipart source fails or disconnects.
          await pipeline(file.stream, output);
        } catch (error) {
          if (opened) await unlink(filePath).catch(() => undefined);
          throw error;
        }
        return { destination, filename, path: filePath, size: output.bytesWritten };
      })().then(info => cb(null, info), error => cb(error instanceof Error ? error : new Error(String(error))));
    },
    _removeFile(_req, file, cb) { unlink(file.path).then(() => cb(null), error => cb(error.code === "ENOENT" ? null : error)); },
  };

  const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  });

  function requireUploadSession(req: Request, res: Response, next: NextFunction): void {
    const discardStage = () => {
      const request = req as UploadRequest;
      if (request.uploadClosed) return;
      request.uploadClosed = true;
      const closed = [...(request.uploadWriters ?? [])].map(writer => new Promise<void>(resolve => {
        writer.once("close", resolve); writer.destroy();
      }));
      // Wait for descriptors to close before unlinking; deleted-but-open files still consume disk.
      void Promise.all(closed).then(() => request.uploadTemporary?.closeAsync());
    };
    res.once("finish", discardStage); res.once("close", discardStage);
    req.once("aborted", discardStage);
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
      if (!await reserveUploadUsage(dir, incoming, maxDirBytes)) {
        await removeFiles(files.map((file) => file.path));
        throw new HttpError(413, "payload_too_large", "该会话的上传空间已满，请清理 .wand-uploads 目录后重试。");
      }

      if ((req as UploadRequest).uploadTemporary) {
        const promoted: string[] = [];
        try {
          const targetDir = path.join(await realpath((req as UploadRequest).uploadCwd!), UPLOAD_DIR_NAME);
          assertPlainTempPath(targetDir);
          for (const file of files) {
            const destination = path.join(targetDir, path.basename(file.path));
            // Exclusive creation never overwrites a collision or user-created redirect.
            const output = await open(destination, "wx", 0o600); promoted.push(destination);
            try { for await (const chunk of createReadStream(file.path)) await output.writeFile(chunk); }
            finally { await output.close(); }
            await unlink(file.path);
            file.path = path.join((req as UploadRequest).uploadCwd!, UPLOAD_DIR_NAME, path.basename(destination));
          }
        } catch (error) {
          await removeFiles(promoted); invalidateUploadUsage((req as UploadRequest).uploadCwd!); throw error;
        }
      }

      if (options.uploads) {
        try {
          const canonicalCwd = await realpath((req as UploadRequest).uploadCwd!);
          const receipts: Omit<ManagedUpload, "orphanedAt">[] = [];
          for (const file of files) {
            const canonicalPath = path.join(canonicalCwd, UPLOAD_DIR_NAME, path.basename(file.path));
            assertPlainTempPath(canonicalPath);
            const info = await lstat(canonicalPath);
            if (!info.isFile()) throw new Error("Upload is not a regular file.");
            receipts.push({ filePath: file.path, canonicalPath, cwd: (req as UploadRequest).uploadCwd!,
              canonicalCwd, sessionId: req.params.id, device: info.dev, inode: info.ino, size: info.size,
              mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, createdAt: Date.now() });
          }
          options.uploads.recordManagedUploads(receipts);
        } catch (error) {
          await removeFiles(files.map(file => file.path)); invalidateUploadUsage((req as UploadRequest).uploadCwd!);
          throw error;
        }
      }

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
