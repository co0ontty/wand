import { DecisionError } from "./decision-types.js";
import { discoverPiResources, resolvePiResourceSelection, type PiResourceInventory } from "./pi-resource-catalog.js";
import { decidePiCodemode, parsePiRecommendationRequest, recommendPiResources, type PiAutomaticCodemodeChoice, type PiResourceEvaluator } from "./pi-resource-recommendation.js";
import { patchPiResourceSelection, type PiResourceSelection, type PiResourceSelectionNotice } from "./pi-session-settings.js";
import type { StructuredRunnerAdapter, StructuredRunnerContext, StructuredRunnerExecution, StructuredRunnerObserver,
  StructuredRunnerResult, StructuredRunnerTurnState } from "./structured-runner.js";
import type { WandConfig } from "./types.js";

interface AutoResourceOptions {
  evaluate(): PiResourceEvaluator | undefined;
  inventory?: (cwd: string) => Promise<PiResourceInventory>;
  timeoutMs?: number;
}

/** Owned by the submitted runner, not by the composer. Manual settings are never overwritten. */
export function withAutomaticPiResources(runner: StructuredRunnerAdapter, config: Pick<WandConfig, "harness">,
  options: AutoResourceOptions): StructuredRunnerAdapter {
  return { start(context, observer) {
    if (context.session.provider !== "pi" || context.session.piSettings?.autoResources !== true) {
      return runner.start(context, observer);
    }
    const abort = new AbortController();
    let interrupted = false;
    let execution: StructuredRunnerExecution | null = null;
    let notice: PiResourceSelectionNotice = { status: "selecting", label: "正在自动选择 Skills / MCP / CodeMode…", skills: [], mcpServers: [] };
    const withNotice = (state: StructuredRunnerTurnState): StructuredRunnerTurnState => ({ ...state, resourceSelection: notice });
    const publish = (): void => {
      if (observer.isActive() && !interrupted) observer.onUpdate(withNotice({ blocks: [], result: "", sessionId: context.session.claudeSessionId }));
    };
    // The manager receives ownership synchronously; all asynchronous work starts in the next microtask.
    const spawnedAt = new Date().toISOString();
    const completion = Promise.resolve().then(async (): Promise<StructuredRunnerResult> => {
      const checkActive = (): void => {
        if (interrupted || !observer.isActive()) throw new DecisionError("CANCELLED", "自动选择已取消，尚未启动 Pi。", 499);
      };
      checkActive(); publish();
      const manual = context.session.piSettings?.resources ?? { skills: [], mcpServers: [] };
      const locked = new Set(context.session.piSettings?.lockedSkills ?? []);
      let selected = manual;
      const manualCodemode = context.session.piSettings?.codemodeOverride;
      let automaticCodemode: PiAutomaticCodemodeChoice | undefined;
      let inventory: PiResourceInventory | undefined;
      let fallback = "";
      let timer: NodeJS.Timeout | undefined;
      try {
        inventory = await (options.inventory?.(context.session.cwd) ?? discoverPiResources(config, context.session.cwd));
        checkActive();
        // A missing manual resource must fail as usual, never be silently replaced by an automatic pick.
        resolvePiResourceSelection(inventory, manual);
        const evaluate = context.session.piSettings?.localDecision === false ? undefined : options.evaluate();
        if (!evaluate) throw new DecisionError("UNAVAILABLE", "本地决策不可用");
        const candidates: PiResourceSelection = {
          skills: inventory.catalog.skills.filter((item) => !locked.has(item.id)).map((item) => item.id),
          mcpServers: inventory.catalog.mcpServers.filter((item) => inventory!.servers.get(item.id)?.config.enabled !== false)
            .map((item) => item.id),
        };
        const request = parsePiRecommendationRequest({ prompt: context.prompt, candidates });
        timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 15_000);
        const boundedEvaluate: PiResourceEvaluator = (value, caller, signal) => new Promise((resolve, reject) => {
          const cancelled = (): void => reject(new DecisionError("CANCELLED", "本地选择已取消"));
          if (signal?.aborted) { cancelled(); return; }
          signal?.addEventListener("abort", cancelled, { once: true });
          Promise.resolve().then(() => { checkActive(); return evaluate(value, caller, signal); }).then(resolve, reject)
            .finally(() => signal?.removeEventListener("abort", cancelled));
        });
        if (!manualCodemode) automaticCodemode = await decidePiCodemode({
          prompt: request.prompt, evaluate: boundedEvaluate, caller: `pi-auto-resources:${context.session.id}`, signal: abort.signal,
        });
        const result = await recommendPiResources({ ...request, catalog: inventory.catalog, evaluate: boundedEvaluate,
          caller: `pi-auto-resources:${context.session.id}`, signal: abort.signal });
        checkActive();
        if (abort.signal.aborted) throw new DecisionError("TIMEOUT", "本地选择超时");
        selected = patchPiResourceSelection({
          skills: [...new Set([...manual.skills.filter((id) => locked.has(id)),
            ...result.selection.skills.filter((id) => !locked.has(id))])],
          mcpServers: [...new Set([...manual.mcpServers, ...result.selection.mcpServers])],
        });
        resolvePiResourceSelection(inventory, selected);
      } catch (error) {
        checkActive();
        selected = manual; automaticCodemode = undefined;
        // Explicit manual constraints remain authoritative even when inference failed.
        if (inventory) resolvePiResourceSelection(inventory, manual);
        fallback = error instanceof DecisionError ? error.code === "CANDIDATE_LIMIT" ? "候选过多"
          : error.code === "INVALID_REQUEST" ? "提示词超出本地选择范围"
          : error.code === "TIMEOUT" || abort.signal.aborted ? "本地选择超时" : "本地决策不可用"
          : "资源目录暂不可用";
      } finally { if (timer) clearTimeout(timer); }
      checkActive();
      const names = (kind: "skills" | "mcpServers"): string[] => selected[kind].map((id) =>
        (inventory?.catalog[kind].find((item) => item.id === id)?.name ?? "已手选资源").slice(0, 80));
      const skills = names("skills");
      const mcpServers = names("mcpServers");
      const codemode: NonNullable<PiResourceSelectionNotice["codemode"]> = {
        mode: manualCodemode ?? automaticCodemode?.override ?? "follow",
        source: manualCodemode ? "manual" : fallback ? "fallback" : automaticCodemode?.override ? "automatic" : "uncertain",
      };
      const codemodeLabel = codemode.mode === "on" ? "启用" : codemode.mode === "off" ? "关闭"
        : codemode.mode === "only" ? "仅 CodeMode" : "跟随 Pi";
      const chosen = [skills.length ? `Skills：${skills.join("、")}` : "", mcpServers.length ? `MCP：${mcpServers.join("、")}` : "",
        `CodeMode：${codemodeLabel}${codemode.source === "manual" ? "（手动）" : codemode.source === "uncertain" ? "（判断不确定）" : ""}`].filter(Boolean).join("；");
      notice = { status: fallback ? "fallback" : "selected", skills, mcpServers, codemode,
        label: fallback ? `自动选择：${fallback}，沿用手选（${chosen}）` : `本轮选择 · ${chosen}` };
      if (notice.label.length > 1024) notice = { ...notice, label: `${notice.label.slice(0, 1023)}…` };
      // This is a server-owned selection record, not a fabricated provider tool call.
      observer.onEvent?.({ type: "wand_pi_resource_selection", ...notice });
      publish();
      const scoped: StructuredRunnerContext = { ...context, session: { ...context.session,
        piSettings: { ...context.session.piSettings!, resources: selected,
          ...(!manualCodemode && automaticCodemode?.override ? { codemodeOverride: automaticCodemode.override } : {}) } } };
      const scopedObserver: StructuredRunnerObserver = { ...observer, onUpdate: (state) => {
        if (!interrupted && observer.isActive()) observer.onUpdate(withNotice(state));
      } };
      checkActive();
      execution = runner.start(scoped, scopedObserver);
      const result = await execution.completion;
      // Selection notices are metadata, not model execution. A fallback tool starts with
      // its own configuration; cancelled/failed preparation below is still never retried.
      return { ...result, state: withNotice(result.state) };
    }).catch((error: unknown): StructuredRunnerResult => {
      if (notice.status === "selecting") {
        notice = interrupted || error instanceof DecisionError && error.code === "CANCELLED"
          ? { ...notice, status: "cancelled", label: "本轮自动选择已取消" }
          : { ...notice, status: "fallback", label: "自动配置准备失败，尚未启动 Pi" };
      }
      return {
        state: withNotice({ blocks: [], result: "", sessionId: context.session.claudeSessionId }),
        exitCode: 1, signal: null, stderr: "", primaryError: error instanceof Error ? error.message : "自动选择准备失败。",
        inputAccepted: false, retryForbidden: true,
      };
    });
    return { get args() { return execution?.args ?? []; }, get pid() { return execution?.pid ?? null; },
      spawnedAt, completion, interrupt: () => {
        if (interrupted) return;
        if (notice.status === "selecting") { notice = { ...notice, status: "cancelled", label: "本轮自动选择已取消" }; publish(); }
        interrupted = true; abort.abort(); execution?.interrupt();
      } };
  } };
}
