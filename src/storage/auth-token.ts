import crypto from "node:crypto";

/** Bearer tokens are stored only as SHA-256 digests (schema v3). The raw token never reaches SQLite. */
export function hashAuthToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}
