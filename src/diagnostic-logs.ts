import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync, type Stats } from "node:fs";
import path from "node:path";
import { assertPlainTempPath } from "./managed-temp.js";

export const DIAGNOSTIC_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DIAGNOSTIC_LOG_ROTATIONS = 3;
export const DIAGNOSTIC_LOG_RETENTION_DAYS = 14;
const FILES = new Set(["web.log", "web-error.log", "terminald.log", "terminald-error.log", "structured-stdout.log", "structured-stderr.log", "structured-spawns.jsonl"]);
export const DIAGNOSTIC_RECEIPT_SUFFIX = ".wand-log-receipt.json";

function checkFile(file: string): Stats | null {
  assertPlainTempPath(file);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Diagnostic log is not an owned file.");
    return stat;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function receipt(file: string): void {
  const stat = checkFile(file)!;
  const target = file + DIAGNOSTIC_RECEIPT_SUFFIX;
  checkFile(target);
  writeFileSync(target, JSON.stringify({ app: "wand-diagnostic-log", version: 1, device: stat.dev, inode: stat.ino,
    size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }), { mode: 0o600 });
}

export function diagnosticReceiptMatches(file: string): boolean {
  const stat = checkFile(file), marker = checkFile(file + DIAGNOSTIC_RECEIPT_SUFFIX);
  if (!stat || !marker || marker.size > 4096) return false;
  const fd = openSync(file + DIAGNOSTIC_RECEIPT_SUFFIX, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const value = JSON.parse(readFileSync(fd, "utf8"));
    return value.app === "wand-diagnostic-log" && value.version === 1 && value.device === stat.dev
      && value.inode === stat.ino && value.size === stat.size && value.mtimeMs === stat.mtimeMs && value.ctimeMs === stat.ctimeMs;
  } finally { closeSync(fd); }
}

/** Only redundant diagnostics: PTY history and native protocol sources never enter this writer. */
export function appendBoundedDiagnostic(file: string, data: string | Buffer, maxBytes = DIAGNOSTIC_LOG_MAX_BYTES, rotations = DIAGNOSTIC_LOG_ROTATIONS): void {
  if (!FILES.has(path.basename(file)) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(rotations) || rotations < 1 || rotations > 3) {
    throw new Error("Unknown diagnostic log or invalid limits.");
  }
  const target = path.join(realpathSync(path.dirname(file)), path.basename(file));
  let bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (bytes.length > maxBytes) bytes = bytes.subarray(bytes.length - maxBytes);
  const stat = checkFile(target);
  if (stat && stat.size + bytes.length > maxBytes) {
    // Preflight all slots before renaming: unknown/replaced files are never overwritten.
    for (let i = 1; i <= rotations; i++) {
      const old = `${target}.${i}`;
      const archive = checkFile(old), marker = checkFile(old + DIAGNOSTIC_RECEIPT_SUFFIX);
      if (archive ? !diagnosticReceiptMatches(old) : marker) throw new Error("Diagnostic archive ownership changed.");
    }
    const oldest = `${target}.${rotations}`;
    if (checkFile(oldest)) { unlinkSync(oldest); unlinkSync(oldest + DIAGNOSTIC_RECEIPT_SUFFIX); }
    for (let i = rotations - 1; i >= 1; i--) {
      const from = `${target}.${i}`, to = `${target}.${i + 1}`;
      if (checkFile(from)) {
        renameSync(from, to); unlinkSync(from + DIAGNOSTIC_RECEIPT_SUFFIX); receipt(to);
      }
    }
    renameSync(target, `${target}.1`); receipt(`${target}.1`);
  }
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const current = fstatSync(fd);
    if (!current.isFile() || (process.getuid && current.uid !== process.getuid())) throw new Error("Diagnostic output changed.");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  } finally { closeSync(fd); }
}

/** Attach only to launchd/file redirections matching this instance; keep TTYs and journald untouched. */
export function installServiceDiagnosticRotation(configDir: string, kind: "web" | "terminald"): () => void {
  const restore: (() => void)[] = [];
  for (const [stream, file, fd] of [[process.stdout, `${kind}.log`, 1], [process.stderr, `${kind}-error.log`, 2]] as const) {
    try {
      const target = path.join(realpathSync(configDir), file), stat = checkFile(target), output = fstatSync(fd);
      if (!stat || stat.dev !== output.dev || stat.ino !== output.ino) continue;
      const original = stream.write;
      stream.write = function(chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean {
        const cb = typeof encoding === "function" ? encoding : callback;
        try {
          appendBoundedDiagnostic(target, typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8") : Buffer.from(chunk));
          if (cb) queueMicrotask(() => cb(null));
          return true;
        } catch { return original.apply(stream, arguments as unknown as Parameters<typeof original>); }
      } as typeof stream.write;
      restore.push(() => { stream.write = original; });
    } catch { /* Never prevent startup or redirect unrelated output. */ }
  }
  return () => { for (const undo of restore) undo(); };
}

export function isDiagnosticArchive(name: string): boolean {
  return [...FILES].some(file => [1, 2, 3].some(index => name === `${file}.${index}`));
}
