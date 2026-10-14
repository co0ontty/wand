import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, watch, writeSync, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createUtf8TextDecoder } from "./structured-exec-host.js";

const READ_CHUNK_BYTES = 64 * 1024;
const READ_TICK_BYTES = 256 * 1024;
const FILE_MAX_BYTES = 64 * 1024 * 1024;
const POLL_MS = 100;

export interface PiOutputFileOptions {
  /** Production files live under the session's artifact directory. Omit for an ephemeral local/test run. */
  directory?: string;
  onCreated?(file: string): void;
  /** Test seams; production uses the bounded defaults above. */
  maxBytes?: number;
  pollMs?: number;
}

/**
 * Pi's protocol consumer reads this file, never the captured stdout chunk.
 * Watch notifications are hints; an offset-based poll closes missed-event gaps.
 * Each capture/recovery incarnation owns a new private append-only file, so an
 * old observer cannot rewrite or consume another turn's output.
 *
 * The existing exec host still owns the CLI. Server downtime is recovered from
 * its replay log; this parser pilot is not an independent daemon-side journal.
 */
export class PiOutputFile {
  readonly file: string;
  private readonly dir: string;
  private readonly temporary: boolean;
  private readonly maxBytes: number;
  private writer = -1;
  private reader = -1;
  private offset = 0;
  private writtenBytes = 0;
  private readonly decoder = createUtf8TextDecoder();
  private readonly buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private scheduled: NodeJS.Immediate | null = null;
  private disposed = false;

  constructor(
    options: PiOutputFileOptions,
    private readonly isActive: () => boolean,
    private readonly onData: (text: string) => void,
    private readonly onError: (error: Error) => void,
  ) {
    this.temporary = options.directory === undefined;
    this.maxBytes = options.maxBytes ?? FILE_MAX_BYTES;
    if (options.directory) mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    this.dir = mkdtempSync(path.join(options.directory ?? os.tmpdir(), "pi-events-"));
    this.file = path.join(this.dir, "stdout.jsonl");
    try {
      this.writer = openSync(this.file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND, 0o600);
      this.reader = openSync(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      options.onCreated?.(this.file);
      try {
        this.watcher = watch(this.dir, { persistent: false }, () => this.schedule());
        this.watcher.on("error", () => { this.watcher?.close(); this.watcher = null; });
      } catch { /* Polling remains authoritative when watch is unavailable. */ }
      this.timer = setInterval(() => this.consume(), options.pollMs ?? POLL_MS);
      this.timer.unref();
    } catch (error) {
      this.dispose();
      // Only remove the brand-new file incarnation from a failed preflight.
      rmSync(this.dir, { recursive: true, force: true });
      throw error;
    }
  }

  append(text: string): void {
    if (this.disposed || !text) return;
    const bytes = Buffer.from(text);
    const size = fstatSync(this.writer).size;
    if (size + bytes.length > this.maxBytes) throw new Error("Pi 实时事件文件超过容量上限；本轮送达结果未知，不自动重试。");
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(this.writer, bytes, written, bytes.length - written);
      if (count === 0) throw new Error("Pi 实时事件文件未能写入；本轮送达结果未知，不自动重试。");
      written += count;
    }
    this.writtenBytes = size + written;
    // Do not feed the parser here. Only the independent reader supplies text.
  }

  /** Exit/recovery barriers drain all committed bytes before finalizing a turn. */
  drain(): void {
    this.read(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.scheduled) clearImmediate(this.scheduled);
    this.watcher?.close();
    this.watcher = null;
    this.timer = null;
    this.scheduled = null;
    for (const fd of [this.writer, this.reader]) {
      if (fd >= 0) { try { closeSync(fd); } catch { /* best-effort observer teardown */ } }
    }
    this.writer = this.reader = -1;
    this.decoder.end();
    if (this.temporary) rmSync(this.dir, { recursive: true, force: true });
  }

  private schedule(): void {
    if (this.disposed || this.scheduled) return;
    this.scheduled = setImmediate(() => { this.scheduled = null; this.consume(); });
  }

  private consume(): void {
    if (this.disposed) return;
    if (!this.isActive()) { this.dispose(); return; }
    try { this.read(false); }
    catch (error) {
      this.dispose();
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private read(all: boolean): void {
    if (this.disposed) return;
    if (!this.isActive()) { this.dispose(); return; }
    const opened = fstatSync(this.reader);
    const current = lstatSync(this.file);
    if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino
      || opened.size < this.offset || opened.size < this.writtenBytes) {
      throw new Error("Pi 实时事件文件被替换或截断；本轮送达结果未知，不自动重试。");
    }
    if (opened.size > this.maxBytes) throw new Error("Pi 实时事件文件超过容量上限；本轮送达结果未知，不自动重试。");
    const end = Math.min(opened.size, this.offset + (all ? this.maxBytes : READ_TICK_BYTES));
    while (!this.disposed && this.offset < end) {
      const count = readSync(this.reader, this.buffer, 0, Math.min(this.buffer.length, end - this.offset), this.offset);
      if (!count) throw new Error("Pi 实时事件文件读取不完整；本轮送达结果未知，不自动重试。");
      this.offset += count;
      const text = this.decoder.write(this.buffer.subarray(0, count));
      if (text) this.onData(text);
    }
    if (!all && this.offset < opened.size) this.schedule();
  }
}
