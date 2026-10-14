import { SettingsActionButton, SettingsField } from "../settings/fields.js";
import * as React from "react";
import { Alert, Input } from "antd";
import { isBuiltinSiliconEmployee, isDefaultSiliconEmployee, parseSiliconEmployeeTagInput, siliconEmployeeTags, type SiliconEmployee } from "../../../ai-team-types.js";
import { isFixedAvatarEmployee } from "../../../fixed-employee-avatar.js";
import { WandButton, WandIcon, WandIconButton, WandInput } from "../ui";
import { EmployeeAvatar } from "./employee-avatar.js";
import { EmployeeAvatarWorkspace } from "./employee-avatar-workspace.js";
import { CandidatesListEditor, type ProviderOptions } from "./candidate-editor.js";
import { candidateListError } from "./candidate-list.js";
import { EmployeeKnowledge } from "./employee-knowledge.js";
import { EmployeeMemory } from "./employee-memory.js";
import { EmployeeTagsField } from "./employee-tags-field.js";
import type { IssueModelCatalog } from "../issues/task-board-agent.js";
import { installEmployeeProfileStyles } from "../styles/employee-profile.js";

export function EmployeeCard({ employee, catalog, providerOptions, onSave, onArchive, onUnarchive, onDelete, onCancel, onBack, onDirtyChange, onSavingChange }: {
  employee: SiliconEmployee; catalog: IssueModelCatalog | null; providerOptions: ProviderOptions;
  onSave(patch: Partial<SiliconEmployee>): Promise<void>; onArchive?(): Promise<void>; onUnarchive?(): Promise<void>; onDelete?(): Promise<void>;
  editorOnly?: boolean; onCancel?(): void; onBack?(): void; onDirtyChange?(dirty: boolean): void; onSavingChange?(saving: boolean): void;
}): React.ReactElement {
  const [baseline, setBaseline] = React.useState(employee);
  const [draft, setDraft] = React.useState(employee);
  const [tagInput, setTagInput] = React.useState(() => siliconEmployeeTags(employee).join("，"));
  const [avatarOpen, setAvatarOpen] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [avatarRevision, resetAvatarWorkspace] = React.useReducer(value => value + 1, 0);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saved" | "failed">("idle");
  const nameInput = React.useRef<HTMLInputElement>(null);
  const avatarTrigger = React.useRef<HTMLButtonElement>(null);
  const toolsSection = React.useRef<HTMLElement>(null);
  const fixed = isFixedAvatarEmployee(employee);
  const builtin = isBuiltinSiliconEmployee(employee);
  const lockedProfile = builtin && !fixed;
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline) || tagInput !== siliconEmployeeTags(baseline).join("，");
  const dirtyRef = React.useRef(dirty); dirtyRef.current = dirty;
  const saving = submitting || uploading;
  React.useEffect(() => { installEmployeeProfileStyles(); }, []);
  React.useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  React.useEffect(() => { onSavingChange?.(saving); }, [saving, onSavingChange]);
  React.useEffect(() => {
    // Background knowledge updates must not overwrite an active form draft.
    if (dirtyRef.current || submitting || uploading) return;
    setBaseline(employee); setDraft(employee); setTagInput(siliconEmployeeTags(employee).join("，"));
  }, [employee]);
  const patch = (value: Partial<SiliconEmployee>) => { setDraft(current => ({ ...current, ...value })); setError(""); setNotice(""); setSaveStatus("idle"); };
  const cancel = () => {
    if (submitting) return;
    resetAvatarWorkspace(); setUploading(false);
    setDraft(baseline); setTagInput(siliconEmployeeTags(baseline).join("，")); setError(""); setNotice("已撤销本次修改"); setSaveStatus("idle");
    onCancel?.();
  };
  const save = async () => {
    if (saving || !dirty) return;
    const invalid = draft.agents.some(agent => agent.kind !== "structured") ? "硅基员工只能使用结构化候选。" : candidateListError(draft.agents);
    if (invalid) { setSaveStatus("failed"); setError(invalid); toolsSection.current?.scrollIntoView({ block: "start" }); return; }
    if (!draft.name.trim()) { setSaveStatus("failed"); setError("员工名字不能为空。"); requestAnimationFrame(() => nameInput.current?.focus()); return; }
    try {
      const tags = builtin ? siliconEmployeeTags(baseline) : parseSiliconEmployeeTagInput(tagInput);
      const next = { ...draft, tags };
      // Fixed identities accept partial profile edits: do not echo a generated prompt or a stale avatar.
      const input: Partial<SiliconEmployee> = fixed ? {} : next;
      if (fixed) for (const field of ["name", "duty", "prompt", "agents"] as const) {
        if (JSON.stringify(next[field]) !== JSON.stringify(baseline[field])) Object.assign(input, { [field]: next[field] });
      }
      setSubmitting(true); setError(""); await onSave(input);
      setBaseline(next); setDraft(next); setNotice("员工资料已保存"); setSaveStatus("saved");
    } catch (cause) { setSaveStatus("failed"); setError(cause instanceof Error ? cause.message : "保存员工失败，请重试。"); }
    finally { setSubmitting(false); }
  };
  const closeAvatar = () => { setAvatarOpen(false); requestAnimationFrame(() => avatarTrigger.current?.focus()); };
  const field = (label: string, id: string, children: React.ReactNode, hint?: string) => <SettingsField label={label} htmlFor={id} hint={hint}>{children}</SettingsField>;
  return <main className="profile wand-employee-card wand-team-member" data-employee-profile data-open="true" data-employee-id={employee.id}
    onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && !saving) { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
    <header className="profile-header"><div className="profile-heading">{onBack && <WandIconButton aria-label="返回员工列表" disabled={saving} onClick={onBack}><WandIcon name="chevronLeft" size={18}/></WandIconButton>}<h2>编辑员工</h2></div>
      <div className="save-actions">{uploading && <span className="dirty" role="status">正在处理图片…</span>}<WandButton kind="ghost" onClick={cancel} disabled={submitting}>取消</WandButton><SettingsActionButton className="wand-employee-save-submit" kind="primary" onClick={() => void save()} disabled={!dirty || saving} pending={submitting} settled={saveStatus === "saved" ? "success" : saveStatus === "failed" ? "error" : null} pendingLabel="保存中…" successLabel="已保存" errorLabel="保存失败">{saveStatus === "saved" ? "已保存" : saveStatus === "failed" ? "保存失败" : "保存修改"}</SettingsActionButton></div></header>
    {(error || notice) && <div className={`feedback ${error ? "error" : ""}`} role={error ? "alert" : "status"}>{error || notice}</div>}
    <div className="profile-body"><div className="editor">
      <div className="identity-summary"><EmployeeAvatar employee={draft} provider="" size="lg"/><div><strong>{draft.name || "未命名员工"}</strong><small>{siliconEmployeeTags(employee).join(" · ") || "硅基员工"}</small></div><WandButton ref={avatarTrigger} size="small" kind="ghost" aria-expanded={avatarOpen} onClick={() => setAvatarOpen(value => !value)}><WandIcon name={fixed || lockedProfile ? "lock" : "edit"} size={13}/>{avatarOpen ? "收起头像" : fixed || lockedProfile ? "查看头像" : "编辑头像"}</WandButton></div>
      {avatarOpen && <EmployeeAvatarWorkspace key={avatarRevision} employee={draft} disabled={submitting || lockedProfile} onChange={avatar => patch({ avatar })} onBusyChange={setUploading} onClose={closeAvatar}/>}
      {lockedProfile && <Alert type="info" title="内置员工已锁定" description="名字、头像、职责、角色设定与标签不可修改，也不能归档或删除；执行候选仍可编辑。"/>}
      <section id="identity" className="form-section" aria-label="个人资料"><div className="identity-fields">
        {field("员工名字", `employee-${employee.id}-name`, <WandInput ref={nameInput} id={`employee-${employee.id}-name`} value={draft.name} maxLength={40} disabled={saving || lockedProfile} onChange={event => patch({ name: event.target.value })}/>)}
        <EmployeeTagsField id={`employee-${employee.id}-tags`} value={tagInput} disabled={saving || builtin} onChange={value => { setTagInput(value); setNotice(""); }}/></div></section>
      <section id="role" className="form-section" aria-label="职责与角色">
        {field("一句话职责", `employee-${employee.id}-duty`, <Input.TextArea id={`employee-${employee.id}-duty`} value={draft.duty} autoSize={{ minRows: 2, maxRows: 8 }} style={{ resize: "none" }} maxLength={2000} disabled={saving || lockedProfile} onChange={event => patch({ duty: event.target.value })}/>)}
        {field("角色设定", `employee-${employee.id}-prompt`, <Input.TextArea id={`employee-${employee.id}-prompt`} value={draft.prompt} autoSize={{ minRows: 5, maxRows: 14 }} style={{ resize: "none" }} maxLength={20000} disabled={saving || lockedProfile} onChange={event => patch({ prompt: event.target.value })}/>, "用于此员工之后的新工作；已有执行快照保持不变。")}</section>
      <section id="tools" ref={toolsSection} className="form-section"><CandidatesListEditor agents={draft.agents} label={draft.name || "员工"} catalog={catalog} providerOptions={providerOptions} disabled={saving} structuredOnly onChange={agents => patch({ agents })}/></section>
      <section id="advanced" className="form-section"><details className="advanced-details" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary>知识与员工管理</summary><div className="advanced-content">
        {field("员工 ID", `employee-${employee.id}-id`, <WandInput id={`employee-${employee.id}-id`} value={employee.id} readOnly/>)}
        {isDefaultSiliconEmployee(employee) && <EmployeeMemory active={advanced}/>}
        <EmployeeKnowledge employeeId={employee.id} active={advanced}/>
        {!builtin && <div className="save-actions">{employee.archivedAt ? onUnarchive && <WandButton disabled={saving} onClick={() => void onUnarchive()}>恢复员工</WandButton> : onArchive && <WandButton disabled={saving} onClick={() => void onArchive()}>归档员工</WandButton>}{onDelete && <WandButton kind="danger" disabled={saving} onClick={() => void onDelete()}>删除员工</WandButton>}</div>}
      </div></details></section>
    </div></div>
  </main>;
}
