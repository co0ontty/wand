import * as React from "react";
import { EmployeeAvatar } from "../agents/employee-avatar.js";
import { WandIcon, WandSelect } from "../ui";
import { ProviderLogo } from "../provider-logo.js";
import { sortProviderOptions, useProviderUsage } from "../provider-usage.js";
import { nextChoice, type ChoiceNavigationKey } from "../new-session/choice-navigation.js";
import type {
  WorkspaceProvider,
  WorkspaceSessionKind,
  WorkspaceSessionTarget,
  WorkspaceTeamOption,
} from "./types.js";
import {
  WORKSPACE_AGENT_OPTIONS,
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
  id: string; // employeeId, teamId, or cli target (e.g. "claude")
}

const RADIO_NAVIGATION_KEYS = new Set<ChoiceNavigationKey>([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
]);

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
    WORKSPACE_AGENT_OPTIONS,
    providerUsage ?? {},
    (option) => option.value,
  );
  const teamBlocked = teamWorkspaceId === "";

  const [lastCliProvider, setLastCliProvider] = React.useState<WorkspaceSessionTarget>("claude");
  const [switchedNotice, setSwitchedNotice] = React.useState<string | null>(null);
  const subjectButtonRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const kindButtonRefs = React.useRef(new Map<WorkspaceSessionKind, HTMLButtonElement>());

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
    } else {
      setSwitchedNotice(null);
    }
  };
  const handleKindKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || !RADIO_NAVIGATION_KEYS.has(event.key as ChoiceNavigationKey)) return;
    event.preventDefault();
    const next = nextChoice(["structured", "pty"] as const, kind, event.key as ChoiceNavigationKey);
    handleKindSelect(next);
    requestAnimationFrame(() => kindButtonRefs.current.get(next)?.focus());
  };

  // 扁平化所有可供方向键导航的选项 IDs
  const allNavigableIds = React.useMemo(() => {
    const list: string[] = [];
    if (kind !== "pty") {
      employees.filter((emp) => !emp.archivedAt).forEach((emp) => list.push(`employee:${emp.id}`));
      if (teams && !teamBlocked) {
        teams.forEach((t) => list.push(`team:${t.id}`));
      }
    }
    targetOptions.forEach((opt) => list.push(`cli:${opt.value}`));
    return list;
  }, [kind, employees, teams, targetOptions, teamBlocked]);

  const currentCompositeId = `${selectedSubject.type}:${selectedSubject.id}`;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || !RADIO_NAVIGATION_KEYS.has(e.key as ChoiceNavigationKey)) return;
    e.preventDefault();
    const next = nextChoice(allNavigableIds, currentCompositeId, e.key as ChoiceNavigationKey);
    const [type, id] = next.split(":") as [ExecutionSubjectType, string];
    if (type && id) {
      onSubjectChange({ type, id });
      setSwitchedNotice(null);
      requestAnimationFrame(() => subjectButtonRefs.current.get(next)?.focus());
    }
  };

  const isPty = kind === "pty";

  return (
    <div className="wand-execution-subject-picker">
      {/* 会话类型选择：先选会话类型，再选执行主体 */}
      <fieldset className="wand-new-session-fieldset" disabled={disabled}>
        <legend className="wand-new-session-field-label">会话类型</legend>
        <div className="wand-new-session-choices" role="radiogroup" aria-label="会话类型">
          {WORKSPACE_KIND_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={kind === option.value}
              tabIndex={kind === option.value ? 0 : -1}
              disabled={disabled}
              className={`wand-new-session-choice wand-new-session-kind-choice${kind === option.value ? " active" : ""}`}
              onClick={() => handleKindSelect(option.value)}
              onKeyDown={handleKindKeyDown}
              ref={(node) => {
                if (node) kindButtonRefs.current.set(option.value, node);
                else kindButtonRefs.current.delete(option.value);
              }}
            >
              <span className="wand-new-session-choice-label">{option.label}</span>
              <span className="wand-new-session-choice-description">{option.description}</span>
            </button>
          ))}
        </div>
      </fieldset>

      {/* 一个整体的 radiogroup，内部分为三个视觉分组 */}
      <div
        className="wand-new-session-fieldset"
        role="radiogroup"
        aria-label="执行主体"
      >
        <div className="wand-new-session-field-label">执行主体</div>

        {switchedNotice ? (
          <p className="wand-new-session-field-hint text-warning" role="alert">
            {switchedNotice}
          </p>
        ) : null}

        {/* 分组 1: 硅基员工 (PTY 下隐藏) */}
        {!isPty ? (
          <div className="wand-subject-group" role="group" aria-label="硅基员工">
            <div className="wand-subject-group-title">硅基员工</div>
            <div className="wand-new-session-choices wand-workspace-agent-options">
              {employees.filter((emp) => !emp.archivedAt).map((emp) => {
                const checked = selectedSubject.type === "employee" && selectedSubject.id === emp.id;
                return (
                  <button
                    key={emp.id}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={checked ? 0 : -1}
                    disabled={disabled}
                    className={`wand-new-session-choice wand-new-session-provider-choice${checked ? " active" : ""}`}
                    onClick={() => {
                      onSubjectChange({ type: "employee", id: emp.id });
                      setSwitchedNotice(null);
                    }}
                    onKeyDown={handleKeyDown}
                    ref={(node) => {
                      if (node) subjectButtonRefs.current.set(`employee:${emp.id}`, node);
                      else subjectButtonRefs.current.delete(`employee:${emp.id}`);
                    }}
                  >
                    <EmployeeAvatar employee={emp} size="md" className="wand-new-session-provider-logo" />
                    <span className="wand-new-session-choice-label">{emp.name}</span>
                    <span className="wand-new-session-choice-description">
                      {emp.duty || (emp.agents[0] ? `首选: ${emp.agents[0].provider}` : "智能助手")}
                    </span>
                  </button>
                );
              })}
              {!employeesLoading && employees.every((emp) => Boolean(emp.archivedAt)) ? (
                <div className="wand-subject-empty-row">
                  <span>还没有硅基员工</span>
                  <button
                    type="button"
                    className="wand-link-btn"
                    onClick={() => taskBoardController.open("", "", "teams")}
                  >
                    创建员工
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* 分组 2: AI 团队 (PTY 下隐藏，无团队时整组不显示) */}
        {!isPty && teams && teams.length > 0 ? (
          <div className="wand-subject-group" role="group" aria-label="AI 团队">
            <div className="wand-subject-group-title">AI 团队</div>
            <div className="wand-new-session-choices wand-workspace-agent-options">
              {teams.map((t) => {
                const checked = selectedSubject.type === "team" && selectedSubject.id === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={checked ? 0 : -1}
                    disabled={disabled || teamBlocked}
                    title={teamBlocked ? TEAM_NEEDS_PROJECT_HINT : undefined}
                    className={`wand-new-session-choice wand-new-session-provider-choice${checked ? " active" : ""}`}
                    onClick={() => {
                      onSubjectChange({ type: "team", id: t.id });
                      setSwitchedNotice(null);
                    }}
                    onKeyDown={handleKeyDown}
                    ref={(node) => {
                      if (node) subjectButtonRefs.current.set(`team:${t.id}`, node);
                      else subjectButtonRefs.current.delete(`team:${t.id}`);
                    }}
                  >
                    <WandIcon name="parallel" size={20} className="wand-new-session-provider-logo" strokeWidth={1.8} />
                    <span className="wand-new-session-choice-label">{t.name}</span>
                    <span className="wand-new-session-choice-description">{t.detail}</span>
                  </button>
                );
              })}
            </div>
            {teamBlocked ? (
              <p className="wand-new-session-field-hint" role="status">
                {TEAM_NEEDS_PROJECT_HINT}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* 分组 3: CLI 工具 */}
        <div className="wand-subject-group" role="group" aria-label="CLI 工具">
          <div className="wand-subject-group-title">CLI 工具</div>
          <div className="wand-new-session-choices wand-workspace-agent-options">
            {targetOptions.map((opt) => {
              const checked = selectedSubject.type === "cli" && selectedSubject.id === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked ? 0 : -1}
                  disabled={disabled}
                  className={`wand-new-session-choice wand-new-session-provider-choice${checked ? " active" : ""}`}
                  onClick={() => {
                    onSubjectChange({ type: "cli", id: opt.value });
                    setSwitchedNotice(null);
                  }}
                  onKeyDown={handleKeyDown}
                  ref={(node) => {
                    if (node) subjectButtonRefs.current.set(`cli:${opt.value}`, node);
                    else subjectButtonRefs.current.delete(`cli:${opt.value}`);
                  }}
                >
                  {opt.value === "shell" ? (
                    <WandIcon
                      name="terminal"
                      size={20}
                      className="wand-new-session-provider-logo"
                      strokeWidth={1.8}
                    />
                  ) : (
                    <ProviderLogo
                      provider={opt.value}
                      className="wand-new-session-provider-logo"
                    />
                  )}
                  <span className="wand-new-session-choice-label">{opt.label}</span>
                  <span className="wand-new-session-choice-description">{opt.description}</span>
                </button>
              );
            })}
          </div>
          {isPty ? (
            <p className="wand-new-session-field-hint">
              PTY 是纯 CLI 终端，员工与团队只在结构化模式下生效。
            </p>
          ) : null}
        </div>
      </div>

      {/* 仅在 CLI 且不是空白终端时显示模型选项 */}
      {showModel && selectedSubject.type === "cli" && selectedSubject.id !== "shell" ? (
        <fieldset className="wand-new-session-fieldset wand-workspace-agent-model" disabled={disabled}>
          <legend className="wand-new-session-field-label">模型</legend>
          <WandSelect
            value={model || MODEL_CATALOG_DEFAULT_VALUE}
            options={wandModelOptions(catalog, selectedSubject.id as WorkspaceProvider)}
            ariaLabel="模型"
            searchable
            searchPlaceholder="搜索模型"
            disabled={disabled}
            className="wand-workspace-agent-model-select"
            onValueChange={onModelChange}
          />
          <p className="wand-new-session-field-hint">
            所选模型随会话启动一起提交；「跟随服务端默认」沿用服务端配置的默认模型。
          </p>
        </fieldset>
      ) : null}
    </div>
  );
}
