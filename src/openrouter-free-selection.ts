/** Public model selection identity shared by the server and browser; contains no credentials. */
export const OPENROUTER_FREE_PROVIDER = "wand-openrouter-free";
export const OPENROUTER_FREE_GROUP = "免费分组";
export const OPENROUTER_FREE_SELECTOR = `${OPENROUTER_FREE_PROVIDER}/auto`;

export function isOpenRouterFreeSelector(selector: string | null | undefined): boolean {
  return selector?.startsWith(`${OPENROUTER_FREE_PROVIDER}/`) === true;
}
