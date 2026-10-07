import { getDefaultModelForProvider } from "./config.js";
import { findModelGroup, resolveModelGroupModels } from "./model-groups.js";
import { OPENROUTER_FREE_SELECTOR } from "./openrouter-free-selection.js";
import { classifyStructuredFailure, hasStructuredExecutionProgress } from "./structured-failure.js";
import type { WandConfig } from "./types.js";
import type { StructuredRunnerAdapter, StructuredRunnerExecution, StructuredRunnerResult } from "./structured-runner.js";

/** Resolve at execution time; persist the selection, normalize attempt facts even without a group. */
export function withModelGroups(runner: StructuredRunnerAdapter, config: WandConfig): StructuredRunnerAdapter {
  return { start(context, observer) {
    const provider = context.session.provider ?? context.session.structuredState?.provider ?? "claude";
    const selected = context.session.selectedModel?.trim();
    const selector = selected && selected !== "default" ? selected : getDefaultModelForProvider(config, provider);
    const groupOptions = { preferDefault: !selected || selected === "default" };
    const models = resolveModelGroupModels(config.modelGroups, provider, selector, groupOptions);
    const group = findModelGroup(config.modelGroups, provider, selector, groupOptions);
    const grouped = !!group && models[0] !== OPENROUTER_FREE_SELECTOR;
    let cancelled = false;
    let current: StructuredRunnerExecution;
    const start = (model: string): StructuredRunnerExecution => {
      let active = true;
      let output = false;
      let progress = false;
      const isActive = (): boolean => active && !cancelled && observer.isActive();
      const execution = runner.start({ ...context, ...(grouped ? { modelGroupModels: models } : {}),
        session: { ...context.session, selectedModel: model || null },
      }, { ...observer, isActive,
        onStdout(text) { if (!isActive()) return; if (text.trim()) output = true; observer.onStdout?.(text); },
        onEvent(event) {
          if (!isActive()) return;
          if (event.type !== "wand_pi_resource_selection") output = true;
          observer.onEvent?.(event);
        },
        onUpdate(state) {
          if (!isActive()) return;
          progress ||= hasStructuredExecutionProgress(state);
          output ||= !!state.sessionId || progress;
          observer.onUpdate({ ...state, model: state.model ?? model });
        },
      });
      return { ...execution, get args() { return execution.args; }, get pid() { return execution.pid; },
        completion: execution.completion.then((result) => {
          const failed = result.spawnError ? { ...result, exitCode: result.exitCode ?? 1,
            primaryError: result.primaryError || result.spawnError.message } : result;
          const failure = classifyStructuredFailure(failed, { output, progress });
          return { ...failed, failure: failure && cancelled ? { ...failure, kind: "cancelled" as const, retryable: false } : failure,
            state: { ...failed.state, model: failed.state.model ?? model } };
        }).finally(() => { active = false; }) };
    };
    // Synchronous registration is essential for queue/recovery ownership.
    current = start(models[0] ?? "");
    const first = current;
    const completion = (async (): Promise<StructuredRunnerResult> => {
      for (let index = 0; ; index++) {
        const result = await current.completion;
        if (!grouped || !result.failure?.retryable || cancelled || !observer.isActive()
          || index + 1 >= models.length) return result;
        current = start(models[index + 1]!);
      }
    })();
    return { ...first, get args() { return first.args; }, get pid() { return first.pid; }, completion, interrupt() {
      cancelled = true;
      try { current.interrupt(); } catch { /* best effort, never replay after cancellation */ }
    } };
  } };
}
