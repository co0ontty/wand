/**
 * TUI 日志总线：当 TUI 运行时，劫持 console.* 与 process.stderr.write，
 * 把所有运行期日志路由到 TUI 的 log 面板。
 *
 * 故意不劫持 process.stdout.write —— blessed 自身的渲染走 stdout，
 * 劫持会形成自循环。所有"启动期"经过 stdout 的写入都发生在 TUI 启动之前，
 * 不需要捕获。
 */

export type LogLevel = "info" | "warn" | "error";
export interface LogRecord {
  level: LogLevel;
  line: string;
  ts: number;
}

export type LogSink = (record: LogRecord) => void;

interface OriginalRefs {
  consoleLog: typeof console.log;
  consoleInfo: typeof console.info;
  consoleWarn: typeof console.warn;
  consoleError: typeof console.error;
  stderrWrite: typeof process.stderr.write;
}

let original: OriginalRefs | null = null;
let activeSink: LogSink | null = null;
let inSink = false;

function emit(level: LogLevel, args: unknown[]): void {
  if (!activeSink) return;
  if (inSink) {
    // 防止 sink 内部异常或日志再触发劫持函数导致雪崩。
    if (original) {
      const text = stringifyArgs(args);
      original.stderrWrite.call(process.stderr, text + "\n");
    }
    return;
  }
  const text = stringifyArgs(args);
  for (const line of splitLines(text)) {
    if (line.length === 0) continue;
    inSink = true;
    try {
      activeSink({ level, line, ts: Date.now() });
    } catch (err) {
      if (original) {
        original.stderrWrite.call(process.stderr, `[log-bus] sink threw: ${String(err)}\n`);
      }
    } finally {
      inSink = false;
    }
  }
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n").map((s) => s.replace(/\s+$/, ""));
}

/** 安装日志拦截。重复安装会先恢复再重装。 */
export function installLogBus(sink: LogSink): void {
  if (original) restoreLogBus();
  original = {
    consoleLog: console.log,
    consoleInfo: console.info,
    consoleWarn: console.warn,
    consoleError: console.error,
    stderrWrite: process.stderr.write.bind(process.stderr),
  };
  activeSink = sink;

  console.log = (...args: unknown[]) => emit("info", args);
  console.info = (...args: unknown[]) => emit("info", args);
  console.warn = (...args: unknown[]) => emit("warn", args);
  console.error = (...args: unknown[]) => emit("error", args);

  process.stderr.write = ((chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean => {
    const text =
      typeof chunk === "string"
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString(typeof encodingOrCb === "string" ? (encodingOrCb as BufferEncoding) : "utf8")
          : String(chunk);
    emit("error", [text]);
    if (typeof encodingOrCb === "function") (encodingOrCb as () => void)();
    else if (typeof cb === "function") (cb as () => void)();
    return true;
  }) as typeof process.stderr.write;
}

/** 还原 console.* 与 stderr.write。多次调用安全。 */
export function restoreLogBus(): void {
  if (!original) return;
  console.log = original.consoleLog;
  console.info = original.consoleInfo;
  console.warn = original.consoleWarn;
  console.error = original.consoleError;
  process.stderr.write = original.stderrWrite;
  original = null;
  activeSink = null;
}

/** 主动写入 TUI 日志面板（用于 wandError/wandWarn 等已识别路径）。
 *  非活跃时不做任何事，调用方应自行判断是否回退到原 stderr。 */
export function wandTuiLog(level: LogLevel, line: string): void {
  if (!activeSink) return;
  emit(level, [line]);
}

export function isLogBusActive(): boolean {
  return activeSink !== null;
}
