type ChatPresentation = Pick<typeof import("./presentation"),
  "presentChat" | "refreshChatPresentation" | "patchChatPresentation">;
let active: ChatPresentation | null = null;

/** DOM reconciliation stays synchronous. The optional renderer registers its
 * exact implementation before the first paint; there is no second projection. */
export function registerChatPresentation(runtime: ChatPresentation): void {
  active = runtime;
}
export const presentChat: ChatPresentation["presentChat"] = root => { active?.presentChat(root); };
export const refreshChatPresentation: ChatPresentation["refreshChatPresentation"] = root => { active?.refreshChatPresentation(root); };
export const patchChatPresentation: ChatPresentation["patchChatPresentation"] = (current, next, morph) =>
  active?.patchChatPresentation(current, next, morph) ?? false;
