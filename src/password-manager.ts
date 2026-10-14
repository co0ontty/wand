import crypto from "node:crypto";

export const DEFAULT_BROWSER_EXTENSION_BASE_URL = "https://home.huniu.fun:8183";
export const DEFAULT_PASSWORD_VAULT_ID = "personal";
export const DEFAULT_PASSWORD_VAULT_NAME = "Personal";

export type PasswordVaultItemType = "login" | "credit_card" | "identity" | "secure_note" | "passkey";

export interface PasswordVault {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface PasswordVaultItem {
  id: string;
  vaultId: string;
  type: PasswordVaultItemType;
  title: string;
  username?: string;
  password?: string;
  urls: string[];
  notes?: string;
  fields: Record<string, string>;
  tags: string[];
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  passwordUpdatedAt?: string;
}

export interface PasswordVaultItemInput {
  vaultId?: string;
  type?: PasswordVaultItemType;
  title?: string;
  username?: string;
  password?: string;
  urls?: string[];
  notes?: string;
  fields?: Record<string, unknown>;
  tags?: string[];
  favorite?: boolean;
}

export interface PasswordVaultItemFilter {
  q?: string;
  url?: string;
  type?: PasswordVaultItemType;
  vaultId?: string;
  includeArchived?: boolean;
  limit?: number;
}

interface PasswordIssue {
  itemId: string;
  title: string;
  kind: "weak_password" | "reused_password" | "missing_url" | "old_password" | "passkey_available";
  severity: "low" | "medium" | "high";
  message: string;
}

export interface PasswordSecurityReport {
  totalItems: number;
  loginItems: number;
  weakPasswords: number;
  reusedPasswords: number;
  missingUrls: number;
  oldPasswords: number;
  passkeyItems: number;
  issues: PasswordIssue[];
}

const ITEM_TYPES = new Set<PasswordVaultItemType>([
  "login",
  "credit_card",
  "identity",
  "secure_note",
  "passkey",
]);

const COMMON_WEAK_PASSWORDS = new Set([
  "123456",
  "123456789",
  "qwerty",
  "password",
  "111111",
  "abc123",
  "password1",
  "iloveyou",
]);

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizePasswordItemType(value: unknown): PasswordVaultItemType {
  return typeof value === "string" && ITEM_TYPES.has(value as PasswordVaultItemType)
    ? value as PasswordVaultItemType
    : "login";
}

export function normalizeVaultName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) {
    throw new Error("Vault name is required.");
  }
  if (name.length > 80) {
    throw new Error("Vault name must be 80 characters or fewer.");
  }
  return name;
}

export function normalizePasswordItemInput(input: PasswordVaultItemInput): Required<Pick<PasswordVaultItemInput, "type" | "title" | "urls" | "fields" | "tags" | "favorite">> & PasswordVaultItemInput {
  const type = normalizePasswordItemType(input.type);
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) {
    throw new Error("Item title is required.");
  }
  if (title.length > 160) {
    throw new Error("Item title must be 160 characters or fewer.");
  }
  return {
    ...input,
    type,
    title,
    username: cleanOptionalString(input.username, 320),
    password: cleanOptionalString(input.password, 4096),
    urls: normalizeUrls(input.urls),
    notes: cleanOptionalString(input.notes, 10000),
    fields: normalizeFields(input.fields),
    tags: normalizeTags(input.tags),
    favorite: input.favorite === true,
  };
}

function normalizeUrls(urls: unknown): string[] {
  if (!Array.isArray(urls)) return [];
  const out: string[] = [];
  for (const value of urls) {
    if (typeof value !== "string") continue;
    const normalized = normalizeStoredUrl(value);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out.slice(0, 20);
}

function normalizeStoredUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    return parsed.origin + normalizePathname(parsed.pathname);
  } catch {
    return null;
  }
}

function urlsMatch(storedUrl: string, pageUrl: string): boolean {
  try {
    const stored = new URL(normalizeStoredUrl(storedUrl) ?? storedUrl);
    const page = new URL(pageUrl);
    if (stored.protocol !== "http:" && stored.protocol !== "https:") return false;
    if (page.protocol !== "http:" && page.protocol !== "https:") return false;
    const storedHost = stored.hostname.toLowerCase();
    const pageHost = page.hostname.toLowerCase();
    const hostMatch = pageHost === storedHost || pageHost.endsWith(`.${storedHost}`);
    if (!hostMatch) return false;
    const storedPath = normalizePathname(stored.pathname);
    return storedPath === "/" || normalizePathname(page.pathname).startsWith(storedPath);
  } catch {
    return false;
  }
}

export function itemMatchesFilter(item: PasswordVaultItem, filter: PasswordVaultItemFilter): boolean {
  if (filter.type && item.type !== filter.type) return false;
  if (filter.vaultId && item.vaultId !== filter.vaultId) return false;
  if (filter.url && !item.urls.some((url) => urlsMatch(url, filter.url!))) return false;
  const q = filter.q?.trim().toLowerCase();
  if (q) {
    const haystack = [
      item.title,
      item.username,
      ...item.urls,
      ...item.tags,
      ...Object.values(item.fields),
    ].filter(Boolean).join("\n").toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

export function scorePasswordStrength(password: string | undefined): number {
  if (!password) return 0;
  const lower = password.toLowerCase();
  if (COMMON_WEAK_PASSWORDS.has(lower)) return 0;
  let score = Math.min(40, password.length * 3);
  if (/[a-z]/.test(password)) score += 10;
  if (/[A-Z]/.test(password)) score += 10;
  if (/\d/.test(password)) score += 10;
  if (/[^A-Za-z0-9]/.test(password)) score += 15;
  if (password.length >= 20) score += 15;
  if (/(.)\1{2,}/.test(password)) score -= 20;
  if (/^(?:[a-z]+|\d+)$/.test(password)) score -= 20;
  return Math.max(0, Math.min(100, score));
}

export function buildPasswordSecurityReport(items: PasswordVaultItem[], now = Date.now()): PasswordSecurityReport {
  const issues: PasswordIssue[] = [];
  const loginItems = items.filter((item) => item.type === "login");
  const passwordGroups = new Map<string, PasswordVaultItem[]>();
  let weakPasswords = 0;
  let missingUrls = 0;
  let oldPasswords = 0;
  let passkeyItems = 0;

  for (const item of items) {
    if (item.type === "passkey") passkeyItems += 1;
    if (item.type !== "login") continue;

    if (!item.urls.length) {
      missingUrls += 1;
      issues.push({
        itemId: item.id,
        title: item.title,
        kind: "missing_url",
        severity: "medium",
        message: "Login item has no website URL, so phishing checks and autofill matching are limited.",
      });
    }

    if (item.password) {
      const group = passwordGroups.get(item.password) ?? [];
      group.push(item);
      passwordGroups.set(item.password, group);

      if (scorePasswordStrength(item.password) < 50) {
        weakPasswords += 1;
        issues.push({
          itemId: item.id,
          title: item.title,
          kind: "weak_password",
          severity: "high",
          message: "Password is short, common, or lacks character variety.",
        });
      }
    }

    if (item.passwordUpdatedAt) {
      const ageMs = now - Date.parse(item.passwordUpdatedAt);
      if (Number.isFinite(ageMs) && ageMs > 365 * 24 * 60 * 60 * 1000) {
        oldPasswords += 1;
        issues.push({
          itemId: item.id,
          title: item.title,
          kind: "old_password",
          severity: "low",
          message: "Password has not been updated in over a year.",
        });
      }
    }

    if (item.fields.passkeyAvailable === "true") {
      issues.push({
        itemId: item.id,
        title: item.title,
        kind: "passkey_available",
        severity: "low",
        message: "This site can be upgraded to a passkey when browser WebAuthn integration is enabled.",
      });
    }
  }

  let reusedPasswords = 0;
  for (const group of passwordGroups.values()) {
    if (group.length < 2) continue;
    reusedPasswords += group.length;
    for (const item of group) {
      issues.push({
        itemId: item.id,
        title: item.title,
        kind: "reused_password",
        severity: "high",
        message: "This password is reused by another login item.",
      });
    }
  }

  return {
    totalItems: items.length,
    loginItems: loginItems.length,
    weakPasswords,
    reusedPasswords,
    missingUrls,
    oldPasswords,
    passkeyItems,
    issues: issues.sort((a, b) => issueRank(b.severity) - issueRank(a.severity)),
  };
}

export interface PasswordGeneratorOptions {
  length?: number;
  digits?: boolean;
  symbols?: boolean;
}

const VAULT_CIPHER_PREFIX = "enc:v1:";

function deriveVaultKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

/** AES-256-GCM at-rest wrapper. Legacy plaintext values pass through on read. */
export function encryptVaultSecret(plaintext: string, secret: string): string {
  if (!plaintext || !secret) return plaintext;
  if (plaintext.startsWith(VAULT_CIPHER_PREFIX)) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveVaultKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${VAULT_CIPHER_PREFIX}${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

/** Legacy v1 decrypt (appSecret-derived key). Refuses v2 ciphertext so it can never be mistaken for a plaintext token. Use decryptVaultSecretTyped. */
export function decryptVaultSecret(value: string | undefined, secret: string | null): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("enc:v2:")) throw new VaultDecryptError("malformed", "v2 ciphertext requires decryptVaultSecretTyped");
  if (!value.startsWith(VAULT_CIPHER_PREFIX)) return value;
  if (!secret) return undefined;
  try {
    const [ivB64, tagB64, dataB64] = value.slice(VAULT_CIPHER_PREFIX.length).split(".");
    if (!ivB64 || !tagB64 || !dataB64) return undefined;
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveVaultKey(secret), Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

/** Any ciphertext version (v1 legacy or v2 key-file). */
export function isEncryptedVaultSecret(value: string | undefined): boolean {
  return typeof value === "string" && (value.startsWith(VAULT_CIPHER_PREFIX) || value.startsWith("enc:v2:"));
}

// ── v2: random key file (see storage/vault-keys.ts). v1 above stays for legacy rows only. ──

const VAULT_CIPHER_PREFIX_V2 = "enc:v2:";

export type VaultDecryptReason = "missing-key" | "malformed" | "auth-failed";

/** Decrypt failure. Distinct from "no value" (which returns undefined) so callers never mistake loss for emptiness. */
export class VaultDecryptError extends Error {
  readonly reason: VaultDecryptReason;
  constructor(reason: VaultDecryptReason, message: string) {
    super(message);
    this.name = "VaultDecryptError";
    this.reason = reason;
  }
}

export interface VaultKeys {
  /** AES key derived from the key file (v2). Null when the key file is absent. */
  readonly cipherKey: Buffer | null;
  /** Legacy appSecret used only for v1 rows. */
  readonly legacySecret: string | null;
}

export function encryptVaultSecretV2(plaintext: string, cipherKey: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cipherKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${VAULT_CIPHER_PREFIX_V2}${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function isLegacyVaultSecret(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(VAULT_CIPHER_PREFIX);
}

export function isVaultSecretV2(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(VAULT_CIPHER_PREFIX_V2);
}

/**
 * Typed decrypt: empty input -> undefined; plaintext (pre-encryption rows) -> as is;
 * v1/v2 ciphertext -> plaintext, or throws VaultDecryptError. Never returns undefined for ciphertext.
 */
export function decryptVaultSecretTyped(value: string | null | undefined, keys: VaultKeys): string | undefined {
  if (!value) return undefined;
  if (isVaultSecretV2(value)) {
    if (!keys.cipherKey) throw new VaultDecryptError("missing-key", "vault key file is missing; encrypted values cannot be read");
    return openCiphertext(value.slice(VAULT_CIPHER_PREFIX_V2.length), keys.cipherKey);
  }
  if (isLegacyVaultSecret(value)) {
    if (!keys.legacySecret) throw new VaultDecryptError("missing-key", "legacy vault secret is unavailable");
    return openCiphertext(value.slice(VAULT_CIPHER_PREFIX.length), deriveVaultKey(keys.legacySecret));
  }
  return value;
}

function openCiphertext(body: string, key: Buffer): string {
  const [ivB64, tagB64, dataB64] = body.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new VaultDecryptError("malformed", "encrypted value is malformed");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new VaultDecryptError("auth-failed", "encrypted value failed authentication");
  }
}

// ── Admin password: scrypt at rest, constant-time verify. Legacy plaintext is still accepted. ──

const SCRYPT_PREFIX = "scrypt$";
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLength: 32 } as const;

export function isHashedAdminPassword(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(SCRYPT_PREFIX);
}

export function hashAdminPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keyLength, { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p });
  return `${SCRYPT_PREFIX}${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Verify a candidate against a stored scrypt hash or a legacy plaintext value, in constant time. */
export function verifyAdminPassword(candidate: string, stored: string | null | undefined): boolean {
  if (typeof stored !== "string" || stored.length === 0) return false;
  if (isHashedAdminPassword(stored)) {
    const parts = stored.split("$");
    if (parts.length !== 6) return false;
    const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
    const N = Number(nRaw), r = Number(rRaw), p = Number(pRaw);
    const salt = Buffer.from(saltB64 ?? "", "base64");
    const expected = Buffer.from(hashB64 ?? "", "base64");
    // Stored hashes come from a local DB and may be tampered with. Accept only
    // the parameters emitted by hashAdminPassword; otherwise an attacker could
    // turn a login attempt into an unbounded scrypt allocation/CPU workload.
    if (N !== SCRYPT_PARAMS.N || r !== SCRYPT_PARAMS.r || p !== SCRYPT_PARAMS.p
      || salt.length !== 16 || expected.length !== SCRYPT_PARAMS.keyLength) return false;
    try {
      const actual = crypto.scryptSync(candidate, salt, expected.length, { N, r, p });
      return crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
  // Legacy plaintext: compare digests so the comparison length does not leak.
  const a = crypto.createHash("sha256").update(candidate, "utf8").digest();
  const b = crypto.createHash("sha256").update(stored, "utf8").digest();
  return crypto.timingSafeEqual(a, b) && candidate === stored;
}

export function generatePassword(options: PasswordGeneratorOptions = {}): string {
  const length = clampInteger(options.length ?? 20, 8, 80);
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "!@#$%^&*-_=+?";
  const pools = [lower, upper];
  if (options.digits !== false) pools.push(digits);
  if (options.symbols !== false) pools.push(symbols);
  const alphabet = pools.join("");
  const chars = pools.map((pool) => randomChar(pool));
  while (chars.length < length) chars.push(randomChar(alphabet));
  return shuffle(chars).join("");
}

export function generateTotpCode(secret: string, timeMs = Date.now(), digits = 6, period = 30): string {
  const key = decodeTotpSecret(secret);
  const counter = Math.floor(timeMs / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  ) % (10 ** digits);
  return String(code).padStart(digits, "0");
}

function decodeTotpSecret(secret: string): Buffer {
  const cleaned = secret.replace(/\s+/g, "").replace(/=+$/g, "").toUpperCase();
  if (!cleaned) throw new Error("TOTP secret is required.");
  if (/^[0-9a-f]+$/i.test(cleaned) && cleaned.length % 2 === 0) {
    return Buffer.from(cleaned, "hex");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of cleaned) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("Invalid TOTP secret.");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function cleanOptionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function normalizeFields(fields: unknown): Record<string, string> {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    const normalizedKey = key.trim().slice(0, 80);
    if (!normalizedKey || value === undefined || value === null) continue;
    out[normalizedKey] = String(value).trim().slice(0, 4096);
  }
  return out;
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const value = tag.trim().slice(0, 60);
    if (value && !out.includes(value)) out.push(value);
  }
  return out.slice(0, 40);
}

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  return pathname.endsWith("/") ? pathname : `${pathname}/`;
}

function issueRank(severity: PasswordIssue["severity"]): number {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function randomChar(alphabet: string): string {
  return alphabet[crypto.randomInt(0, alphabet.length)]!;
}

function shuffle<T>(values: T[]): T[] {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [values[i], values[j]] = [values[j]!, values[i]!];
  }
  return values;
}
