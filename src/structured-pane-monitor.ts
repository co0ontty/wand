import { stripVTControlCharacters } from "node:util";
import { createUtf8TextDecoder } from "./structured-exec-host.js";

const MAX_PENDING_CHARS = 64 * 1024;
const FLUSH_CHARS = 16 * 1024;

/** Best-effort terminal projection. The authoritative protocol journal never passes through here. */
export class StructuredPaneMonitor {
  private readonly startedAt = Date.now();
  private readonly decoders = { stdout: createUtf8TextDecoder(), stderr: createUtf8TextDecoder() };
  private readonly bytes = { stdout: 0, stderr: 0 };
  private pending = "";
  private pendingStatus = "";
  private finishing = false;
  private dropped = 0;
  private disabled = false;
  private blocked = false;
  private phase = "正在启动";
  private pid: number | null = null;
  private lastOutputAt: number | null = null;
  private lastStream: "stdout" | "stderr" | null = null;
  private readonly flushTimer: ReturnType<typeof setInterval>;
  private readonly statusTimer: ReturnType<typeof setInterval>;
  private readonly onError = (): void => { this.dispose(); };
  private readonly onDrain = (): void => { this.blocked = false; this.flush(); };

  constructor(runId: string, private readonly terminal: NodeJS.WriteStream = process.stdout) {
    terminal.on("error", this.onError);
    terminal.on("drain", this.onDrain);
    this.flushTimer = setInterval(() => this.flush(), 50);
    this.statusTimer = setInterval(() => this.status(), 10_000);
    this.flushTimer.unref(); this.statusTimer.unref();
    this.enqueue(`Wand · 结构化执行监视\n会话：${this.safe(runId)}\n显示实时 stdout/stderr；消息与问答请通过 Wand 提交。\nCtrl-b d 分离；Ctrl-C 会中断当前执行。\n`);
    this.status();
    this.flush();
  }

  running(pid: number): void { this.pid = pid; this.phase = "运行中"; this.status(); }
  stopping(reason: string): void { this.phase = `正在停止（${this.safe(reason)}）`; this.status(); }

  output(stream: "stdout" | "stderr", chunk: Buffer): void {
    this.bytes[stream] += chunk.length;
    this.lastOutputAt = Date.now();
    if (this.disabled) return;
    const text = this.safe(this.decoders[stream].write(chunk));
    if (!text) return;
    if (this.lastStream !== stream) this.enqueue(`\n[${stream}]\n`);
    this.lastStream = stream;
    this.enqueue(text);
  }

  finish(exitCode: number | null, signal: string | null, failure?: string): void {
    this.finishing = true;
    this.phase = failure ? `失败（${this.safe(failure)}）` : signal ? `已停止（${this.safe(signal)}）` : `已退出（exit ${exitCode ?? "unknown"}）`;
    this.status();
    this.flush();
    clearInterval(this.flushTimer); clearInterval(this.statusTimer);
  }

  dispose(): void {
    this.disabled = true;
    this.pending = "";
    clearInterval(this.flushTimer); clearInterval(this.statusTimer);
    this.terminal.off("drain", this.onDrain);
    // Keep the error handler installed: losing a monitor must never terminate the CLI.
  }

  private safe(text: string): string {
    return stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  }

  private status(): void {
    const quiet = this.lastOutputAt === null ? "等待首条输出" : `距最近输出 ${Math.floor((Date.now() - this.lastOutputAt) / 1000)} 秒`;
    this.pendingStatus = `\n[状态 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${this.phase} · PID ${this.pid ?? "待分配"} · 已运行 ${Math.floor((Date.now() - this.startedAt) / 1000)} 秒 · stdout ${this.bytes.stdout} B / stderr ${this.bytes.stderr} B · ${quiet}\n`;
    this.lastStream = null;
  }

  private enqueue(text: string): void {
    if (this.disabled) return;
    const capacity = Math.max(0, MAX_PENDING_CHARS - this.pending.length);
    this.pending += text.slice(0, capacity);
    this.dropped += Math.max(0, text.length - capacity);
  }

  private flush(): void {
    if (this.disabled || this.blocked) return;
    if (this.pendingStatus) {
      const status = this.pendingStatus; this.pendingStatus = "";
      try { this.blocked = !this.terminal.write(status); } catch { this.dispose(); }
      if (this.disabled || this.blocked) return;
    }
    if (this.dropped && this.pending.length < MAX_PENDING_CHARS / 2) {
      this.pending += `\n[监视提示] 输出过快，面板省略 ${this.dropped} 个字符；完整输出仍保留在 Wand 执行日志中。\n`;
      this.dropped = 0;
    }
    if (!this.pending) return;
    let end = Math.min(FLUSH_CHARS, this.pending.length);
    const last = this.pending.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    const chunk = this.pending.slice(0, end);
    this.pending = this.pending.slice(end);
    try { this.blocked = !this.terminal.write(chunk); }
    catch { this.dispose(); }
    if (this.finishing && !this.blocked && this.pending && !this.disabled) setImmediate(() => this.flush());
  }
}
