import { createHash } from "node:crypto";

export interface VersionedWebAsset {
  content: string;
  hash: string;
}

// The hash covers the bytes actually sent (including server-side JS substitutions).
export function versionWebAsset(content: string): VersionedWebAsset {
  return { content, hash: createHash("sha256").update(content).digest("hex").slice(0, 16) };
}
