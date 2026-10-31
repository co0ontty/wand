import * as React from "react";
import type { WandTaskAgent } from "../../../task-types.js";
import type { ConversationExecutionPreference } from "../../../conversation-execution-preference.js";
import { AGENT_TOOL_OPTIONS, agentToolIdFor, agentToolOption } from "../../provider-identity.js";
import { normalizeWandTaskAgentMode } from "../../../task-types.js";
import { wandModelOptions, type WandModelCatalog } from "../model-catalog";
import { issueAgentEffortOptions } from "../issues/task-board-agent";
import { WandSelect } from "../ui";
import { ProviderLogo } from "../provider-logo";
import { composerRuntimePreference } from "./composer-presentation";

// 临时执行配置由所在界面自己持有（对话按会话、新建工作按打开实例），离开即丢弃；这里只做投影。
export function conversationPreferenceAgent(base: WandTaskAgent | undefined, preference: ConversationExecutionPreference | undefined): WandTaskAgent | undefined {
  return base && preference ? { ...base, ...preference, kind: "structured", mode: normalizeWandTaskAgentMode(preference.provider, base.mode) } : base;
}
export function ConversationExecutionSelectors({ agent, catalog, disabled, cliOnly = false, onChange }: {
  agent: WandTaskAgent; catalog: WandModelCatalog | null; disabled: boolean; cliOnly?: boolean;
  onChange(preference: ConversationExecutionPreference): void;
}): React.ReactElement {
  const summary = composerRuntimePreference(agent, catalog);
  const models = [...wandModelOptions(catalog, agent.provider)];
  if (!models.some(option => option.value === agent.model)) models.push({ value: agent.model, label: agent.model });
  const efforts = issueAgentEffortOptions(agent.provider, catalog, agent.model, agent.thinkingEffort)
    .map(option => option.value === "off" ? { ...option, label: "自动（模型默认）" } : option);
  const commit = (next: WandTaskAgent): void => onChange({ provider: next.provider, engine: next.engine,
    model: next.model, thinkingEffort: next.thinkingEffort });
  return <>
    <WandSelect ariaLabel="本页执行工具" value={agentToolIdFor(agent.provider, agent.engine)} displayValue=""
      displayTitle={AGENT_TOOL_OPTIONS.find(tool => tool.id === agentToolIdFor(agent.provider, agent.engine))?.label}
      startSlot={<ProviderLogo provider={agent.provider} className="composer-tool-logo"/>}
      options={AGENT_TOOL_OPTIONS.filter(tool => !cliOnly || tool.engine !== "sdk").map(tool => ({ value: tool.id, label: tool.label }))}
      className="conversation-runtime-select conversation-tool-select" triggerKind="ghost" side="top" disabled={disabled}
      onValueChange={value => {
        const tool = agentToolOption(value);
        if (tool) commit({ ...agent, provider: tool.provider, engine: tool.engine,
          model: "default", thinkingEffort: "off", mode: normalizeWandTaskAgentMode(tool.provider, agent.mode) });
      }}/>
    <WandSelect ariaLabel="本页模型" value={agent.model} options={models} displayValue={summary.model} displayTitle={models.find(option => option.value === agent.model)?.label || agent.model}
      className="conversation-runtime-select conversation-model-select" triggerKind="ghost" side="top" disabled={disabled}
      searchable searchPlaceholder="搜索本页模型" onValueChange={model => {
        const compatible = issueAgentEffortOptions(agent.provider, catalog, model).some(option => option.value === agent.thinkingEffort);
        commit({ ...agent, model, thinkingEffort: compatible ? agent.thinkingEffort : "off" });
      }}/>
    <WandSelect ariaLabel="本页思考深度" value={agent.thinkingEffort} options={efforts} displayValue={summary.thinking}
      className="conversation-runtime-select conversation-thinking-select" triggerKind="ghost" side="top" disabled={disabled}
      onValueChange={thinkingEffort => commit({ ...agent, thinkingEffort: thinkingEffort as WandTaskAgent["thinkingEffort"] })}/>
  </>;
}
