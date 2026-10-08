import { Alert, Flex, Form, Radio, Segmented, Spin, Typography } from "antd";
import { WandUiBoundary } from "../theme";
import * as React from "react";
import { EmployeeAvatar } from "../agents/employee-avatar.js";
import { WandButton, WandIcon, WandSelect } from "../ui";
import { ProviderLogo } from "../provider-logo.js";
import { sortProviderOptions, useProviderUsage } from "../provider-usage.js";
import { AGENT_TOOL_OPTIONS, agentToolIdFor, type AgentToolEngine } from "../../provider-identity.js";
import type {
  WorkspaceProvider,
  WorkspaceSessionKind,
  WorkspaceSessionTarget,
  WorkspaceTeamOption,
} from "./types.js";
import {
  WORKSPACE_KIND_OPTIONS,
  TEAM_NEEDS_PROJECT_HINT,
} from "./workspace-agent-picker.js";
import { useSiliconEmployees } from "../agents/employee-repository.js";
import { useWandModelCatalog } from "../use-model-catalog.js";
import { MODEL_CATALOG_DEFAULT_VALUE, wandModelOptions } from "../model-catalog.js";
import { taskBoardController } from "../issues/task-board-controller.js";

export type ExecutionSubjectType = "employee" | "team" | "cli";

export interface UnifiedExecutionSubject {
  type: ExecutionSubjectType;
  id: string; // employeeId, teamId, or cli target (e.g. "claude", "pi")
  /** 仅 cli + pi：`sdk` 表示 Wand Agent（进程内 SDK），缺省是 Pi CLI。 */
  engine?: AgentToolEngine;
}

/** CLI 分组的一条：Pi / Wand Agent 是同一个 provider 的两条执行路径，所以按选项 id 区分。 */
interface CliToolChoice {
  id: string;
  provider: WorkspaceSessionTarget;
  engine?: AgentToolEngine;
  label: string;
  description: string;
  /** 只有结构化会话能跑（进程内 SDK 没有终端形态）。 */
  structuredOnly?: boolean;
}

const CLI_TOOL_CHOICES: readonly CliToolChoice[] = [
  ...AGENT_TOOL_OPTIONS.map((option) => ({
    id: option.id,
    provider: option.provider as WorkspaceSessionTarget,
    engine: option.engine,
    label: option.label,
    description: option.description,
    structuredOnly: option.engine === "sdk",
  })),
  { id: "shell", provider: "shell", label: "空白终端", description: "仅启动系统 Shell" },
];

export interface UnifiedExecutionSubjectPickerProps {
  selectedSubject: UnifiedExecutionSubject;
  kind: WorkspaceSessionKind;
  model: string;
  disabled?: boolean;
  teams?: ReadonlyArray<WorkspaceTeamOption> | null;
  teamWorkspaceId?: string;
  showModel?: boolean;
  onSubjectChange(subject: UnifiedExecutionSubject): void;
  onKindChange(kind: WorkspaceSessionKind): void;
  onModelChange(model: string): void;
}

export function UnifiedExecutionSubjectPicker({
  selectedSubject,
  kind,
  model,
  disabled = false,
  teams = null,
  teamWorkspaceId = "",
  showModel = true,
  onSubjectChange,
  onKindChange,
  onModelChange,
}: UnifiedExecutionSubjectPickerProps): React.ReactElement {
  const { employees, loading: employeesLoading } = useSiliconEmployees();
  const catalog = useWandModelCatalog();
  const providerUsage = useProviderUsage(true);
  const targetOptions = sortProviderOptions(
    CLI_TOOL_CHOICES,
    providerUsage ?? {},
    (option) => option.provider,
  );
  const teamBlocked = teamWorkspaceId === "";

  const [lastCliProvider, setLastCliProvider] = React.useState<WorkspaceSessionTarget>("claude");
  const [switchedNotice, setSwitchedNotice] = React.useState<string | null>(null);

  // 记录上一次的 CLI target
  React.useEffect(() => {
    if (selectedSubject.type === "cli" && selectedSubject.id !== "shell") {
      setLastCliProvider(selectedSubject.id as WorkspaceSessionTarget);
    }
  }, [selectedSubject]);

  // 当切换到 PTY 时，如果当前主体是 employee 或 team，自动退回到 CLI
  const handleKindSelect = (nextKind: WorkspaceSessionKind) => {
    if (disabled) return;
    onKindChange(nextKind);
    if (nextKind === "pty" && (selectedSubject.type === "employee" || selectedSubject.type === "team")) {
      onSubjectChange({ type: "cli", id: lastCliProvider });
      setSwitchedNotice("已切回 CLI：PTY 不支持员工 / 团队。");
    } else if (nextKind === "pty" && selectedSubject.engine === "sdk") {
      onSubjectChange({ type: "cli", id: selectedSubject.id });
      setSwitchedNotice("已切回 Pi CLI：Wand Agent 只跑结构化会话。");
    } else {
      setSwitchedNotice(null);
    }
  };
  const isPty = kind === "pty";

  // 选中态用选项 id 表达：同一个 pi provider 的 Pi CLI 与 Wand Agent 必须能分辨。
  const selectedToolId = selectedSubject.type === "cli"
    ? (selectedSubject.id === "shell" ? "shell" : agentToolIdFor(selectedSubject.id as WorkspaceProvider, selectedSubject.engine))
    : "";

  const choiceLabel = (identity: React.ReactNode, title: string, detail?: string) => (
    <Flex align="center" gap={8}>
      {identity}<Flex vertical><Typography.Text strong>{title}</Typography.Text>{detail ? <Typography.Text type="secondary">{detail}</Typography.Text> : null}</Flex>
    </Flex>
  );
  return <WandUiBoundary>
    <Flex vertical gap={16}>
      <Form.Item label="会话类型">
        <Segmented block aria-label="会话类型" value={kind} disabled={disabled}
          options={WORKSPACE_KIND_OPTIONS.map((option) => ({ value: option.value,
            label: <span title={option.description}>{option.label}</span> }))}
          onChange={(value) => handleKindSelect(value as WorkspaceSessionKind)}/>
      </Form.Item>
      <Form.Item label="执行主体">
        {switchedNotice ? <Alert type="warning" showIcon title={switchedNotice}/> : null}
        <Radio.Group value={`${selectedSubject.type}:${selectedSubject.type === "cli" ? selectedToolId : selectedSubject.id}`}
          disabled={disabled}
          aria-label="执行主体" style={{ width: "100%" }}
          onChange={(event) => {
            const value = String(event.target.value), separator = value.indexOf(":");
            const type = value.slice(0, separator) as ExecutionSubjectType;
            const id = value.slice(separator + 1);
            setSwitchedNotice(null);
            if (type === "cli") {
              const choice = CLI_TOOL_CHOICES.find((item) => item.id === id);
              if (choice) {
                if (choice.structuredOnly && kind !== "structured") {
                  onKindChange("structured");
                  setSwitchedNotice(choice.id === "wand-agent" ? "Wand Agent 使用结构化会话。" : null);
                } else {
                  setSwitchedNotice(null);
                }
                onSubjectChange({ type: "cli", id: choice.provider, ...(choice.engine ? { engine: choice.engine } : {}) });
                return;
              }
            }
            onSubjectChange({ type, id });
          }}>
          <Flex vertical gap={16}>
          {!isPty ? <Flex vertical gap={8} role="group" aria-label="硅基员工">
            <Typography.Text strong>硅基员工</Typography.Text>
            {employeesLoading ? <Spin size="small"/> : null}
            {employees.filter((emp) => !emp.archivedAt).map((emp) => (
              <Radio key={emp.id} value={`employee:${emp.id}`}>
                {choiceLabel(<EmployeeAvatar employee={emp} size="md"/>, emp.name,
                  emp.duty || (emp.agents[0] ? `首选: ${emp.agents[0].provider}` : "智能助手"))}
              </Radio>
            ))}
            {!employeesLoading && employees.every((emp) => Boolean(emp.archivedAt)) ? (
              <div><span>还没有硅基员工</span><WandButton kind="ghost"
                onClick={() => taskBoardController.open("", "", "teams")}>创建员工</WandButton></div>
            ) : null}
          </Flex> : null}
          {!isPty && teams && teams.length > 0 ? <Flex vertical gap={8} role="group" aria-label="AI 团队">
            <Typography.Text strong>AI 团队</Typography.Text>
            {teams.map((team) => <Radio key={team.id} value={`team:${team.id}`}
              disabled={disabled || teamBlocked} title={teamBlocked ? TEAM_NEEDS_PROJECT_HINT : undefined}>
              {choiceLabel(<WandIcon name="parallel" size={20}/>, team.name, team.detail)}
            </Radio>)}
            {teamBlocked ? <p role="status">{TEAM_NEEDS_PROJECT_HINT}</p> : null}
          </Flex> : null}
          <Flex vertical gap={8} role="group" aria-label="CLI 工具">
            <Typography.Text strong>CLI 工具</Typography.Text>
            {targetOptions.map((option) => {
              // PTY 下 Wand Agent 留在原位、只置灰：列表项不因形态切换而跳动。
              const unavailable = option.structuredOnly && isPty;
              return <Radio key={option.id} value={`cli:${option.id}`} disabled={disabled || unavailable}
                title={unavailable ? "Wand Agent 只跑结构化会话" : undefined}>
                {choiceLabel(option.id === "shell" ? <WandIcon name="terminal" size={20}/>
                  : option.engine === "sdk" ? <WandIcon name="spark" size={20}/>
                  : <ProviderLogo provider={option.provider} className="wand-subject-provider"/>,
                  option.label, option.description)}
              </Radio>;
            })}
          </Flex>
          </Flex>
        </Radio.Group>
        {isPty ? <Typography.Paragraph type="secondary">PTY 是纯 CLI 终端，员工、团队与 Wand Agent 只在结构化模式下生效。</Typography.Paragraph> : null}
      </Form.Item>
      {showModel && selectedSubject.type === "cli" && selectedSubject.id !== "shell" ? (
        <Form.Item label="模型" extra="所选模型随会话启动一起提交；「跟随服务端默认」沿用服务端配置的默认模型。">
          <WandSelect value={model || MODEL_CATALOG_DEFAULT_VALUE}
            options={wandModelOptions(catalog, selectedSubject.id as WorkspaceProvider)}
            ariaLabel="模型" searchable searchPlaceholder="搜索模型" disabled={disabled}
            className="wand-workspace-agent-model-select" onValueChange={onModelChange}/>
        </Form.Item>
      ) : null}
    </Flex>
  </WandUiBoundary>;
}
