import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Express } from "express";
import multer from "multer";
import type { ProcessManager } from "./process-manager.js";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 5;

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

export function registerUploadRoutes(app: Express, processes: ProcessManager): void {
  const storage = multer.diskStorage({
    destination(_req, _file, cb) {
      const sessionId = (_req as any).params?.id;
      const session = sessionId ? processes.get(sessionId) : null;
      const cwd = session?.cwd || "/tmp";
      const uploadDir = path.join(cwd, ".wand-uploads");
      if (!existsSync(uploadDir)) {
        mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
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

  app.post("/api/sessions/:id/upload", upload.array("files", MAX_FILES), (req, res) => {
    const sessionId = req.params.id;
    const session = processes.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "会话不存在。" });
      return;
    }

    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      res.status(400).json({ error: "未收到文件。" });
      return;
    }

    const result = files.map((f) => ({
      originalName: f.originalname,
      savedPath: f.path,
      size: f.size,
      mimeType: f.mimetype,
    }));

    res.json({ files: result });
  });
}
