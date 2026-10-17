import { Alert, Collapse, Flex, Form, Typography } from "antd";
import * as React from "react";
import { isLocalDecisionModel, WAND_LOCAL_DECISION_MODEL, WAND_LOCAL_DECISION_LABEL } from "../../../decision-expert-identity.js";
import { OPENROUTER_FREE_SELECTOR, OPENROUTER_FREE_GROUP } from "../../../openrouter-free-selection.js";
import type { AiTeam, SiliconEmployee } from "../../../ai-team-types";
import type { TaskExecutionSubject, WandTaskAgent } from "../../../task-types";
import { TeamAvatarStack } from "../ai-teams/avatar";
import { EmployeeAvatar } from "../agents/employee-avatar";
import { WandButton, WandDialogSurface, WandSelect } from "../ui";
import { AGENT_TOOL_OPTIONS, WAND_AGENT_TOOL_ID } from "../../provider-identity.js";
import {
  issueAgentLabel,
  issueAgentModeLabel,
  issueAgentEffortLabel,
  issueAgentEffortOptions,
  issueAgentModeOptions,
  issueAgentModelOptions,
  issueAgentTargetValue,
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
    ...(employees ?? []).filter((employee) => !employee.archivedAt).map((employee) => ({
      value: `${EMPLOYEE_VALUE_PREFIX}${employee.id}`,
      label: `员工 · ${employee.name}`,
    })),
    ...(teams ?? []).map((team) => ({ value: `${TEAM_VALUE_PREFIX}${team.id}`, label: `团队 · ${team.name}` })),
    ...providerOptions,
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
  onDispatchSelect,
  employeeOverride = false,
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
  onDispatchSelect?(): void;
  employeeOverride?: boolean;
  /** A target change carries the complete subject, so callers never remember intermediate resets. */
  onChange(agent: WandTaskAgent, subject?: TaskExecutionSubject, employeeOverride?: boolean): void;
}): React.ReactElement {
  const team = teamId ? teams?.find((item) => item.id === teamId) ?? null : null;
  const employee = employeeId ? employees?.find((item) => item.id === employeeId) ?? null : null;
  // Provider-only catalogs omit the SDK option, while the saved value includes
  // its engine. Keep both dimensions in this selector, including saved choices.
  const toolOptions = providerOptions && allowSdkEngine ? [
    ...providerOptions,
    ...AGENT_TOOL_OPTIONS.filter(option => option.id === WAND_AGENT_TOOL_ID && !providerOptions.some(item => item.value === option.id))
      .map(option => ({ value: option.id, label: option.label })),
  ] : providerOptions;
  const selectTarget = (value: string): void => {
    if (agentTargetIsDispatch(value)) { onDispatchSelect?.(); return; }
    const nextTeam = agentTargetTeamId(value);
    const nextEmployee = agentTargetEmployeeId(value);
    onTeamChange?.(nextTeam);
    onEmployeeChange?.(nextEmployee);
    if (nextTeam || nextEmployee) {
      onChange(nextEmployee ? employees?.find(item => item.id === nextEmployee)?.agents[0] ?? { ...agent, kind: "structured" } : { ...agent, kind: "structured" }, {
        type: nextEmployee ? "employee" : "team", id: nextEmployee || nextTeam,
      });
      return;
    }
    const next = withIssueAgentTarget(agent, value, catalog);
    onChange(next, { type: "cli", id: next.provider });
  };
  const peopleFirst = !!(onTeamChange || onEmployeeChange);
  const targetSelect = (direct: boolean) => <AgentField label={peopleFirst ? direct ? "直接工具指派" : "指派给" : "执行工具"}>
    {toolOptions ? <WandSelect
      value={direct || !peopleFirst ? direct && (employee || team) ? "" : issueAgentTargetValue(agent) : employee ? `${EMPLOYEE_VALUE_PREFIX}${employee.id}` : team ? `${TEAM_VALUE_PREFIX}${team.id}` : employeeId ? `${EMPLOYEE_VALUE_PREFIX}${employeeId}` : teamId ? `${TEAM_VALUE_PREFIX}${teamId}` : ""}
      options={direct || !peopleFirst ? toolOptions : agentTargetOptions([], teams, employees, { includeDispatch: !!onDispatchSelect })}
      ariaLabel={`${ariaPrefix}${direct ? "直接工具" : "指派给"}`}
      className="task-board-native-select" disabled={disabled} onValueChange={selectTarget}
    /> : <span role="status">正在加载执行对象…</span>}
  </AgentField>;
  return <>
    {targetSelect(false)}
    {employeeId && !employee && <Alert type="warning" title="已指派员工不可用，请明确选择其他员工或在高级选项中改为工具指派。"/>}
    {teamId && !team && <Alert type="warning" title="已指派团队不可用，请重新选择执行对象。"/>}
    {employee ? <EmployeeTaskTools employee={employee} agent={agent} catalog={catalog} providerOptions={toolOptions}
      disabled={disabled} ariaPrefix={ariaPrefix} overridden={employeeOverride}
      onReset={() => onChange(employee.agents[0]!, { type: "employee", id: employee.id }, false)}
      onApply={next => onChange(next, { type: "employee", id: employee.id }, true)}/>
      : team ? <AgentField label="团队成员"><Flex align="center" gap={10}>
        <TeamAvatarStack members={team.members}/><Typography.Text type="secondary">{team.members.length} 人 · 由负责人拆解分派</Typography.Text>
      </Flex></AgentField> : peopleFirst ? <Typography.Text type="secondary">{issueAgentLabel(agent.provider, agent.engine)} · 直接工具配置；在高级选项中修改</Typography.Text> :
      <AgentModelFields agent={agent} catalog={catalog} disabled={disabled} ariaPrefix={ariaPrefix} showKind={showKind} allowSdkEngine={allowSdkEngine} onChange={onChange}/>}
    {peopleFirst && <Collapse style={{ width: "100%" }} ghost items={[{ key: "tools", label: "高级选项 · 直接指派工具", children: <>
      <Typography.Paragraph type="secondary">选择工具后将直接派发，不使用员工或团队身份。</Typography.Paragraph>
      {targetSelect(true)}
      {!employee && !team && <AgentModelFields agent={agent} catalog={catalog} disabled={disabled} ariaPrefix={ariaPrefix} showKind={showKind} allowSdkEngine={allowSdkEngine} onChange={next => onChange(next, { type: "cli", id: next.provider })}/>}
    </> }]}/>}
  </>;
}

export function EmployeeTaskTools({ employee, agent, catalog, providerOptions, disabled, ariaPrefix, onApply, overridden, onReset }: {
  employee: SiliconEmployee; agent: WandTaskAgent; catalog: IssueModelCatalog | null;
  providerOptions: Array<{ value: string; label: string }> | null; disabled?: boolean; ariaPrefix: string;
  overridden: boolean; onReset(): void;
  onApply(agent: WandTaskAgent): void;
}): React.ReactElement {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(agent);
  const summary = [issueAgentLabel(agent.provider, agent.engine), agent.model, issueAgentEffortLabel(agent.thinkingEffort), issueAgentModeLabel(agent.mode)].join(" · ");
  return <Flex vertical gap={4}>
    <Flex align="center" gap={8}><EmployeeAvatar employee={employee} size="sm"/><strong>{employee.name}</strong></Flex>
    <WandButton kind="ghost" size="small" disabled={disabled || !employee.agents.length} aria-label={`${ariaPrefix}工具设置`} onClick={() => { setDraft(agent); setEditing(true); }}>{summary}</WandButton>
    <Typography.Text type="secondary">{overridden ? "已覆盖本次任务；员工默认配置保持不变。" : `${employee.agents.length} 个候选 · 按员工默认顺序执行`}</Typography.Text>
    {overridden && <WandButton kind="ghost" size="small" onClick={onReset}>恢复员工默认</WandButton>}
    {!employee.agents.length && <Alert type="warning" title="该员工尚未配置执行工具"/>}
    <WandDialogSurface open={editing} title="本次任务的工具设置" description="应用仅影响本次执行，不修改员工默认配置；覆盖后只使用所选配置。" onOpenChange={setEditing}>
      <Alert type="info" title="切换工具后，模型和运行模式会按该工具支持范围调整；请核对后应用。"/>
      <AgentFields agent={draft} catalog={catalog} providerOptions={providerOptions} allowSdkEngine disabled={disabled} ariaPrefix="本次" onChange={setDraft}/>
      {draft.mode === "full-access" && <Alert type="warning" title="完全访问：本次工具将自动确认权限请求。"/>}
      <Flex justify="end" gap={8}><WandButton kind="ghost" onClick={() => setEditing(false)}>取消</WandButton><WandButton kind="primary" onClick={() => { onApply({ ...draft, kind: "structured" }); setEditing(false); }}>应用到本次</WandButton></Flex>
    </WandDialogSurface>
  </Flex>;
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
  const models = [...issueAgentModelOptions(catalog, agent.provider)];
  if ((isLocalDecisionModel(agent.model) || (agent.provider === "pi" && agent.engine === "sdk"))
    && !models.some(option => option.value === WAND_LOCAL_DECISION_MODEL)) {
    models.unshift({ value: WAND_LOCAL_DECISION_MODEL, label: WAND_LOCAL_DECISION_LABEL });
  }
  if (agent.model === OPENROUTER_FREE_SELECTOR && !models.some(option => option.value === OPENROUTER_FREE_SELECTOR)) {
    models.unshift({ value: OPENROUTER_FREE_SELECTOR, label: `Wand ${OPENROUTER_FREE_GROUP}` });
  }
  if (agent.model && !models.some(option => option.value === agent.model)) {
    models.push({ value: agent.model, label: `${agent.model}（已保存）` });
  }
  return <>
    <AgentField label="模型">
      <WandSelect
        value={agent.model}
        options={models}
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
    {allowSdkEngine && agent.provider === "pi" && agent.kind === "structured" && agent.engine !== "cli" && agent.engine && <AgentField label="执行方式">
      <Typography.Text type="secondary">Wand 进程内执行，无需 CLI 工具</Typography.Text>
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
