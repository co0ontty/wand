import * as React from "react";
import { useEffect, useState } from "react";
import { DECISION_EXPERT_ID, DECISION_EXPERT_NAME } from "../../../decision-expert-identity.js";
import type { SiliconEmployee } from "../../../ai-team-types.js";
import type { WandTaskAgent } from "../../../task-types.js";
import { CandidatesListEditor, type ProviderOptions } from "../agents/candidate-editor";
import { candidateListError } from "../agents/candidate-list";
import { useWandModelCatalog } from "../use-model-catalog";
import { WandDialogSurface } from "../ui";
import { jsonBody, requestJson } from "../http-adapter";
import { SettingsActionButton, SettingsStatus } from "./fields";

export interface DecisionChainEditorProps {
  admin: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  providerOptions: ProviderOptions;
}

export function DecisionChainEditor({ admin, open, onOpenChange, providerOptions }: DecisionChainEditorProps) {
  const [agents, setAgents] = useState<WandTaskAgent[]>([]);
  const [error, setError] = useState(""), [pending, setPending] = useState(false), [saved, setSaved] = useState(false);
  const catalog = useWandModelCatalog(open);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController(); setError(""); setSaved(false);
    void requestJson<SiliconEmployee>(`/api/silicon-employees/${DECISION_EXPERT_ID}`, { signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) setAgents(value.agents); })
      .catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "决策专家尚未部署。"); });
    return () => abort.abort();
  }, [open]);
  async function save() {
    const invalid = candidateListError(agents);
    if (invalid) { setError(invalid); return; }
    setPending(true); setError(""); setSaved(false);
    try { await requestJson(`/api/silicon-employees/${DECISION_EXPERT_ID}`, jsonBody({ agents }, "PUT")); setSaved(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "调用链保存失败，当前内容保留。"); }
    finally { setPending(false); }
  }
  return <WandDialogSurface open={open} dismissable={!pending} onOpenChange={onOpenChange} title={`${DECISION_EXPERT_NAME} · 调用链`}>
      <SettingsStatus>首选 LAYA，备用 Wand 免费分组。性能/平台不足时配置此调用链；无免费候选时停止，不转付费。</SettingsStatus>
      {agents.length ? <CandidatesListEditor agents={agents} catalog={catalog} providerOptions={providerOptions}
        disabled={!admin || pending} structuredOnly decisionOnly onChange={next => { setAgents(next); setSaved(false); }} label="决策专家"/> : null}
      <SettingsActionButton kind="primary" pending={pending} disabled={!admin || !agents.length} settled={saved ? "success" : error ? "error" : null}
        onClick={save}>保存调用链</SettingsActionButton>
      {error ? <SettingsStatus tone="error">{error}</SettingsStatus> : saved ? <SettingsStatus tone="success">调用链已保存，内置身份与人设不变。</SettingsStatus> : null}
    </WandDialogSurface>;
}
