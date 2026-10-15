import { randomUUID } from "node:crypto";
import { constants, chownSync, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";

export const TEMP_ROOT_MARKER = ".wand-temporary-root.json";
export const TEMP_LEASE = ".wand-temporary-lease.json";
export const TEMP_KINDS = ["speech-check", "speech-voice", "speech-setup", "test-run", "upload-stage"] as const;
export type TempKind = typeof TEMP_KINDS[number];
const uid = (): number | null => process.getuid?.() ?? null;

export function systemTemporaryRoot(): string {
  return path.join(realpathSync(os.tmpdir()), `wand-transient-${uid() ?? "user"}`);
}

/** Keep test fixture Unix sockets below the platform path length limit. */
export function testTemporaryRoot(): string {
  return process.platform === "win32" ? systemTemporaryRoot()
    : path.join(realpathSync("/tmp"), `wand-transient-${uid() ?? "user"}`);
}

export function configTemporaryRoot(configDir: string): string {
  let base = path.resolve(configDir);
  const missing: string[] = [];
  for (;;) {
    try { base = realpathSync(base); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || base === path.dirname(base)) throw error;
      missing.unshift(path.basename(base)); base = path.dirname(base);
    }
  }
  return path.join(base, ...missing, "cache", "temporary");
}

/** Never follow a redirect beneath the trusted, canonical deployment/temp path. */
export function assertPlainTempPath(target: string): void {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("Temporary path contains a symbolic link.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === path.dirname(current)) break;
  }
}

function readMarker(file: string): Record<string, unknown> {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || (uid() !== null && stat.uid !== uid())) throw new Error("Invalid temporary marker.");
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid temporary marker.");
    return value as Record<string, unknown>;
  } finally { closeSync(fd); }
}

export function validateTemporaryRoot(root: string): void {
  assertPlainTempPath(root);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || (uid() !== null && (stat.uid !== uid() || (stat.mode & 0o077) !== 0))) {
    throw new Error("Temporary root is not private to this user.");
  }
  const marker = readMarker(path.join(root, TEMP_ROOT_MARKER));
  if (marker.app !== "wand-temporary" || marker.version !== 1 || marker.uid !== uid()) throw new Error("Unmanaged temporary root.");
}

export interface TempLease {
  app: "wand-temporary";
  version: 1;
  kind: TempKind;
  id: string;
  ownerPid: number;
  children: { pid: number; group: boolean }[];
}

export function readTemporaryLease(directory: string): TempLease {
  assertPlainTempPath(directory);
  const value = readMarker(path.join(directory, TEMP_LEASE));
  if (value.app !== "wand-temporary" || value.version !== 1 || !TEMP_KINDS.includes(value.kind as TempKind)
    || !path.basename(directory).startsWith(`${value.kind}-`) || typeof value.id !== "string"
    || !/^[a-f0-9-]{36}$/.test(value.id) || !Number.isSafeInteger(value.ownerPid) || (value.ownerPid as number) <= 0
    || !Array.isArray(value.children) || value.children.length > 16
    || value.children.some(child => !child || !Number.isSafeInteger(child.pid) || child.pid <= 0 || typeof child.group !== "boolean")) {
    throw new Error("Invalid temporary lease.");
  }
  return value as unknown as TempLease;
}

/** ESRCH alone establishes absence; permissions and unexpected errors fail closed. */
export function temporaryPidAlive(pid: number, group = false): boolean {
  try { process.kill(group && process.platform !== "win32" ? -pid : pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export function temporaryChildrenAlive(lease: TempLease): boolean {
  return lease.children.some(child => temporaryPidAlive(child.pid, child.group));
}

export function registerTemporaryChild(directory: string, pid: number | undefined, group = false): void {
  if (!pid) return;
  validateTemporaryRoot(path.dirname(directory));
  const lease = readTemporaryLease(directory);
  if (lease.ownerPid !== process.pid) throw new Error("Temporary lease belongs to another process.");
  lease.children = lease.children.filter(child => temporaryPidAlive(child.pid, child.group));
  if (!lease.children.some(child => child.pid === pid)) lease.children.push({ pid, group });
  const file = path.join(directory, TEMP_LEASE);
  const pending = path.join(directory, `${TEMP_LEASE}.${randomUUID()}.tmp`);
  writeFileSync(pending, JSON.stringify(lease), { mode: 0o600, flag: "wx" });
  renameSync(pending, file);
}

export function createManagedTemporary(kind: TempKind, root = systemTemporaryRoot()): { directory: string; close(): boolean; closeAsync(): Promise<boolean> } {
  if (!TEMP_KINDS.includes(kind)) throw new Error("Unknown temporary purpose.");
  assertPlainTempPath(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const marker = path.join(root, TEMP_ROOT_MARKER);
  try {
    writeFileSync(marker, JSON.stringify({ app: "wand-temporary", version: 1, uid: uid() }), { mode: 0o600, flag: "wx" });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  validateTemporaryRoot(root);
  // macOS inherits /private/tmp's wheel group; fixtures should retain the caller's group semantics.
  if (process.getgid && uid() !== null && lstatSync(root).gid !== process.getgid()) chownSync(root, uid()!, process.getgid());
  const directory = mkdtempSync(path.join(root, `${kind}-`));
  const lease: TempLease = { app: "wand-temporary", version: 1, kind, id: randomUUID(), ownerPid: process.pid, children: [] };
  try { writeFileSync(path.join(directory, TEMP_LEASE), JSON.stringify(lease), { mode: 0o600, flag: "wx" }); }
  catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
  const removable = () => {
    validateTemporaryRoot(root);
    const current = readTemporaryLease(directory);
    return current.id === lease.id && current.ownerPid === process.pid && !temporaryChildrenAlive(current);
  };
  const absent = () => {
    try { lstatSync(directory); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  };
  return { directory, close() {
    try {
      if (!removable()) return false;
      rmSync(directory, { recursive: true, force: true });
      return true;
    } catch { return absent(); }
  }, async closeAsync() {
    try {
      if (!removable()) return false;
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return true;
    } catch { return absent(); }
  } };
}
