/** Pure identity shared by server and clients; LAYA is a bounded decision source, never a chat model. */
export const DECISION_EXPERT_KEY = "wand-decision-expert";
export const DECISION_EXPERT_ID = "e_wand_decision_expert";
export const DECISION_EXPERT_NAME = "决策专家";
export const WAND_LOCAL_DECISION_MODEL = "wand-decision/laya";
export const WAND_LOCAL_DECISION_LABEL = "Wand 本地决策模型 · LAYA";
export function isLocalDecisionModel(value: string | null | undefined): boolean { return value === WAND_LOCAL_DECISION_MODEL; }
