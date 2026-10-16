/** Preserve SHA-256 request fingerprints on LAN HTTP, where SubtleCrypto is unavailable. */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const subtle = globalThis.crypto?.subtle;
  const digest = subtle
    ? new Uint8Array(await subtle.digest("SHA-256", bytes))
    // The lazy CommonJS chunk exposes only default in split ESM builds.
    : (await import("fast-sha256")).default(bytes);
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
