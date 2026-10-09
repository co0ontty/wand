import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ModelFile } from "./laya-model-manifest.js";

/** Fixed manifests only. No URL/path from a client is passed to this utility. */
export class ModelFileStore {
  private readonly verified = new Map<string, string>();
  private readonly pending = new Map<string, Promise<boolean>>();
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async ready(root: string, files: readonly ModelFile[]): Promise<boolean> {
    return (await Promise.all(files.map((file) => this.fileReady(root, file)))).every(Boolean);
  }
  private filePath(root: string, file: ModelFile): string {
    if (!file.path || path.isAbsolute(file.path) || file.path.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) throw new Error("Invalid fixed model manifest");
    return path.join(root, file.path);
  }
  private async fileReady(root: string, file: ModelFile): Promise<boolean> {
    const target = this.filePath(root, file);
    const key = `${target}:${file.sha256}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const result = this.verify(target, file, key);
    this.pending.set(key, result);
    try { return await result; } finally { this.pending.delete(key); }
  }
  private async verify(target: string, file: ModelFile, key: string): Promise<boolean> {
    try {
      const info = await stat(target);
      if (!info.isFile() || info.size !== file.size) return false;
      const signature = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (this.verified.get(key) === signature) return true;
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(target)) hash.update(chunk);
      if (hash.digest("hex") !== file.sha256) return false;
      this.verified.set(key, signature);
      return true;
    } catch { return false; }
  }
  async download(root: string, files: readonly ModelFile[], url: (file: ModelFile) => string,
    signal: AbortSignal, progress: (received: number, total: number) => void): Promise<void> {
    const total = files.reduce((sum, file) => sum + file.size, 0);
    let completed = 0;
    for (const file of files) {
      signal.throwIfAborted();
      if (await this.fileReady(root, file)) { completed += file.size; progress(completed, total); continue; }
      signal.throwIfAborted();
      const target = this.filePath(root, file);
      const partial = `${target}.${randomBytes(6).toString("hex")}.part`;
      try {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        const response = await this.fetcher(url(file), { signal });
        if (!response.ok || !response.body) throw new Error("Model download failed");
        const length = response.headers.get("content-length");
        if (length && Number(length) !== file.size) { await response.body.cancel(); throw new Error("Model size mismatch"); }
        const output = await open(partial, "wx", 0o600);
        let received = 0;
        const hash = createHash("sha256");
        try {
          for await (const chunk of response.body) {
            signal.throwIfAborted();
            received += chunk.length;
            if (received > file.size) throw new Error("Model too large");
            hash.update(chunk); await output.writeFile(chunk);
            progress(completed + received, total);
          }
        } finally { await output.close(); }
        signal.throwIfAborted();
        if (received !== file.size || hash.digest("hex") !== file.sha256) throw new Error("Model hash mismatch");
        await rename(partial, target);
        completed += file.size; progress(completed, total);
      } finally { await rm(partial, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {}); }
    }
  }
}
