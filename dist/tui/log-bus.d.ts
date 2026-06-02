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
/** 安装日志拦截。重复安装会先恢复再重装。 */
export declare function installLogBus(sink: LogSink): void;
/** 还原 console.* 与 stderr.write。多次调用安全。 */
export declare function restoreLogBus(): void;
/** 主动写入 TUI 日志面板（用于 wandError/wandWarn 等已识别路径）。
 *  非活跃时不做任何事，调用方应自行判断是否回退到原 stderr。 */
export declare function wandTuiLog(level: LogLevel, line: string): void;
export declare function isLogBusActive(): boolean;
