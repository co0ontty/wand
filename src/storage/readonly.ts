import { DatabaseSync } from "node:sqlite";
import { decryptVaultSecretTyped } from "../password-manager.js";
import { readVaultKey } from "./vault-keys.js";

/**
 * Narrow read API for out-of-process consumers (the Pi OpenRouter bridge).
 * It never migrates, never creates the vault key, and never writes, except for
 * the explicit revocation below. Secret decryption goes through the same vault
 * code as the server, so there is one implementation of the cipher.
 */
export interface OpenRouterFreeScopeRow {
  readonly selector: string;
  readonly requirements_json: string;
  readonly credential_hash: string;
}

export interface StorageReadonly {
  getConfigValue(key: string): string | null;
  /** Decrypted connector token, or undefined when none is stored. Throws VaultDecryptError when unreadable. */
  getConnectorToken(provider: string): string | undefined;
  /** Live OpenRouter free-model grant for a token hash, bound to a running structured session. */
  openRouterFreeScope(tokenHash: string, now: number): OpenRouterFreeScopeRow | null;
  close(): void;
}

export function openStorageReadonly(dbPath: string): StorageReadonly {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const readConfig = (key: string): string | null => {
    const value = db.prepare("SELECT value FROM app_config WHERE key = ?").get(key)?.value;
    return typeof value === "string" ? value : null;
  };
  return {
    getConfigValue: readConfig,
    getConnectorToken: (provider) => {
      const row = db.prepare("SELECT token FROM connectors WHERE provider = ?").get(provider) as { token: string } | undefined;
      if (!row) return undefined;
      return decryptVaultSecretTyped(row.token, {
        cipherKey: readVaultKey(dbPath),
        legacySecret: readConfig("appSecret"),
      });
    },
    openRouterFreeScope: (tokenHash, now) => {
      const row = db.prepare(`SELECT a.selector, a.requirements_json, a.credential_hash FROM openrouter_free_access a
        JOIN command_sessions s ON s.id = a.session_id
        WHERE a.token_hash = ? AND a.expires_at > ? AND s.provider = 'pi' AND s.session_kind = 'structured'
          AND s.status = 'running'`).get(tokenHash, now) as OpenRouterFreeScopeRow | undefined;
      return row ?? null;
    },
    close: () => db.close(),
  };
}

/** Writer used only by the CLI to drop its own grant on shutdown. Opens the file itself, runs no migrations. */
export function revokeOpenRouterFreeAccessAt(dbPath: string, tokenHash: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("DELETE FROM openrouter_free_access WHERE token_hash = ?").run(tokenHash);
  } finally { db.close(); }
}
