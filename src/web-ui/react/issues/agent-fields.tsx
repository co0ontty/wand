import { Flex, Form, Typography } from "antd";
import * as React from "react";
import type { AiTeam, SiliconEmployee } from "../../../ai-team-types";
import type { WandTaskAgent, WandTaskAgentEngine } from "../../../task-types";
import { TeamAvatarStack } from "../ai-teams/avatar";
import { WandSelect } from "../ui";
import {
  issueAgentEffortOptions,
  issueAgentModeOptions,
  issueAgentModelOptions,
  withIssueAgentTarget,
  type IssueModelCatalog,
} from "./task-board-agent";

const TEAM_VALUE_PREFIX = "team:";
const EMPLOYEE_VALUE_PREFIX = "employee:";
/** 无指派派工：不指定员工/团队，由本机决策模型给出建议名单后再确认开工。 */
export const DISPATCH_VALUE = "dispatch:";

/** CLI 工具下拉的候选：CLI 在前，团队接在后面，值带 "team:" 前缀区分。 */
export function agentTargetOptions(
  providerOptions: Array<{ value: string; label: string }>,
  teams: ReadonlyArray<AiTeam> | null | undefined,
  employees?: ReadonlyArray<SiliconEmployee> | null,
  options: { includeDispatch?: boolean } = {},
): Array<{ value: string; label: string }> {
  return [
    ...providerOptions,
    ...(employees ?? []).filter((employee) => !employee.archivedAt).map((employee) => ({
      value: `${EMPLOYEE_VALUE_PREFIX}${employee.id}`,
      label: `员工 · ${employee.name}`,
    })),
    ...(teams ?? []).map((team) => ({ value: `${TEAM_VALUE_PREFIX}${team.id}`, label: `团队 · ${team.name}` })),
    ...(options.includeDispatch ? [{ value: DISPATCH_VALUE, label: "临时派工 · 决策选人" }] : []),
  ];
}

/** 选中的是「临时派工」时返回 true；它不是 ExecutionSubject，提交路径完全不同。 */
export function agentTargetIsDispatch(value: string): boolean {
  return value === DISPATCH_VALUE;
}

/** 选中的是团队时返回团队 id，否则返回空串。 */
export function agentTargetTeamId(value: string): string {
  return value.startsWith(TEAM_VALUE_PREFIX) ? value.slice(TEAM_VALUE_PREFIX.length) : "";
}

export function agentTargetEmployeeId(value: string): string {
  return value.startsWith(EMPLOYEE_VALUE_PREFIX) ? value.slice(EMPLOYEE_VALUE_PREFIX.length) : "";
}

const AGENT_ENGINE_OPTIONS: ReadonlyArray<{ value: WandTaskAgentEngine; label: string }> = [
  { value: "cli", label: "Pi CLI" },
  { value: "sdk", label: "Wand Agent" },
];

const AGENT_KIND_OPTIONS = [
  { value: "structured", label: "结构化对话" },
  { value: "pty", label: "终端（PTY）" },
];
export function AgentField({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return <Form.Item label={label} className="task-board-native-field">
    {children}
  </Form.Item>;
}

/**
 * CLI 工具 / 模型 / 思考深度 / 工作模式（可选会话形态）这一组执行配置控件。
 * 任务看板的指派面板与 AI 团队成员编辑共用，保证两处的可选项与联动规则一致。
 * SDK（Wand Agent）执行引擎只在员工/团队候选编辑器中开放。
 */
export function AgentFields({
  agent,
  catalog,
  providerOptions,
  disabled,
  ariaPrefix,
  showKind = false,
  allowSdkEngine = false,
  teams,
  teamId = "",
  onTeamChange,
  employees,
  employeeId = "",
  onEmployeeChange,
  onChange,
}: {
  agent: WandTaskAgent;
  catalog: IssueModelCatalog | null;
  providerOptions: Array<{ value: string; label: string }> | null;
  disabled?: boolean;
  ariaPrefix: string;
  showKind?: boolean;
  allowSdkEngine?: boolean;
  teams?: ReadonlyArray<AiTeam> | null;
  teamId?: string;
  onTeamChange?(teamId: string): void;
  employees?: ReadonlyArray<SiliconEmployee> | null;
  employeeId?: string;
  onEmployeeChange?(employeeId: string): void;
  onChange(agent: WandTaskAgent): void;
}): React.ReactElement {
  const team = teamId ? teams?.find((item) => item.id === teamId) ?? null : null;
  const employee = employeeId ? employees?.find((item) => item.id === employeeId) ?? null : null;
  const selectTarget = (value: string): void => {
    const nextTeam = agentTargetTeamId(value);
    const nextEmployee = agentTargetEmployeeId(value);
    onTeamChange?.(nextTeam);
    onEmployeeChange?.(nextEmployee);
    if (nextTeam || nextEmployee) {
      if (agent.kind !== "structured") onChange({ ...agent, kind: "structured" });
      return;
    }
    onChange(withIssueAgentTarget(agent, value, catalog));
  };
  return <>
    <AgentField label={onTeamChange || onEmployeeChange ? "指派给" : "CLI 工具"}>
      {providerOptions ? <WandSelect
        value={employee ? `${EMPLOYEE_VALUE_PREFIX}${employee.id}` : team ? `${TEAM_VALUE_PREFIX}${team.id}` : agent.provider}
        options={onTeamChange || onEmployeeChange ? agentTargetOptions(providerOptions, teams, employees) : providerOptions}
        ariaLabel={`${ariaPrefix}指派给`}
        className="task-board-native-select"
        disabled={disabled}
        onValueChange={selectTarget}
      /> : <span role="status">正在加载工具列表…</span>}
    </AgentField>
    {employee ? <AgentField label="执行顺序">
      <Flex align="center" gap={10}>
        <Typography.Text type="secondary">{employee.agents.length} 个结构化候选 · 按顺序降级</Typography.Text>
      </Flex>
    </AgentField> : team ? <AgentField label="团队成员">
      <Flex align="center" gap={10}>
        <TeamAvatarStack members={team.members}/>
        <Typography.Text type="secondary">{team.members.length} 人 · 由负责人拆解分派</Typography.Text>
      </Flex>
    </AgentField> : <AgentModelFields
      agent={agent}
      catalog={catalog}
      disabled={disabled}
      ariaPrefix={ariaPrefix}
      showKind={showKind}
      allowSdkEngine={allowSdkEngine}
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
  allowSdkEngine = false,
  onChange,
}: {
  agent: WandTaskAgent;
  catalog: IssueModelCatalog | null;
  disabled?: boolean;
  ariaPrefix: string;
  showKind: boolean;
  allowSdkEngine?: boolean;
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
    {allowSdkEngine && agent.provider === "pi" && agent.kind === "structured" && <AgentField label="执行引擎">
      <WandSelect
        value={agent.engine ?? "cli"}
        options={AGENT_ENGINE_OPTIONS}
        ariaLabel={`${ariaPrefix}执行引擎`}
        className="task-board-native-select"
        disabled={disabled}
        onValueChange={(engine) => onChange({ ...agent, engine: engine as WandTaskAgentEngine })}
      />
    </AgentField>}
    {showKind && <AgentField label="会话形态">
      <WandSelect
        value={agent.kind}
        options={AGENT_KIND_OPTIONS}
        ariaLabel={`${ariaPrefix}会话形态`}
        className="task-board-native-select"
        disabled={disabled}
        onValueChange={(kind) => onChange({ ...agent, kind: kind as WandTaskAgent["kind"], ...(kind === "pty" ? { engine: undefined } : {}) })}
      />
    </AgentField>}
  </>;
}
