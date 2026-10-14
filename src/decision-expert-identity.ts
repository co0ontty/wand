/** Pure identity shared by server and clients; LAYA is a bounded decision source, never a chat model. */
import { WAND_LOCAL_DECISION_MODEL, isLocalDecisionModel } from "./model-selectors.js";

export const DECISION_EXPERT_KEY = "wand-decision-expert";
export const DECISION_EXPERT_ID = "e_wand_decision_expert";
export const DECISION_EXPERT_NAME = "石一";
export { WAND_LOCAL_DECISION_MODEL, isLocalDecisionModel };
export const WAND_LOCAL_DECISION_LABEL = "Wand 本地决策模型 · LAYA";
