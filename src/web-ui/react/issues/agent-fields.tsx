import * as React from "react";
import type { AiTeam } from "../../../ai-team-types";
import type { WandTaskAgent } from "../../../task-types";
import { TeamAvatarStack } from "../ai-teams/avatar";
import { WandSelect } from "../ui";
import {
  issueAgentEffortOptions,
  issueAgentModeOptions,
  issueAgentModelOptions,
  withIssueAgentProvider,
  type IssueAgentProvider,
  type IssueModelCatalog,
} from "./task-board-agent";

const TEAM_VALUE_PREFIX = "team:";

/** CLI 工具下拉的候选：CLI 在前，团队接在后面，值带 "team:" 前缀区分。 */
export function agentTargetOptions(
  providerOptions: Array<{ value: IssueAgentProvider; label: string }>,
  teams: ReadonlyArray<AiTeam> | null | undefined,
): Array<{ value: string; label: string }> {
  return [
    ...providerOptions,
    ...(teams ?? []).map((team) => ({ value: `${TEAM_VALUE_PREFIX}${team.id}`, label: `团队 · ${team.name}` })),
  ];
}

/** 选中的是团队时返回团队 id，否则返回空串。 */
export function agentTargetTeamId(value: string): string {
  return value.startsWith(TEAM_VALUE_PREFIX) ? value.slice(TEAM_VALUE_PREFIX.length) : "";
}

const AGENT_KIND_OPTIONS = [
  { value: "structured", label: "结构化对话" },
  { value: "pty", label: "终端（PTY）" },
];

export function AgentField({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return <label className="task-board-native-field">
    <span className="task-board-native-field-label">{label}</span>
    {children}
  </label>;
}

/**
 * CLI 工具 / 模型 / 思考深度 / 工作模式（可选会话形态）这一组执行配置控件。
 * 任务看板的指派面板与 AI 团队成员编辑共用，保证两处的可选项与联动规则一致。
 */
export function AgentFields({
  agent,
  catalog,
  providerOptions,
  disabled,
  ariaPrefix,
  showKind = false,
  teams,
  teamId = "",
  onTeamChange,
  onChange,
}: {
  agent: WandTaskAgent;
  catalog: IssueModelCatalog | null;
  providerOptions: Array<{ value: IssueAgentProvider; label: string }> | null;
  disabled?: boolean;
  ariaPrefix: string;
  showKind?: boolean;
  /** 传入后团队会作为额外选项出现在 CLI 工具下拉里；选中团队时隐藏模型等参数。 */
  teams?: ReadonlyArray<AiTeam> | null;
  teamId?: string;
  onTeamChange?(teamId: string): void;
  onChange(agent: WandTaskAgent): void;
}): React.ReactElement {
  const team = teamId ? teams?.find((item) => item.id === teamId) ?? null : null;
  const selectTarget = (value: string): void => {
    const nextTeam = agentTargetTeamId(value);
    onTeamChange?.(nextTeam);
    if (!nextTeam) onChange(withIssueAgentProvider(agent, value as WandTaskAgent["provider"], catalog));
  };
  return <>
    <AgentField label="CLI 工具">
      {providerOptions ? <WandSelect
        value={team ? `${TEAM_VALUE_PREFIX}${team.id}` : agent.provider}
        options={onTeamChange ? agentTargetOptions(providerOptions, teams) : providerOptions}
        ariaLabel={`${ariaPrefix} CLI 工具`}
        className="task-board-native-select"
        disabled={disabled}
        onValueChange={selectTarget}
      /> : <span role="status">正在加载工具列表…</span>}
    </AgentField>
    {team ? <AgentField label="团队成员">
      <span className="task-board-team-target">
        <TeamAvatarStack members={team.members}/>
        <span>{team.members.length} 人 · 由负责人拆解分派</span>
      </span>
    </AgentField> : <AgentModelFields
      agent={agent}
      catalog={catalog}
      disabled={disabled}
      ariaPrefix={ariaPrefix}
      showKind={showKind}
      onChange={onChange}
    />}
  </>;
}

function AgentModelFields({
  agent,
  catalog,
  disabled,
  ariaPrefix,
  showKind,
  onChange,
}: {
  agent: WandTaskAgent;
  catalog: IssueModelCatalog | null;
  disabled?: boolean;
  ariaPrefix: string;
  showKind: boolean;
  onChange(agent: WandTaskAgent): void;
}): React.ReactElement {
  return <>
    <AgentField label="模型">
      <WandSelect
        value={agent.model}
        options={issueAgentModelOptions(catalog, agent.provider)}
        ariaLabel={`${ariaPrefix}模型`}
        searchable
        searchPlaceholder="搜索模型"
        className="task-board-native-select"
        disabled={disabled}
        onValueChange={(model) => onChange({ ...agent, model })}
      />
    </AgentField>
    <AgentField label="思考深度">
      <WandSelect
        value={agent.thinkingEffort}
        options={issueAgentEffortOptions(agent.provider, catalog, agent.model, agent.thinkingEffort)}
        ariaLabel={`${ariaPrefix}思考深度`}
        className="task-board-native-select"
        disabled={disabled}
        onValueChange={(effort) => onChange({
          ...agent,
          thinkingEffort: effort as WandTaskAgent["thinkingEffort"],
        })}
      />
    </AgentField>
    <AgentField label="工作模式">
      <WandSelect
        value={agent.mode}
        options={issueAgentModeOptions(agent.provider)}
        ariaLabel={`${ariaPrefix}工作模式`}
        className="task-board-native-select"
        disabled={disabled}
        onValueChange={(mode) => onChange({
          ...agent,
          mode: mode as WandTaskAgent["mode"],
        })}
      />
    </AgentField>
    {showKind && <AgentField label="会话形态">
      <WandSelect
        value={agent.kind}
        options={AGENT_KIND_OPTIONS}
        ariaLabel={`${ariaPrefix}会话形态`}
        className="task-board-native-select"
        disabled={disabled}
        onValueChange={(kind) => onChange({ ...agent, kind: kind as WandTaskAgent["kind"] })}
      />
    </AgentField>}
  </>;
}
