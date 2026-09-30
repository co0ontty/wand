import * as React from "react";
import { SYSTEM_EMPLOYEE_TAG, isSystemSiliconEmployee, type SiliconEmployee } from "../../../ai-team-types.js";
import { WandButton, WandIcon } from "../ui";
import { CandidatesListEditor } from "./candidate-editor.js";
import { EmployeeAvatar, EmployeeAvatarPicker } from "./employee-avatar.js";
import { issueAgentProviderModelLine, type IssueModelCatalog } from "../issues/task-board-agent.js";
import type { ProviderOptions } from "./candidate-editor.js";
import type { WandTaskAgent } from "../../../task-types.js";
import { candidateListError } from "./candidate-list.js";

export function EmployeeCard({
  employee,
  catalog,
  providerOptions,
  onSave,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  employee: SiliconEmployee;
  catalog: IssueModelCatalog | null;
  providerOptions: ProviderOptions;
  onSave(patch: Partial<SiliconEmployee>): Promise<void>;
  onArchive(): Promise<void>;
  onUnarchive(): Promise<void>;
  onDelete(): Promise<void>;
}): React.ReactElement {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<SiliconEmployee>(employee);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setDraft(employee);
  }, [employee]);

  const onToggle = () => {
    if (editing) {
      setDraft(employee);
      setError(null);
      setEditing(false);
    } else {
      setEditing(true);
    }
  };

  const handleSave = async () => {
    const listErr = draft.agents.some((agent) => agent.kind !== "structured")
      ? "硅基员工只能使用结构化候选。"
      : candidateListError(draft.agents);
    if (listErr) {
      setError(listErr);
      return;
    }
    if (!draft.name.trim()) {
      setError("员工名字不能为空。");
      return;
    }
    try {
      setSaving(true);
      setError(null);
      await onSave(draft);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const isArchived = Boolean(employee.archivedAt);
  const isSystem = isSystemSiliconEmployee(employee);
  const cardCls = `wand-team-member wand-employee-card${isArchived ? " is-archived" : ""}${isSystem ? " is-system" : ""}`;

  return (
    <article
      className={cardCls}
      data-open={editing || undefined}
    >
      <button
        type="button"
        className="wand-team-member-head"
        aria-expanded={editing}
        onClick={onToggle}
      >
        <EmployeeAvatar employee={employee} size="lg" />
        <span className="wand-team-member-copy">
          <strong>
            {employee.name}
            {isSystem ? <em className="wand-employee-system-tag">{SYSTEM_EMPLOYEE_TAG}</em> : null}
            {isArchived ? <em className="wand-employee-archived-tag">已归档</em> : null}
          </strong>
          <small>{employee.duty || "还没写职责"}</small>
          <span className="wand-team-member-agent">
            {employee.agents[0]
              ? issueAgentProviderModelLine(employee.agents[0], catalog)
              : "未配置候选"}
            {employee.agents.length > 1 ? ` (+${employee.agents.length - 1} 个备用)` : null}
          </span>
        </span>
        <WandIcon name="chevronDown" size={14} />
      </button>

      {/* 就地展开编辑表单 */}
      <div className="wand-team-member-body" inert={!editing}>
        <div className="wand-team-member-inner">
          {isSystem ? (
            <div className="wand-employee-system-note" role="note">
              <strong>{SYSTEM_EMPLOYEE_TAG}</strong>
              <span>Wand 内置员工：名字、职责与角色设定由服务端固定，不可修改、不可删除；Wand 自己的 AI 调用（Commit、标题、提示词优化）都按下面的候选链执行。</span>
            </div>
          ) : (
            <>
              <div className="wand-settings-field">
                <label className="wand-settings-label" htmlFor={`employee-${employee.id}-name`}>
                  名字
                </label>
                <input
                  id={`employee-${employee.id}-name`}
                  type="text"
                  className="wand-settings-input"
                  value={draft.name}
                  placeholder="员工名字"
                  disabled={saving}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>

              <EmployeeAvatarPicker
                avatar={draft.avatar}
                name={draft.name}
                disabled={saving}
                onChange={(avatar) => setDraft({ ...draft, avatar })}
              />

              <div className="wand-settings-field">
                <label className="wand-settings-label" htmlFor={`employee-${employee.id}-duty`}>
                  职责
                </label>
                <textarea
                  id={`employee-${employee.id}-duty`}
                  className="wand-settings-input resize-none"
                  rows={2}
                  value={draft.duty}
                  placeholder="一句话职责：在侧栏、选择器和署名中显示"
                  disabled={saving}
                  onChange={(e) => setDraft({ ...draft, duty: e.target.value })}
                />
              </div>

              <div className="wand-settings-field">
                <label className="wand-settings-label" htmlFor={`employee-${employee.id}-prompt`}>
                  角色设定 (Prompt)
                </label>
                <textarea
                  id={`employee-${employee.id}-prompt`}
                  className="wand-settings-input resize-none"
                  rows={4}
                  value={draft.prompt}
                  placeholder="设定角色的专业能力、行为守则与交付习惯（创建会话时作为系统提示生效）"
                  disabled={saving}
                  onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                />
              </div>
            </>
          )}

          <CandidatesListEditor
            agents={draft.agents}
            label={draft.name || "员工"}
            catalog={catalog}
            providerOptions={providerOptions}
            disabled={saving}
            structuredOnly
            onChange={(agents: WandTaskAgent[]) => setDraft({ ...draft, agents })}
          />

          {error ? (
            <div className="wand-team-candidate-error" role="alert">
              {error}
            </div>
          ) : null}

          <div className="wand-team-member-actions">
            <WandButton
              kind="primary"
              size="small"
              disabled={saving}
              onClick={handleSave}
            >
              保存修改
            </WandButton>
            <WandButton
              kind="ghost"
              size="small"
              disabled={saving}
              onClick={onToggle}
            >
              取消
            </WandButton>
            {isSystem ? null : isArchived ? (
              <WandButton
                kind="ghost"
                size="small"
                disabled={saving}
                onClick={onUnarchive}
              >
                恢复
              </WandButton>
            ) : (
              <WandButton
                kind="ghost"
                size="small"
                disabled={saving}
                onClick={onArchive}
              >
                归档
              </WandButton>
            )}
            {isSystem ? null : (
              <WandButton
                kind="ghost"
                size="small"
                disabled={saving}
                onClick={onDelete}
              >
                <WandIcon name="trash" size={14} slot="start" />
                删除
              </WandButton>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
