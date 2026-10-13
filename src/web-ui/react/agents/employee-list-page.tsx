import * as React from "react";
import { Alert, Checkbox, Spin } from "antd";
import { isBuiltinSiliconEmployee, siliconEmployeeTags, type SiliconEmployee } from "../../../ai-team-types.js";
import { WandButton, WandIcon, WandIconButton, WandSearchField } from "../ui";
import { EmployeeAvatar } from "./employee-avatar.js";
import { EmployeeCard } from "./employee-card.js";
import { EmployeeCreateForm } from "./employee-create-form.js";
import { useSiliconEmployees, siliconEmployeesRepository, employeeUpdateInput } from "./employee-repository.js";
import { installEmployeeProfileStyles } from "../styles/employee-profile.js";
import type { IssueModelCatalog } from "../issues/task-board-agent.js";
import type { ProviderOptions } from "./candidate-editor.js";
import type { WandTaskAgent } from "../../../task-types.js";
import { wandOverlay } from "../overlay-controller.js";

export function EmployeeListPage({ catalog, providerOptions, onEditingChange }: { catalog: IssueModelCatalog | null; providerOptions: ProviderOptions; onEditingChange?(editing: boolean): void }): React.ReactElement {
  const { employees, loading, error, reload } = useSiliconEmployees({ includeArchived: true });
  const [query, setQuery] = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [mutationError, setMutationError] = React.useState("");
  const directoryRef = React.useRef<HTMLElement>(null);
  const directoryPosition = React.useRef(0);
  const returnEmployee = React.useRef<string | null>(null);
  const filtered = React.useMemo(() => employees.filter(employee => (showArchived || !employee.archivedAt)
    && `${employee.name} ${employee.duty} ${employee.prompt} ${siliconEmployeeTags(employee).join(" ")}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [employees, query, showArchived]);
  const selected = employees.find(employee => employee.id === selectedId) ?? null;
  React.useEffect(() => { installEmployeeProfileStyles(); }, []);
  const editing = isCreating || selected !== null;
  React.useLayoutEffect(() => { onEditingChange?.(editing); }, [editing, onEditingChange]);
  React.useLayoutEffect(() => {
    if (editing || !directoryRef.current) return;
    directoryRef.current.scrollTop = directoryPosition.current;
    const row = [...directoryRef.current.querySelectorAll<HTMLButtonElement>("[data-directory-employee-id]")]
      .find(node => node.dataset.directoryEmployeeId === returnEmployee.current);
    row?.focus({ preventScroll: true });
  }, [editing]);
  const discard = async (): Promise<boolean> => {
    if (busy) return false;
    if (!dirty) return true;
    const answer = await wandOverlay.dialog({ title: "放弃尚未保存的修改？", description: "当前员工的修改还没有保存。", actions: [{ label: "继续编辑", value: false, autoFocus: true }, { label: "放弃修改", value: true, kind: "danger" }] });
    if (answer.dismissed === true) return false;
    return !!answer.action;
  };
  const select = async (employee: SiliconEmployee) => {
    if (!await discard()) return;
    directoryPosition.current = directoryRef.current?.scrollTop ?? 0;
    returnEmployee.current = employee.id;
    setSelectedId(employee.id); setIsCreating(false); setDirty(false);
  };
  const back = async () => {
    if (!await discard()) return;
    setSelectedId(null); setIsCreating(false); setDirty(false);
  };
  const create = async () => {
    if (!await discard()) return;
    directoryPosition.current = directoryRef.current?.scrollTop ?? 0;
    setIsCreating(true); setDirty(false);
  };
  const handleCreate = async (draft: { name: string; duty: string; prompt: string; avatar: string; tags: string[]; agents: WandTaskAgent[] }) => {
    const saved = await siliconEmployeesRepository.create(draft); setSelectedId(saved.id); setIsCreating(false); reload();
  };
  const handleSave = async (patch: Partial<SiliconEmployee>) => {
    if (!selected) return;
    await siliconEmployeesRepository.update(selected.id, employeeUpdateInput(selected, patch));
    setDirty(false); reload();
  };
  const mutation = async (action: "archive" | "unarchive" | "remove") => {
    if (!selected || busy) return;
    if (action === "remove") {
      const answer = await wandOverlay.dialog({ title: `删除员工「${selected.name}」？`, description: "员工配置和其独立知识库将被删除；已有会话与历史消息会保留。", actions: [{ label: "取消", value: false, autoFocus: true }, { label: "删除员工", value: true, kind: "danger" }] });
      if (answer.dismissed === true || !answer.action) return;
    }
    try { setMutationError(""); await siliconEmployeesRepository[action](selected.id); if (action === "remove") setSelectedId(current => current === selected.id ? null : current); reload(); }
    catch (cause) { setMutationError(cause instanceof Error ? cause.message : "员工操作失败，请重试。"); }
  };
  return <div className="wand-employee-workspace wand-employee-list" data-editing={editing}>
    {error && <Alert type="error" title="读取员工列表失败" description={error} action={<WandButton onClick={reload}>重新加载</WandButton>}/>}
    {mutationError && <Alert role="alert" type="error" title={mutationError}/>}
    {!editing ? <section ref={directoryRef} className="employee-directory" aria-label="员工目录">
      <div className="employee-directory-toolbar">
        <WandSearchField value={query} onValueChange={setQuery} label="搜索员工名字、标签、职责或 Prompt" placeholder="搜索员工"/>
        <Checkbox checked={showArchived} onChange={event => setShowArchived(event.target.checked)}>显示归档</Checkbox>
        <WandButton kind="primary" disabled={busy} onClick={() => void create()}><WandIcon name="plus" size={15}/>招聘员工</WandButton>
      </div>
      <div className="employee-items">
        {filtered.map(employee => <button type="button" className="employee-item" key={employee.id} data-directory-employee-id={employee.id} onClick={() => void select(employee)} title={employee.name}>
          <EmployeeAvatar employee={employee} provider="" size="md"/>
          <span><strong>{employee.name}{employee.archivedAt && <span className="employee-archived-label">已归档</span>}</strong><small>{employee.duty || siliconEmployeeTags(employee).join(" · ") || "尚未填写职责"}</small></span>
          {isBuiltinSiliconEmployee(employee) && <WandIcon name="lock" size={13}/>}
          <WandIcon name="chevron" size={16}/>
        </button>)}
        {!filtered.length && !loading && <div className="no-results" role="status"><p>{query ? "没有匹配的员工" : "还没有硅基员工"}</p><WandButton kind="ghost" onClick={() => query ? setQuery("") : void create()}>{query ? "清空搜索" : "招聘员工"}</WandButton></div>}
      </div>
      {loading && <span role="status"><Spin size="small"/>正在读取员工…</span>}
    </section> : isCreating ? <div className="employee-profile-content">
      <header className="profile-header"><div className="profile-heading"><WandIconButton aria-label="返回员工列表" disabled={busy} onClick={() => void back()}><WandIcon name="chevronLeft" size={18}/></WandIconButton><h2>招聘员工</h2></div></header>
      <EmployeeCreateForm catalog={catalog} providerOptions={providerOptions} onDirtyChange={setDirty} onSavingChange={setBusy} onSave={handleCreate} onCancel={() => { setIsCreating(false); setDirty(false); setBusy(false); }}/>
    </div> : selected && <EmployeeCard key={selected.id} employee={selected} catalog={catalog} providerOptions={providerOptions} editorOnly onDirtyChange={setDirty} onSavingChange={setBusy} onSave={handleSave} onBack={() => void back()} onArchive={() => mutation("archive")} onUnarchive={() => mutation("unarchive")} onDelete={() => mutation("remove")}/>}
  </div>;
}
