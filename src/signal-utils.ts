/**
 * Unix 信号名与编号之间的互转。
 *
 * Node 只在这些编号上给出稳定语义（Linux/macOS 一致），其余平台差异较大，
 * 因此这里固定一张小表，未知编号回落 SIGTERM、未知名字回落 0。
 */

const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
};

const SIGNAL_NAMES: ReadonlyMap<number, NodeJS.Signals> = new Map(
  Object.entries(SIGNAL_NUMBERS).map(([name, number]) => [number, name as NodeJS.Signals]),
);

/** 名字 → 编号；未知名字返回 0（与 waitpid 的"无信号"一致）。 */
export function signalNumberFromName(signal: string): number {
  return SIGNAL_NUMBERS[signal] ?? 0;
}

/** 编号 → 名字；0 / null 表示没有信号，未知编号回落 SIGTERM。 */
export function signalNameFromNumber(signal: number | null): NodeJS.Signals | null {
  if (signal === null || signal === 0) return null;
  return SIGNAL_NAMES.get(signal) ?? "SIGTERM";
}
