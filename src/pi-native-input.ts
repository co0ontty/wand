import { randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Private per-execution mailbox; never a client request path or an SDK runtime. */
export interface PiInputHandoff {
  id: string;
  boundaryId: string;
  incarnationId: string;
}
export interface PiInputOffer extends PiInputHandoff { text: string; }
export interface PiInputResolution {
  state: "committed" | "unclaimed" | "unknown";
  offer?: PiInputOffer;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_MAILBOX_BYTES = 8 * 1024 * 1024;

export function nativeInputFile(directory: string, boundaryId: string, name: string): string {
  if (!UUID.test(boundaryId)) throw new Error("Pi 输入边界标识无效。");
  return path.join(directory, boundaryId, name + ".json");
}
export function writeNativeInput(file: string, value: unknown): void {
  const temporary = file + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}
export function readNativeInput<T>(file: string): T | null {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_MAILBOX_BYTES) throw new Error("Pi 输入邮箱无效或超过容量。");
    return JSON.parse(readFileSync(fd, "utf8")) as T;
  } finally { closeSync(fd); }
}
export function openNativeInputBoundary(directory: string): string {
  const id = randomUUID();
  mkdirSync(path.join(directory, id), { recursive: true, mode: 0o700 });
  writeNativeInput(nativeInputFile(directory, id, "request"), { id });
  return id;
}
/** Queue reservation is synchronous and durable before publishing the response. */
export function offerNativeInput(
  directory: string, boundaryId: string, incarnationId: string,
  take: (identity: PiInputHandoff) => string | null,
): boolean {
  const file = (name: string) => nativeInputFile(directory, boundaryId, name);
  if (readNativeInput<{ id: string }>(file("request"))?.id !== boundaryId
    || existsSync(file("closed")) || existsSync(file("response")) || existsSync(file("claimed"))) return false;
  const identity = { id: randomUUID(), boundaryId, incarnationId };
  const text = take(identity);
  writeNativeInput(file("response"), text === null ? null : { ...identity, text } satisfies PiInputOffer);
  return true;
}
/** Claim precedes any native transcript mutation; an absent claim is safe to release after close/exit. */
export function claimNativeInput(directory: string, boundaryId: string): PiInputOffer | null | undefined {
  const response = nativeInputFile(directory, boundaryId, "response");
  if (!existsSync(response)) return undefined;
  const claimed = nativeInputFile(directory, boundaryId, "claimed");
  renameSync(response, claimed);
  const offer = readNativeInput<PiInputOffer>(claimed);
  if (offer === null) return null;
  if (!UUID.test(offer.id) || offer.boundaryId !== boundaryId || !UUID.test(offer.incarnationId)
    || typeof offer.text !== "string" || !offer.text.trim()) throw new Error("Pi 输入交接内容无效。");
  return offer;
}
export function resolveNativeInput(directory: string, handoff: PiInputHandoff, exited: boolean): PiInputResolution {
  const file = (name: string) => nativeInputFile(directory, handoff.boundaryId, name);
  const committed = readNativeInput<PiInputOffer>(file("committed"));
  if (committed?.id === handoff.id && committed.incarnationId === handoff.incarnationId) {
    return { state: "committed", offer: committed };
  }
  if (!existsSync(file("claimed")) && (exited || existsSync(file("closed")))) return { state: "unclaimed" };
  return { state: "unknown" };
}
