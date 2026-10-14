import crypto from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Vault master key for at-rest secrets (password items, connector tokens).
 *
 * The key is random, lives in a 0600 file next to the database (outside SQLite),
 * and is never derived from anything stored in the same database. The legacy
 * v1 scheme derived its key from `appSecret`, which *is* stored in the database,
 * so it is only read here to decrypt pre-existing rows during re-encryption.
 */

const KEY_FILE_NAME = "wand-vault.key";
const KEY_BYTES = 32;
const HKDF_SALT = "wand-vault-v2";
const HKDF_INFO = "aes-256-gcm";

export function vaultKeyPath(dbPath: string): string {
  return path.join(path.dirname(dbPath), KEY_FILE_NAME);
}

/** Derive the AES-256 key actually used for ciphertext from the random key-file material. */
export function deriveVaultCipherKey(raw: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", raw, Buffer.from(HKDF_SALT, "utf8"), Buffer.from(HKDF_INFO, "utf8"), 32));
}

function readRawKey(file: string, repairPermissions = false): Buffer | null {
  let stat;
  try { stat = lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile()) throw new Error(`[wand] vault key path is not a regular file: ${file}`);
  // Only the writable storage owner repairs mode bits; readonly consumers must not mutate files.
  if (repairPermissions) chmodSync(file, 0o600);
  const raw = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  if (raw.length !== KEY_BYTES) throw new Error(`[wand] vault key file is malformed: ${file}`);
  return raw;
}

/**
 * Read the key without creating it (used by read-only consumers).
 * Returns null when the file is absent.
 */
export function readVaultKey(dbPath: string): Buffer | null {
  return readRawKey(vaultKeyPath(dbPath));
}

/** Writable application path: repair key-file permissions before returning key material. */
export function readVaultKeyForWrite(dbPath: string): Buffer | null {
  return readRawKey(vaultKeyPath(dbPath), true);
}

/**
 * Create the key file atomically if it is missing and return the key.
 * Write to a private temp file, then `link` it into place: link fails if
 * another process won the race, in which case we read the winner's key.
 */
export function createVaultKey(dbPath: string): Buffer {
  const file = vaultKeyPath(dbPath);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const raw = crypto.randomBytes(KEY_BYTES);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${raw.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600);
  try {
    linkSync(tmp, file);
    return raw;
  } catch (error) {
    const existing = readRawKey(file);
    if (existing) return existing;
    throw error;
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Load the key, creating it only when `allowCreate` is set. */
export function loadVaultKey(dbPath: string, allowCreate: boolean): Buffer | null {
  const existing = readVaultKeyForWrite(dbPath);
  if (existing) return existing;
  return allowCreate ? createVaultKey(dbPath) : null;
}

