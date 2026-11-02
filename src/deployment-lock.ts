import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
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

interface LockOwner { pid?: unknown; token?: unknown; bootId?: unknown }
interface BootIdentity { id: string; startedAt: number }

function ownerOf(lockPath: string): LockOwner | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(lockPath, "owner.json"), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

// This module is also downloaded and run alone as .ts before a package exists;
// keep OS discovery dependency-free rather than importing installed runtime code.
function bootIdentity(): BootIdentity | null {
  try {
    if (process.platform === "linux") {
      const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const seconds = readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1];
      if (id && seconds) return { id, startedAt: Number(seconds) * 1000 };
    } else if (process.platform === "darwin") {
      const read = (key: string) => {
        const result = spawnSync("/usr/sbin/sysctl", ["-n", key], { encoding: "utf8", timeout: 5000 });
        return result.status === 0 ? result.stdout.trim() : "";
      };
      const id = read("kern.bootsessionuuid");
      const seconds = read("kern.boottime").match(/\bsec\s*=\s*(\d+)/)?.[1];
      if (id && seconds) return { id, startedAt: Number(seconds) * 1000 };
    }
  } catch { /* Missing OS evidence must never authorize recovery. */ }
  return null;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

/** A different OS boot proves that the old owner AND all writers exited.
 * A dead PID, timeout, or process-name scan cannot provide that guarantee.
 */
function previousBootLock(lockPath: string) {
  const boot = bootIdentity();
  if (!boot || !/^[a-f\d-]+$/i.test(boot.id) || !Number.isFinite(boot.startedAt)
    || boot.startedAt <= 0 || boot.startedAt > Date.now()) return null;
  const before = lstatSync(lockPath);
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid?.()) return null;
  const ownerPath = path.join(lockPath, "owner.json");
  let ownerStat, raw: string;
  try {
    ownerStat = lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.uid !== before.uid) return null;
    raw = readFileSync(ownerPath, "utf8");
  } catch { return null; }
  let owner: LockOwner;
  try { owner = JSON.parse(raw); } catch { return null; }
  if (!owner || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0
    || typeof owner.token !== "string" || !owner.token) return null;
  if (typeof owner.bootId === "string" && owner.bootId) {
    if (owner.bootId === boot.id) return null;
  } else {
    // Legacy locks have no boot UUID. Use OS file metadata, not their claimed
    // createdAt or PID: a copied/touched lock is ambiguous and remains blocked.
    const latestChange = Math.max(before.ctimeMs, before.mtimeMs, ownerStat.ctimeMs, ownerStat.mtimeMs);
    if (!Number.isFinite(latestChange) || latestChange >= boot.startedAt - 1000) return null;
  }
  return { before, raw, boot };
}

/** Retire only when a complete replacement is ready; preserve all old evidence. */
function recoverPreviousBootLock(lockPath: string, ownerPid: number, token: string): string | null {
  const previous = previousBootLock(lockPath);
  if (!previous) return null;
  const { before, raw, boot } = previous;
  const ownerPath = path.join(lockPath, "owner.json");
  const claimRoot = path.join(lockPath, ".recovery-claim");
  mkdirSync(claimRoot, { recursive: true, mode: 0o700 });
  if (lstatSync(claimRoot).isSymbolicLink()) return null;
  // An interrupted recovery cannot leave an immortal second lock: each OS boot
  // gets its own atomic claim, and all earlier claims remain in the archive.
  const claim = path.join(claimRoot, boot.id);
  try { mkdirSync(claim, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  let archived = false;
  try {
    const current = lstatSync(lockPath);
    if (current.dev !== before.dev || current.ino !== before.ino || readFileSync(ownerPath, "utf8") !== raw) return null;
    const archive = mkdtempSync(`${lockPath}-recovered-`);
    cpSync(lockPath, path.join(archive, "lock"), { recursive: true, dereference: false, verbatimSymlinks: true });
    const pendingOwner = path.join(claim, "owner.json");
    writeFileSync(pendingOwner, `${JSON.stringify({ pid: ownerPid, token, createdAt: Date.now(), bootId: boot.id })}\n`, { mode: 0o600 });
    // Keep the directory in place throughout takeover: no unlocked gap in which
    // an older updater could start against the interrupted installation.
    renameSync(pendingOwner, ownerPath);
    archived = true;
    return archive;
  } finally {
    if (!archived) {
      // Never remove a competing owner's replacement directory.
      try {
        const current = lstatSync(lockPath);
        if (current.dev === before.dev && current.ino === before.ino) rmdirSync(claim);
      } catch { /* Leave uncertain evidence for the next recovery. */ }
    }
  }
}

function lockConflict(lockPath: string, recovery: boolean): Error {
  const owner = ownerOf(lockPath);
  const ownerState = Number.isSafeInteger(owner?.pid) && (owner!.pid as number) > 0
    ? pidAlive(owner!.pid as number) ? "进程仍存活（或 PID 已复用）" : "进程已退出，可能存在遗留写者或未完成事务"
    : "归属未知";
  const next = recovery
    ? "若此前更新已中断，请正常结束任务并重启系统后重新运行本安装入口；可核实的跨启动遗留锁会自动留档恢复，无需手动删锁。"
    : "请通过 install.sh 或 wand update:repair 核查并恢复安装。";
  return new Error(`另一个 wand 更新正在进行中或遗留安装锁尚未核实（锁: ${lockPath}${typeof owner?.pid === "number" ? `, PID ${owner.pid}` : ""}；${ownerState}）。旧安装未修改；${next}`);
}

/** Read-only preflight: do not unlock an incomplete install before downloading. */
export function assertRecoveryDeploymentLockAvailable(value: string, inherited: readonly DeploymentLock[] = []): void {
  try { lstatSync(path.resolve(value)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const lockPath = canonicalLockPath(value);
  const owner = ownerOf(lockPath);
  if (inherited.some(lock => lock.lockPath === lockPath && lock.token === owner?.token
    && lock.ownerPid === owner?.pid && pidAlive(lock.ownerPid)
    && (!owner?.bootId || owner.bootId === bootIdentity()?.id))) return;
  if (previousBootLock(lockPath)) return;
  throw lockConflict(lockPath, true);
}

/** Existing npm updaters and local deployment use the same atomic directory protocol. */
export function acquireDeploymentLock(
  value: string,
  options: {
    ownerPid?: number;
    inherited?: readonly DeploymentLock[];
    recoverAfterReboot?: boolean;
    note?: (message: string) => void;
  } = {},
): DeploymentLock {
  const lockPath = canonicalLockPath(value);
  const ownerPid = options.ownerPid ?? process.pid;
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error("无效的部署锁进程。");
  const owner = ownerOf(lockPath);
  const inherited = options.inherited?.find(lock => lock.lockPath === lockPath
    && lock.token === owner?.token && lock.ownerPid === owner?.pid && pidAlive(lock.ownerPid)
    && (!owner?.bootId || owner.bootId === bootIdentity()?.id));
  if (inherited) return { ...inherited, owned: false };
  const token = randomUUID();
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (options.recoverAfterReboot) {
      const archive = recoverPreviousBootLock(lockPath, ownerPid, token);
      if (archive) {
        options.note?.(`[wand-recovery] 已核实遗留锁来自上次系统启动，原锁留档于 ${archive}；安装备份保留。`);
        return { lockPath, token, ownerPid, owned: true };
      }
    }
    throw lockConflict(lockPath, options.recoverAfterReboot === true);
  }
  try {
    const boot = bootIdentity();
    writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({ pid: ownerPid, token, createdAt: Date.now(), ...(boot ? { bootId: boot.id } : {}) })}\n`, { mode: 0o600 });
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
