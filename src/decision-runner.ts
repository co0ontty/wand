import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WandStorage } from "./storage.js";
import type { StructuredRunnerAdapter } from "./structured-runner.js";

export interface DecisionRuntimeAccess {
  url: string;
  caPath?: string;
}
export const DECISION_ENV_KEYS = ["WAND_DECISION_URL", "WAND_DECISION_TOKEN", "WAND_DECISION_CA", "WAND_DECISION_NODE", "WAND_DECISION_CLI"] as const;

/** Adds only a revocable inference capability. Never edits base prompts, DTOs, or tool permissions. */
export function withDecisionAccess(
  runner: StructuredRunnerAdapter,
  storage: WandStorage,
  runtime: () => DecisionRuntimeAccess | null,
): StructuredRunnerAdapter {
  return { start(context, observer) {
    const env = { ...context.env };
    for (const key of DECISION_ENV_KEYS) delete env[key];
    const access = runtime();
    if (!access) return runner.start({ ...context, env }, observer);
    const token = storage.issueDecisionAccess(context.session.id);
    const cleanup = (): void => { try { storage.revokeDecisionAccess(token); } catch { /* storage may be closing */ } };
    const js = fileURLToPath(new URL("./cli.js", import.meta.url));
    // Source-mode tests/development can still call the CLI via Node's tsx loader in the skill client.
    const cli = existsSync(js) ? js : js.replace(/\.js$/, ".ts");
    try {
      const execution = runner.start({ ...context, env: { ...env,
        WAND_DECISION_URL: access.url, WAND_DECISION_TOKEN: token,
        WAND_DECISION_NODE: process.execPath, WAND_DECISION_CLI: cli,
        ...(access.caPath ? { WAND_DECISION_CA: access.caPath } : {}),
      }, session: { ...context.session, runtimeSystemPrompt: [context.session.runtimeSystemPrompt,
        "可选本地判断工具：wand-decision skill。适用于有界选择、评分、是非判断，不替代主模型或操作授权。仅在需要且有命令权限时使用；不要打印或转存调用环境中的凭据。",
      ].filter(Boolean).join("\n\n") } }, observer);
      return { ...execution, completion: execution.completion.finally(cleanup), interrupt: () => { cleanup(); execution.interrupt(); } };
    } catch (error) { cleanup(); throw error; }
  } };
}
