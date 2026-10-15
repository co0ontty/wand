import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DeploymentLock {
  lockPath: string;
  token: string;
  ownerPid: number;
  owned: boolean;
}

function canonicalLockPath(value: string): string {
  const absolute = path.resolve(value);
  mkdirSync(path.dirname(absolute), { recursive: true });
  return path.join(realpathSync(path.dirname(absolute)), path.basename(absolute));
}

function ownerOf(lockPath: string): { pid?: unknown; token?: unknown } | null {
  try { return JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8")); }
  catch { return null; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Existing npm updaters and local deployment use the same atomic directory protocol. */
export function acquireDeploymentLock(
  value: string,
  options: { ownerPid?: number; inherited?: readonly DeploymentLock[] } = {},
): DeploymentLock {
  const lockPath = canonicalLockPath(value);
  const ownerPid = options.ownerPid ?? process.pid;
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error("无效的部署锁进程。");
  const owner = ownerOf(lockPath);
  const inherited = options.inherited?.find(lock => lock.lockPath === lockPath
    && lock.token === owner?.token && lock.ownerPid === owner?.pid && pidAlive(lock.ownerPid));
  if (inherited) return { ...inherited, owned: false };
  const token = randomUUID();
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const ownerState = Number.isSafeInteger(owner?.pid) && (owner!.pid as number) > 0
      ? pidAlive(owner!.pid as number) ? "进程仍存活" : "进程已退出，可能存在遗留写者或未完成事务"
      : "归属未知";
    throw new Error(`另一个 wand 更新正在进行中或遗留安装锁尚未核实（锁: ${lockPath}${typeof owner?.pid === "number" ? `, PID ${owner.pid}` : ""}；${ownerState}）。旧安装未修改；未自动删除锁，请先核查安装子进程、备份与事务状态。`);
  }
  try {
    writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({ pid: ownerPid, token, createdAt: Date.now() })}\n`, { mode: 0o600 });
  } catch (error) {
    // No other cooperative writer can have acquired the directory we just created.
    rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }
  return { lockPath, token, ownerPid, owned: true };
}

export function releaseDeploymentLock(lock: DeploymentLock): void {
  if (!lock.owned) return;
  const owner = ownerOf(lock.lockPath);
  if (owner?.token === lock.token && owner.pid === lock.ownerPid) {
    rmSync(lock.lockPath, { recursive: true, force: true });
  }
}

export function acquireDeploymentLocks(paths: readonly string[], ownerPid = process.pid): DeploymentLock[] {
  const acquired: DeploymentLock[] = [];
  try {
    for (const lockPath of [...new Set(paths)]) acquired.push(acquireDeploymentLock(lockPath, { ownerPid }));
    return acquired;
  } catch (error) {
    for (const lock of acquired.reverse()) releaseDeploymentLock(lock);
    throw error;
  }
}

function receipts(raw: string): DeploymentLock[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("无效的部署锁回执。");
  return parsed.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("无效的部署锁回执。");
    const lock = item as DeploymentLock;
    if (typeof lock.lockPath !== "string" || !path.isAbsolute(lock.lockPath)
      || typeof lock.token !== "string" || !Number.isSafeInteger(lock.ownerPid) || lock.ownerPid <= 0
      || typeof lock.owned !== "boolean") throw new Error("无效的部署锁回执。");
    return lock;
  });
}

async function runProjectCommand(command: string[]): Promise<void> {
  if (!command.length) throw new Error("部署锁缺少执行命令。");
  const inherited = process.env.WAND_DEPLOYMENT_LOCKS ? receipts(process.env.WAND_DEPLOYMENT_LOCKS) : [];
  const lock = acquireDeploymentLock(path.join(process.cwd(), ".wand-build-lock"), { inherited });
  try {
    const env = { ...process.env, WAND_DEPLOYMENT_LOCKS: JSON.stringify([...inherited, lock]) };
    const child = spawn(command[0]!, command.slice(1), { stdio: "inherit", env, detached: process.platform !== "win32" });
    let interrupted: NodeJS.Signals | null = null;
    const interrupt = (signal: NodeJS.Signals) => {
      interrupted = signal;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const onInt = () => interrupt("SIGINT");
    const onTerm = () => interrupt("SIGTERM");
    process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
    try {
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", code => resolve(code));
      });
      // npm can exit before a grandchild finishes handling the signal. Keep the lease
      // until every writer in this owned build/check process group has actually gone.
      if (process.platform !== "win32" && child.pid) {
        while (true) {
          try { process.kill(-child.pid, 0); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
            throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : status ?? 1;
    } finally {
      process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
    }
  } finally {
    releaseDeploymentLock(lock);
  }
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "--run-project") {
    if (args.shift() !== "--") throw new Error("部署锁命令需用 -- 分隔。");
    await runProjectCommand(args);
    return;
  }
  if (args[0] !== "--owner-pid" || !/^\d+$/.test(args[1] ?? "")) throw new Error("部署锁需要 owner-pid。");
  const pid = Number(args[1]); args.splice(0, 2);
  if (mode === "--acquire") {
    const paths: string[] = [];
    while (args.length) {
      if (args.shift() !== "--lock" || !args.length) throw new Error("无效的部署锁路径参数。");
      paths.push(args.shift()!);
    }
    if (!paths.length) throw new Error("部署锁路径不能为空。");
    process.stdout.write(JSON.stringify(acquireDeploymentLocks(paths, pid)));
  } else if (mode === "--release") {
    if (args.length) throw new Error("释放部署锁不接受多余参数。");
    const locks = receipts(readFileSync(0, "utf8"));
    if (locks.some(lock => lock.ownerPid !== pid)) throw new Error("部署锁归属不匹配。");
    for (const lock of locks.reverse()) releaseDeploymentLock(lock);
  } else {
    throw new Error("未知部署锁操作。");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
