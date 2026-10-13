import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PASSWORD_VAULT_ID, VaultDecryptError, decryptVaultSecretTyped, encryptVaultSecretV2, isVaultSecretV2, verifyAdminPassword, type VaultKeys, DEFAULT_PASSWORD_VAULT_NAME, itemMatchesFilter, normalizePasswordItemInput, normalizeVaultName, nowIso, type PasswordVault, type PasswordVaultItem, type PasswordVaultItemFilter, type PasswordVaultItemInput } from "../password-manager.js";
import { hashAuthToken } from "./auth-token.js";
import { loadVaultKey } from "./vault-keys.js";
import { PasswordVaultRow, PasswordVaultItemRow, ConnectorRow } from "./mappers.js";
import type { ConnectorMeta } from "./mappers.js";
import type { WandStorage } from "../storage.js";
import { AuthPrincipal, PersistedAuthSession, mapPasswordVaultRow, PasswordItemRowFields, decodePasswordFields, mapPasswordItemRow, parseAuthPrincipal } from "./internal.js";

/** Secrets storage: one domain of the WandStorage facade. Shares the connection and the facade's transaction. */
export class SecretsRepository {
  /** AES key from the random key file (never from the database). Null until openVault(). */
  private cipherKey: Buffer | null = null;
  /** Legacy v1 secret (appSecret), used only to read and convert pre-v2 rows. */
  private legacySecret: string | null = null;

  constructor(private readonly db: DatabaseSync, private readonly s: WandStorage) {}

  /** Get password from database */
  getPassword(): string | null {
    return this.s.getConfigValue("password");
  }

  /** Set password in database */
  setPassword(password: string): void {
    this.s.setConfigValue("password", password);
  }

  /** Check if password has been set (not default) */
  hasCustomPassword(): boolean {
    return this.getPassword() !== null;
  }

  /** Get appSecret from database (used to mint Android appTokens) */
  getAppSecret(): string | null {
    return this.s.getConfigValue("appSecret");
  }

  /** Persist appSecret in database (DB is the authoritative source after first migration) */
  setAppSecret(value: string): void {
    this.s.setConfigValue("appSecret", value);
    this.legacySecret = value;
  }

  /**
   * Constant-time check against the stored admin password (scrypt hash or legacy plaintext).
   * NOT YET WIRED: login still compares plaintext (server.ts getEffectivePassword, cli-api.ts).
   * Switching storage to a hash also changes app-token derivation (HMAC over the plaintext password),
   * which would invalidate paired devices; that is a product decision and is not done here.
   */
  verifyPassword(candidate: string): boolean {
    return verifyAdminPassword(candidate, this.s.getConfigValue("password"));
  }

  /** Vault key material; the cipher key comes from the key file, never from the database. */
  private vaultKeys(): VaultKeys {
    return { cipherKey: this.cipherKey, legacySecret: this.legacySecret };
  }

  /** Load the key file (created only when no v2 ciphertext depends on a missing one) and convert legacy rows. */
  /** Called once by the facade constructor: load (or create) the key file and convert legacy rows. */
  openVault(): void {
    const hasV2 = this.hasEncryptedVaultRows("enc:v2:");
    this.cipherKey = loadVaultKey(this.s.databasePath(), !hasV2);
    if (!this.cipherKey && hasV2) {
      console.error("[wand] vault key file is missing; encrypted secrets cannot be read until it is restored");
    }
    this.legacySecret = this.getAppSecret();
    this.reencryptLegacyVaultRows();
  }

  private hasEncryptedVaultRows(prefix: string): boolean {
    const pattern = `${prefix}%`;
    const item = this.db.prepare("SELECT 1 FROM password_items WHERE password LIKE ? OR notes LIKE ? OR fields LIKE ? LIMIT 1")
      .get(pattern, pattern, pattern);
    if (item) return true;
    return !!this.db.prepare("SELECT 1 FROM connectors WHERE token LIKE ? LIMIT 1").get(pattern);
  }

  private requireVaultCipherKey(): Buffer {
    if (this.cipherKey) return this.cipherKey;
    if (this.hasEncryptedVaultRows("enc:v2:")) {
      throw new VaultDecryptError("missing-key", "vault key file is missing; refusing to write secrets under a new key");
    }
    this.cipherKey = loadVaultKey(this.s.databasePath(), true);
    if (!this.cipherKey) throw new VaultDecryptError("missing-key", "vault key could not be created");
    return this.cipherKey;
  }

  /**
   * Idempotent pass: rewrite v1 ciphertext and any plaintext secret column to v2 under the key file.
   * Rows that cannot be read (no legacy secret, corrupt) are left as they are and counted.
   */
  private reencryptLegacyVaultRows(): number {
    if (!this.cipherKey) return 0;
    const key = this.cipherKey;
    const keys = this.vaultKeys();
    let converted = 0;
    let failed = 0;
    const convert = (value: string | null): string | null | undefined => {
      if (!value || isVaultSecretV2(value)) return undefined;
      try {
        return encryptVaultSecretV2(decryptVaultSecretTyped(value, keys) ?? "", key);
      } catch {
        failed += 1;
        return undefined;
      }
    };
    this.s.transaction(() => {
      const items = this.db.prepare("SELECT id, password, notes, fields FROM password_items").all() as Array<{
        id: string; password: string | null; notes: string | null; fields: string;
      }>;
      const updateItem = this.db.prepare("UPDATE password_items SET password = ?, notes = ?, fields = ? WHERE id = ?");
      for (const item of items) {
        const password = convert(item.password);
        const notes = convert(item.notes);
        const fields = convert(item.fields);
        if (password === undefined && notes === undefined && fields === undefined) continue;
        converted += 1;
        updateItem.run(
          password === undefined ? item.password : password,
          notes === undefined ? item.notes : notes,
          fields === undefined ? item.fields : fields,
          item.id,
        );
      }
      const connectors = this.db.prepare("SELECT provider, token FROM connectors").all() as Array<{ provider: string; token: string }>;
      const updateConnector = this.db.prepare("UPDATE connectors SET token = ? WHERE provider = ?");
      for (const connector of connectors) {
        const token = convert(connector.token);
        if (token === undefined) continue;
        converted += 1;
        updateConnector.run(token, connector.provider);
      }
    });
    if (failed > 0) console.warn(`[wand] ${failed} vault value(s) could not be re-encrypted and were left as stored`);
    return converted;
  }

  /** Encrypt an at-rest secret with the v2 key; empty values stay NULL. */
  private encryptStoredSecret(value: string | undefined): string | null {
    if (!value) return null;
    return encryptVaultSecretV2(value, this.requireVaultCipherKey());
  }

  private decryptPasswordItem(item: PasswordItemRowFields, raw: PasswordVaultItemRow): PasswordVaultItem {
    const keys = this.vaultKeys();
    const fieldsJson = decryptVaultSecretTyped(raw.fields, keys) ?? raw.fields;
    return {
      ...item,
      password: decryptVaultSecretTyped(raw.password ?? undefined, keys),
      notes: decryptVaultSecretTyped(raw.notes ?? undefined, keys),
      fields: decodePasswordFields(fieldsJson),
    };
  }

  ensureDefaultPasswordVault(): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO password_vaults (id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(DEFAULT_PASSWORD_VAULT_ID, DEFAULT_PASSWORD_VAULT_NAME, now, now);
  }

  listPasswordVaults(): PasswordVault[] {
    this.ensureDefaultPasswordVault();
    const rows = this.db
      .prepare("SELECT id, name, created_at, updated_at FROM password_vaults ORDER BY name COLLATE NOCASE ASC")
      .all() as unknown as PasswordVaultRow[];
    return rows.map(mapPasswordVaultRow);
  }

  createPasswordVault(nameInput: unknown): PasswordVault {
    const name = normalizeVaultName(nameInput);
    const now = nowIso();
    const id = crypto.randomUUID();
    this.db
      .prepare("INSERT INTO password_vaults (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(id, name, now, now);
    return { id, name, createdAt: now, updatedAt: now };
  }

  getPasswordVault(id: string): PasswordVault | null {
    const row = this.db
      .prepare("SELECT id, name, created_at, updated_at FROM password_vaults WHERE id = ?")
      .get(id) as PasswordVaultRow | undefined;
    return row ? mapPasswordVaultRow(row) : null;
  }

  listPasswordItems(filter: PasswordVaultItemFilter = {}): PasswordVaultItem[] {
    this.ensureDefaultPasswordVault();
    const rows = this.db
      .prepare(
        `SELECT id, vault_id, type, title, username, password, urls, notes, fields, tags, favorite, archived,
                created_at, updated_at, last_used_at, password_updated_at
         FROM password_items
         WHERE (? = 1 OR archived = 0)
         ORDER BY favorite DESC, last_used_at DESC NULLS LAST, updated_at DESC`
      )
      .all(filter.includeArchived ? 1 : 0) as unknown as PasswordVaultItemRow[];
    const limit = typeof filter.limit === "number" && Number.isFinite(filter.limit)
      ? Math.max(1, Math.min(200, Math.floor(filter.limit)))
      : 100;
    return rows.map((row) => this.decryptPasswordItem(mapPasswordItemRow(row), row))
      .filter((item) => itemMatchesFilter(item, filter)).slice(0, limit);
  }

  getPasswordItem(id: string): PasswordVaultItem | null {
    const row = this.db
      .prepare(
        `SELECT id, vault_id, type, title, username, password, urls, notes, fields, tags, favorite, archived,
                created_at, updated_at, last_used_at, password_updated_at
         FROM password_items
         WHERE id = ? AND archived = 0`
      )
      .get(id) as PasswordVaultItemRow | undefined;
    return row ? this.decryptPasswordItem(mapPasswordItemRow(row), row) : null;
  }

  createPasswordItem(input: PasswordVaultItemInput): PasswordVaultItem {
    this.ensureDefaultPasswordVault();
    const normalized = normalizePasswordItemInput(input);
    const vaultId = typeof input.vaultId === "string" && this.getPasswordVault(input.vaultId)
      ? input.vaultId
      : DEFAULT_PASSWORD_VAULT_ID;
    const now = nowIso();
    const id = crypto.randomUUID();
    const passwordUpdatedAt = normalized.password ? now : undefined;
    this.db
      .prepare(
        `INSERT INTO password_items (
           id, vault_id, type, title, username, password, urls, notes, fields, tags, favorite, archived,
           created_at, updated_at, last_used_at, password_updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?)`
      )
      .run(
        id,
        vaultId,
        normalized.type,
        normalized.title,
        normalized.username ?? null,
        this.encryptStoredSecret(normalized.password),
        JSON.stringify(normalized.urls),
        this.encryptStoredSecret(normalized.notes),
        this.encryptStoredSecret(JSON.stringify(normalized.fields)) ?? "{}",
        JSON.stringify(normalized.tags),
        normalized.favorite ? 1 : 0,
        now,
        now,
        passwordUpdatedAt ?? null,
      );
    return this.getPasswordItem(id)!;
  }

  updatePasswordItem(id: string, input: PasswordVaultItemInput): PasswordVaultItem | null {
    const existing = this.getPasswordItem(id);
    if (!existing) return null;
    const merged: PasswordVaultItemInput = {
      vaultId: input.vaultId ?? existing.vaultId,
      type: input.type ?? existing.type,
      title: input.title ?? existing.title,
      username: input.username ?? existing.username,
      password: input.password ?? existing.password,
      urls: input.urls ?? existing.urls,
      notes: input.notes ?? existing.notes,
      fields: input.fields ?? existing.fields,
      tags: input.tags ?? existing.tags,
      favorite: input.favorite ?? existing.favorite,
    };
    const normalized = normalizePasswordItemInput(merged);
    const vaultId = typeof merged.vaultId === "string" && this.getPasswordVault(merged.vaultId)
      ? merged.vaultId
      : existing.vaultId;
    const now = nowIso();
    const passwordChanged = Object.prototype.hasOwnProperty.call(input, "password") && normalized.password !== existing.password;
    const passwordUpdatedAt = passwordChanged ? (normalized.password ? now : null) : (existing.passwordUpdatedAt ?? null);
    this.db
      .prepare(
        `UPDATE password_items
         SET vault_id = ?, type = ?, title = ?, username = ?, password = ?, urls = ?, notes = ?,
             fields = ?, tags = ?, favorite = ?, updated_at = ?, password_updated_at = ?
         WHERE id = ? AND archived = 0`
      )
      .run(
        vaultId,
        normalized.type,
        normalized.title,
        normalized.username ?? null,
        this.encryptStoredSecret(normalized.password),
        JSON.stringify(normalized.urls),
        this.encryptStoredSecret(normalized.notes),
        this.encryptStoredSecret(JSON.stringify(normalized.fields)) ?? "{}",
        JSON.stringify(normalized.tags),
        normalized.favorite ? 1 : 0,
        now,
        passwordUpdatedAt,
        id,
      );
    return this.getPasswordItem(id);
  }

  touchPasswordItem(id: string): PasswordVaultItem | null {
    const now = nowIso();
    this.db.prepare("UPDATE password_items SET last_used_at = ?, updated_at = ? WHERE id = ? AND archived = 0").run(now, now, id);
    return this.getPasswordItem(id);
  }

  deletePasswordItem(id: string): boolean {
    const now = nowIso();
    const result = this.db
      .prepare("UPDATE password_items SET archived = 1, updated_at = ? WHERE id = ? AND archived = 0")
      .run(now, id);
    return result.changes > 0;
  }

  /** Decrypted connector token; "" when none is stored. Throws VaultDecryptError when stored but unreadable. */
  getConnectorToken(provider: string): string | null {
    const row = this.db
      .prepare("SELECT token FROM connectors WHERE provider = ?")
      .get(provider) as { token: string } | undefined;
    if (!row) return null;
    return decryptVaultSecretTyped(row.token, this.vaultKeys()) ?? "";
  }

  getConnectorMeta(provider: string): ConnectorMeta | null {
    const row = this.db
      .prepare("SELECT provider, api_url, username, connected_at, updated_at FROM connectors WHERE provider = ?")
      .get(provider) as ConnectorRow | undefined;
    if (!row) return null;
    return {
      provider: row.provider,
      apiUrl: row.api_url || null,
      username: row.username ?? null,
      connectedAt: row.connected_at ?? null,
      updatedAt: row.updated_at,
    };
  }

  /** Read-modify-write runs in one transaction so concurrent partial updates cannot interleave. */
  saveConnector(
    provider: string,
    input: { token?: string | null; apiUrl?: string | null; username?: string | null; markConnected?: boolean },
  ): ConnectorMeta {
    return this.s.transaction(() => {
      const now = nowIso();
      const existing = this.getConnectorMeta(provider);
      const token = input.token === undefined || input.token === null || input.token === ""
        ? this.getConnectorToken(provider) ?? ""
        : input.token;
      const apiUrl = input.apiUrl === undefined ? (existing?.apiUrl ?? "") : input.apiUrl;
      const username = input.username === undefined ? (existing?.username ?? null) : input.username;
      const connectedAt = input.markConnected === false ? (existing?.connectedAt ?? now) : now;
      const encrypted = this.encryptConnectorToken(token);
      this.db.prepare(
        `INSERT INTO connectors (provider, token, api_url, username, connected_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           token = excluded.token,
           api_url = excluded.api_url,
           username = excluded.username,
           connected_at = excluded.connected_at,
           updated_at = excluded.updated_at`,
      ).run(provider, encrypted, apiUrl, username, connectedAt, now, now);
      return { provider, apiUrl: apiUrl || null, username, connectedAt, updatedAt: now };
    });
  }

  deleteConnector(provider: string): boolean {
    return this.db.prepare("DELETE FROM connectors WHERE provider = ?").run(provider).changes > 0;
  }

  private encryptConnectorToken(token: string): string {
    return this.encryptStoredSecret(token) ?? "";
  }

  saveAuthSession(
    token: string,
    expiresAt: number,
    principal: AuthPrincipal = { kind: "browser-admin", scopes: ["admin"] },
  ): void {
    this.db
      .prepare(
        `INSERT INTO auth_sessions (token, expires_at, kind, scopes)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET
           expires_at = excluded.expires_at,
           kind = excluded.kind,
           scopes = excluded.scopes`
      )
      .run(hashAuthToken(token), expiresAt, principal.kind, JSON.stringify(principal.scopes));
  }

  getAuthSession(token: string): PersistedAuthSession | null {
    const row = this.db
      .prepare("SELECT expires_at, kind, scopes FROM auth_sessions WHERE token = ?")
      .get(hashAuthToken(token)) as { expires_at: number; kind: string; scopes: string } | undefined;

    if (!row) {
      return null;
    }

    return {
      token,
      expiresAt: row.expires_at,
      principal: parseAuthPrincipal(row.kind, row.scopes),
    };
  }

  deleteAuthSession(token: string): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE token = ?").run(hashAuthToken(token));
  }

  deleteAllAuthSessions(): void {
    this.db.prepare("DELETE FROM auth_sessions").run();
  }

  deleteExpiredAuthSessions(now: number): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").run(now);
  }
}
