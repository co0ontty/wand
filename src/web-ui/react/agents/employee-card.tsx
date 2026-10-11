import * as React from "react";
import { Alert, Input } from "antd";
import { isBuiltinSiliconEmployee, isDefaultSiliconEmployee, parseSiliconEmployeeTagInput, siliconEmployeeTags, type SiliconEmployee } from "../../../ai-team-types.js";
import { isFixedAvatarEmployee } from "../../../fixed-employee-avatar.js";
import { WandButton, WandIcon, WandInput } from "../ui";
import { EmployeeAvatar } from "./employee-avatar.js";
import { EmployeeAvatarWorkspace } from "./employee-avatar-workspace.js";
import { CandidatesListEditor, type ProviderOptions } from "./candidate-editor.js";
import { candidateListError } from "./candidate-list.js";
import { EmployeeKnowledge } from "./employee-knowledge.js";
import { EmployeeMemory } from "./employee-memory.js";
import { EmployeeTagsField } from "./employee-tags-field.js";
import type { IssueModelCatalog } from "../issues/task-board-agent.js";
import { installEmployeeProfileStyles } from "../styles/employee-profile.js";

const sections = [{ id: "identity", label: "个人资料", icon: "user" }, { id: "role", label: "职责与角色", icon: "clipboard" }, { id: "tools", label: "执行候选", icon: "cpu" }, { id: "appearance", label: "头像", icon: "image" }, { id: "advanced", label: "高级设置", icon: "gear" }] as const;

export function EmployeeCard({ employee, catalog, providerOptions, onSave, onArchive, onUnarchive, onDelete, onCancel, onDirtyChange, onSavingChange }: {
  employee: SiliconEmployee; catalog: IssueModelCatalog | null; providerOptions: ProviderOptions;
  onSave(patch: Partial<SiliconEmployee>): Promise<void>; onArchive?(): Promise<void>; onUnarchive?(): Promise<void>; onDelete?(): Promise<void>;
  editorOnly?: boolean; onCancel?(): void; onDirtyChange?(dirty: boolean): void; onSavingChange?(saving: boolean): void;
}): React.ReactElement {
  const [baseline, setBaseline] = React.useState(employee);
  const [draft, setDraft] = React.useState(employee);
  const [tagInput, setTagInput] = React.useState(() => siliconEmployeeTags(employee).join("，"));
  const [step, setStep] = React.useState("identity");
  const [avatarOpen, setAvatarOpen] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [avatarRevision, resetAvatarWorkspace] = React.useReducer(value => value + 1, 0);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [saveStatus, setSaveStatus] = React.useState<"idle" | "saved" | "failed">("idle");
  const nameInput = React.useRef<HTMLInputElement>(null);
  const avatarTrigger = React.useRef<HTMLButtonElement>(null);
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
    if (invalid) { setSaveStatus("failed"); setStep("tools"); setError(invalid); return; }
    if (!draft.name.trim()) { setSaveStatus("failed"); setStep("identity"); setError("员工名字不能为空。"); requestAnimationFrame(() => nameInput.current?.focus()); return; }
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
  const closeAvatar = () => { setAvatarOpen(false); if (step === "appearance") setStep("identity"); requestAnimationFrame(() => avatarTrigger.current?.focus()); };
  const field = (label: string, id: string, children: React.ReactNode, hint?: string) => <div className="field"><label htmlFor={id}>{label}</label>{children}{hint && <small>{hint}</small>}</div>;
  return <main className="profile wand-employee-card wand-team-member" data-employee-profile data-open="true" data-employee-id={employee.id}
    onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && !saving) { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
    <header className="profile-header"><div><span className="crumb">员工 <WandIcon name="chevron" size={12}/>个人资料</span><h2 title={draft.name}>{draft.name || "未命名员工"}</h2></div>
      <div className="save-actions"><span className="dirty">{uploading ? "正在处理图片…" : dirty ? "有未保存修改" : "已保存"}</span><WandButton kind="ghost" onClick={cancel} disabled={submitting}>取消</WandButton><WandButton className="wand-employee-save-submit" kind="primary" onClick={() => void save()} disabled={!dirty || saving} aria-busy={submitting || undefined}>{submitting ? "保存中…" : saveStatus === "saved" ? "已保存" : saveStatus === "failed" ? "保存失败" : "保存修改"}</WandButton></div></header>
    <nav className="profile-tabs" aria-label="资料分区">{sections.map(section => <button type="button" key={section.id} data-step={section.id} aria-current={step === section.id ? "page" : undefined} onClick={() => { setStep(section.id); if (section.id === "appearance") setAvatarOpen(true); }}><WandIcon name={section.icon} size={14}/>{section.label}</button>)}</nav>
    {(error || notice) && <div className={`feedback ${error ? "error" : ""}`} role={error ? "alert" : "status"}>{error || notice}</div>}
    <div className="profile-body" data-avatar-open={avatarOpen}><div className="editor" data-step={step}>
      <div className="identity-summary"><EmployeeAvatar employee={draft} provider="" size="lg"/><div><strong>{draft.name}</strong><small>{siliconEmployeeTags(employee).join(" · ") || "硅基员工"}</small></div><WandButton ref={avatarTrigger} size="small" kind="ghost" onClick={() => { setAvatarOpen(true); setStep("appearance"); }}><WandIcon name={fixed || lockedProfile ? "lock" : "edit"} size={13}/>{fixed || lockedProfile ? "查看头像" : "编辑头像"}</WandButton></div>
      {lockedProfile && <Alert type="info" title="内置员工" description="此员工的系统身份与基础资料固定；执行候选仍可编辑。"/>}
      <section id="identity" className="form-section"><div className="section-heading"><h3>个人资料</h3><span>在工作台中识别这位员工</span></div><div className="identity-fields">
        {field("员工名字", `employee-${employee.id}-name`, <WandInput ref={nameInput} id={`employee-${employee.id}-name`} value={draft.name} maxLength={40} disabled={saving || lockedProfile} onChange={event => patch({ name: event.target.value })}/>)}
        <EmployeeTagsField id={`employee-${employee.id}-tags`} value={tagInput} disabled={saving || builtin} onChange={value => { setTagInput(value); setNotice(""); }}/></div></section>
      <section id="role" className="form-section"><div className="section-heading"><h3>职责与角色</h3><span>定义工作范围与协作方式</span></div>
        {field("一句话职责", `employee-${employee.id}-duty`, <Input.TextArea id={`employee-${employee.id}-duty`} value={draft.duty} rows={2} maxLength={2000} disabled={saving || lockedProfile} onChange={event => patch({ duty: event.target.value })}/>)}
        {field("角色设定", `employee-${employee.id}-prompt`, <Input.TextArea id={`employee-${employee.id}-prompt`} value={draft.prompt} rows={5} maxLength={20000} disabled={saving || lockedProfile} onChange={event => patch({ prompt: event.target.value })}/>, "用于此员工之后的新工作；已有执行快照保持不变。")}</section>
      <section id="tools" className="form-section"><CandidatesListEditor agents={draft.agents} label={draft.name || "员工"} catalog={catalog} providerOptions={providerOptions} disabled={saving} structuredOnly onChange={agents => patch({ agents })}/></section>
      <section id="advanced" className="form-section"><details className="advanced-details" open={step === "advanced"}><summary>高级设置<span>身份与知识</span></summary><div className="advanced-content">
        {field("员工 ID", `employee-${employee.id}-id`, <WandInput id={`employee-${employee.id}-id`} value={employee.id} readOnly/>)}
        {isDefaultSiliconEmployee(employee) && <EmployeeMemory active={step === "advanced"}/>}
        <EmployeeKnowledge employeeId={employee.id} active={step === "advanced"}/>
        {!builtin && <div className="save-actions">{employee.archivedAt ? onUnarchive && <WandButton disabled={saving} onClick={() => void onUnarchive()}>恢复员工</WandButton> : onArchive && <WandButton disabled={saving} onClick={() => void onArchive()}>归档员工</WandButton>}{onDelete && <WandButton kind="danger" disabled={saving} onClick={() => void onDelete()}>删除员工</WandButton>}</div>}
      </div></details></section>
    </div>{avatarOpen && <EmployeeAvatarWorkspace key={avatarRevision} employee={draft} disabled={submitting || lockedProfile} onChange={avatar => patch({ avatar })} onBusyChange={setUploading} onClose={closeAvatar}/>}</div>
  </main>;
}
