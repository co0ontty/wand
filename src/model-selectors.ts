/**
 * Single owner of the model selector identities that are saved in sessions, employees and
 * default preferences. Pure constants and predicates: no imports, safe for server and browser.
 *
 * - `wand-model-group/<provider>/<id>`: a user-defined model group (model-groups.ts).
 * - `wand-auto-assign/auto`: 「智能分配」, resolved only when a real prompt exists.
 * - `wand-openrouter-free/auto`: the built-in free group (openrouter-free-selection.ts).
 * - `wand-decision/laya`: the local decision model (decision-expert-identity.ts).
 *
 * Re-export shims in the old modules keep their public names; prefer importing from here.
 */

export const MODEL_GROUP_PREFIX = "wand-model-group/";
export const AUTO_ASSIGN_SELECTOR = "wand-auto-assign/auto";
export const OPENROUTER_FREE_PROVIDER = "wand-openrouter-free";
export const OPENROUTER_FREE_SELECTOR = `${OPENROUTER_FREE_PROVIDER}/auto`;
export const WAND_LOCAL_DECISION_MODEL = "wand-decision/laya";

export function isModelGroupSelector(value: string | null | undefined): boolean {
  return value?.startsWith(MODEL_GROUP_PREFIX) === true;
}

export function isAutoAssignSelector(value: string | null | undefined): boolean {
  return value?.trim() === AUTO_ASSIGN_SELECTOR;
}

export function isOpenRouterFreeSelector(selector: string | null | undefined): boolean {
  return selector?.startsWith(`${OPENROUTER_FREE_PROVIDER}/`) === true;
}

export function isLocalDecisionModel(value: string | null | undefined): boolean {
  return value === WAND_LOCAL_DECISION_MODEL;
}
