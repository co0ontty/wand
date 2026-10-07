import * as React from "react";
import { Flex, Alert, Card, Collapse, Input, Tag , Typography } from "antd";
import { DEFAULT_EMPLOYEE_TAG, SYSTEM_EMPLOYEE_TAG, isBuiltinSiliconEmployee, isDefaultSiliconEmployee, parseSiliconEmployeeTagInput, siliconEmployeeTags, type SiliconEmployee } from "../../../ai-team-types.js";
import { EmployeeMemory } from "./employee-memory.js";
import { EmployeeKnowledge } from "./employee-knowledge.js";
import { EmployeeTagsField } from "./employee-tags-field.js";
import { WandButton, WandIcon } from "../ui";
import { SettingsField } from "../settings/fields.js";
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
  editorOnly = false,
  onCancel,
  onDirtyChange,
  onSavingChange,
}: {
  employee: SiliconEmployee;
  catalog: IssueModelCatalog | null;
  providerOptions: ProviderOptions;
  onSave(patch: Partial<SiliconEmployee>): Promise<void>;
  onArchive?(): Promise<void>;
  onUnarchive?(): Promise<void>;
  onDelete?(): Promise<void>;
  editorOnly?: boolean;
  onCancel?(): void;
  onDirtyChange?(dirty: boolean): void;
  onSavingChange?(saving: boolean): void;
}): React.ReactElement {
  const [editing, setEditing] = React.useState(editorOnly);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = React.useState<SiliconEmployee>(employee);
  const [submitting, setSaving] = React.useState(false);
  const [avatarProcessing, setAvatarProcessing] = React.useState(false);
  const saving = submitting || avatarProcessing;
  const [tagInput, setTagInput] = React.useState(() => siliconEmployeeTags(employee).join("，"));
  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saved" | "failed">("idle");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!editing) {
      setDraft(employee);
      setTagInput(siliconEmployeeTags(employee).join("，"));
    }
  }, [employee, editing]);
  React.useEffect(() => {
    onDirtyChange?.(JSON.stringify(draft) !== JSON.stringify(employee) || tagInput !== siliconEmployeeTags(employee).join("，"));
  }, [draft, tagInput, employee, onDirtyChange]);
  React.useEffect(() => { onSavingChange?.(saving); }, [saving, onSavingChange]);

  const onToggle = () => {
    if (saving) return;
    if (editorOnly) { onCancel?.(); return; }
    setSaveStatus("idle");
    setTagInput(siliconEmployeeTags(employee).join("，"));
    if (editing) {
      setDraft(employee);
      setError(null);
      setEditing(false);
    } else {
      setEditing(true);
    }
  };

  const handleSave = async () => {
    if (saving) return;
    setSaveStatus("failed");
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
      const tags = isBuiltinSiliconEmployee(employee)
        ? siliconEmployeeTags(employee) : parseSiliconEmployeeTagInput(tagInput);
      await onSave({ ...draft, tags });
      setSaveStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaveStatus("failed");
    } finally {
      setSaving(false);
    }
  };

  const isArchived = Boolean(employee.archivedAt);
  const isSystem = isBuiltinSiliconEmployee(employee);
  const isDefault = isDefaultSiliconEmployee(employee);
  const tag = isDefault ? DEFAULT_EMPLOYEE_TAG : SYSTEM_EMPLOYEE_TAG;
  const tags = siliconEmployeeTags(employee);
  // `wand-team-member` 保留为编辑态业务钩子；展开与收起由 Ant Collapse 管理，
  // 卡片自身外观由通用卡片承担；员工特有的归档/内置态另挂标记。
  const cardCls = `wand-team-member wand-employee-card${isArchived ? " is-archived" : ""}${isSystem ? " is-system" : ""}`;

  return (
    <Card
      size="small"
      className={cardCls}
      data-open={editing || undefined}
      data-employee-id={employee.id}
      onChange={() => { setSaveStatus("idle"); setError(null); }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && editing && !saving) {
          event.preventDefault();
          event.stopPropagation();
          onToggle();
          triggerRef.current?.focus();
        }
      }}
    >
      {!editorOnly ? <WandButton kind="ghost"
        ref={triggerRef}
        type="button"
        className="wand-team-member-head" style={{ width: "100%", height: "auto", minHeight: 56, textAlign: "start", alignItems: "center", gap: 12 }}
        aria-expanded={editing}
        onClick={onToggle}
      >
        <EmployeeAvatar employee={employee} size="lg" />
        <Flex vertical gap={2} className="wand-team-member-copy" style={{ flex: 1, minWidth: 0 }}>
          <Flex align="center" wrap gap={6}>
            <Typography.Text strong>{employee.name}</Typography.Text>
            {isSystem ? <Tag color="gold" className="wand-employee-system-tag">{tag}</Tag> : null}
            {isArchived ? <Tag className="wand-employee-archived-tag">已归档</Tag> : null}
          </Flex>
          {!isSystem ? <Flex align="center" gap={4} wrap className="wand-employee-tags" aria-label={`员工标签：${tags.join("、") || "暂无"}`}>
            {tags.length ? tags.map((label) => <Tag key={label}>{label}</Tag>)
              : <Typography.Text type="secondary">暂无标签</Typography.Text>}
          </Flex> : null}
          <Typography.Text type="secondary" ellipsis>{employee.duty || "还没写职责"}</Typography.Text>
          <Typography.Text type="secondary" ellipsis className="wand-team-member-agent">
            {employee.agents[0]
              ? issueAgentProviderModelLine(employee.agents[0], catalog)
              : "未配置候选"}
            {employee.agents.length > 1 ? ` (+${employee.agents.length - 1} 个备用)` : null}
          </Typography.Text>
        </Flex>
        <WandIcon name="chevronDown" size={14} />
      </WandButton> : null}

      {/* 就地展开编辑表单 */}
      <Collapse bordered={false} ghost activeKey={editing ? ["editor"] : []}
        styles={{ header: { display: "none" }, body: { padding: 0 } }}
        items={[{ key: "editor", label: "成员编辑", showArrow: false, forceRender: true, children:
          <div className="wand-team-member-body" inert={!editing}>
        <Flex vertical gap={10} style={{ minWidth: 0, paddingTop: 10 }} className="wand-team-member-inner">
          {isSystem ? (
            <Alert
              className="wand-employee-system-note"
              type="info"
              showIcon
              title={<strong>{tag}</strong>}
              description={isDefault
                ? "选择 CLI 或未选择员工时使用这个默认角色；你选的工具、模型与权限保持不变。内置标签、名字与基础设定固定，工作风格由短期记忆定期调整；下面的候选用于直接找这位员工或未配置工具的任务。"
                : "Wand 内置员工：标签、名字、职责与角色设定由服务端固定，不可修改、不可删除；Wand 自己的 AI 调用（Commit、标题、提示词优化）都按下面的候选链执行。"}
            />
          ) : (
            <>
              <SettingsField label="名字" htmlFor={`employee-${employee.id}-name`}>
                <Input
                  id={`employee-${employee.id}-name`}
                  value={draft.name}
                  placeholder="员工名字"
                  disabled={saving}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </SettingsField>

              <EmployeeTagsField id={`employee-${employee.id}-tags`} value={tagInput}
                disabled={saving} onChange={setTagInput} />

              <EmployeeAvatarPicker
                onBusyChange={setAvatarProcessing}
                avatar={draft.avatar}
                name={draft.name}
                disabled={saving}
                onChange={(avatar) => setDraft({ ...draft, avatar })}
              />

              <SettingsField label="职责" htmlFor={`employee-${employee.id}-duty`}>
                <Input.TextArea
                  id={`employee-${employee.id}-duty`}
                  rows={2}
                  value={draft.duty}
                  placeholder="一句话职责：在侧栏、选择器和署名中显示"
                  disabled={saving}
                  onChange={(e) => setDraft({ ...draft, duty: e.target.value })}
                />
              </SettingsField>

              <SettingsField label="角色设定 (Prompt)" htmlFor={`employee-${employee.id}-prompt`}>
                <Input.TextArea
                  id={`employee-${employee.id}-prompt`}
                  rows={4}
                  value={draft.prompt}
                  placeholder="设定角色的专业能力、行为守则与交付习惯（创建会话时作为系统提示生效）"
                  disabled={saving}
                  onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                />
              </SettingsField>
            </>
          )}

          {isDefault ? <>
            <EmployeeMemory active={editing} />
            <SettingsField label="当前角色设定" htmlFor={`employee-${employee.id}-prompt`}>
              <Input.TextArea id={`employee-${employee.id}-prompt`} rows={6} value={employee.prompt} readOnly />
            </SettingsField>
          </> : null}

          <EmployeeKnowledge employeeId={employee.id} active={editing} />

          <CandidatesListEditor
            agents={draft.agents}
            label={draft.name || "员工"}
            catalog={catalog}
            providerOptions={providerOptions}
            disabled={saving}
            structuredOnly
            onChange={(agents: WandTaskAgent[]) => { setSaveStatus("idle"); setDraft({ ...draft, agents }); }}
          />

          <Flex justify="end" wrap gap={6} className="wand-team-member-actions">
            <WandButton
              kind="primary"
              size="small"
              className="wand-employee-save-submit"
              aria-busy={saving || undefined}
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? "保存中…" : saveStatus === "saved" ? "已保存" : saveStatus === "failed" ? "保存失败" : "保存修改"}
            </WandButton>
            <WandButton
              kind="ghost"
              size="small"
              disabled={saving}
              onClick={onToggle}
            >
              取消
            </WandButton>
            {isSystem || !onArchive || !onUnarchive ? null : isArchived ? (
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
            {isSystem || !onDelete ? null : (
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
          </Flex>
          {error ? <Alert className="wand-team-candidate-error" type="error" showIcon role="alert" title={error} /> : null}
        </Flex>
      </div> }]}/>
    </Card>
  );
}
