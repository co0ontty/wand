/** Server-maintained native OpenCode free group; no OpenRouter credentials involved. */
export const OPENCODE_FREE_GROUP_ID = "opencode-free";
export const OPENCODE_FREE_GROUP_NAME = "免费分组";
export const OPENCODE_FREE_GROUP_SELECTOR = "wand-model-group/opencode/opencode-free";
/** Syntax only, NOT a free-price check. Native zero-price models need not end in -free. */
export function isOpenCodeNativeModelId(id: string): boolean {
  return /^opencode\/[a-z0-9][a-z0-9._-]*$/.test(id) && id !== "opencode/default" && id !== "opencode/auto";
}
export function isOpenCodeFreeGroup(group: { id: string; provider: string }): boolean {
  return group.id === OPENCODE_FREE_GROUP_ID && group.provider === "opencode";
}
