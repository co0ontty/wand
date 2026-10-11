import * as React from "react";
import { Alert, Checkbox, Spin } from "antd";
import { siliconEmployeeTags, type SiliconEmployee } from "../../../ai-team-types.js";
import { isFixedAvatarEmployee } from "../../../fixed-employee-avatar.js";
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

export function EmployeeListPage({ catalog, providerOptions }: { catalog: IssueModelCatalog | null; providerOptions: ProviderOptions }): React.ReactElement {
  const { employees, loading, error, reload } = useSiliconEmployees({ includeArchived: true });
  const [query, setQuery] = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [collapsed, setCollapsed] = React.useState(() => window.matchMedia("(max-width:600px)").matches);
  const [dirty, setDirty] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [mutationError, setMutationError] = React.useState("");
  const directoryTrigger = React.useRef<HTMLButtonElement>(null);
  const filtered = React.useMemo(() => employees.filter(employee => (showArchived || !employee.archivedAt)
    && `${employee.name} ${employee.duty} ${employee.prompt} ${siliconEmployeeTags(employee).join(" ")}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [employees, query, showArchived]);
  const selected = employees.find(employee => employee.id === selectedId) ?? employees.find(employee => !employee.archivedAt) ?? null;
  React.useEffect(() => { installEmployeeProfileStyles(); }, []);
  const discard = async (): Promise<boolean> => {
    if (busy) return false;
    if (!dirty) return true;
    const answer = await wandOverlay.dialog({ title: "放弃尚未保存的修改？", description: "当前员工的修改还没有保存。", actions: [{ label: "继续编辑", value: false, autoFocus: true }, { label: "放弃修改", value: true, kind: "danger" }] });
    if (answer.dismissed === true) return false;
    return !!answer.action;
  };
  const select = async (employee: SiliconEmployee) => {
    if (!isCreating && employee.id === selected?.id) {
      if (window.matchMedia("(max-width:600px)").matches) setCollapsed(true);
      return;
    }
    if ((isCreating || employee.id !== selected?.id) && !await discard()) return;
    setSelectedId(employee.id); setIsCreating(false); setDirty(false);
    if (window.matchMedia("(max-width:600px)").matches) setCollapsed(true);
  };
  const create = async () => { if (isCreating || !await discard()) return; setIsCreating(true); setDirty(false); if (window.matchMedia("(max-width:600px)").matches) setCollapsed(true); };
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
  const closeDirectory = () => { setCollapsed(true); directoryTrigger.current?.focus(); };
  return <div className="wand-employee-workspace wand-employee-list" data-collapsed={collapsed}>
    <WandIconButton ref={directoryTrigger} className="directory-toggle" aria-label={collapsed ? "展开员工侧栏" : "折叠员工侧栏"} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}><WandIcon name="users" size={17}/></WandIconButton>
    {!collapsed && <button type="button" className="directory-backdrop" aria-label="关闭员工目录" onClick={closeDirectory}/>}
    <aside className="directory" aria-label="员工目录" inert={collapsed} onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); closeDirectory(); } }}>
      <header><h1>员工</h1><span>{employees.length}</span><WandIconButton aria-label="折叠员工侧栏" onClick={closeDirectory}><WandIcon name="rail" size={16}/></WandIconButton></header>
      <WandSearchField value={query} onValueChange={setQuery} label="搜索员工名字、标签、职责或 Prompt" placeholder="搜索名字或标签"/>
      <div className="directory-controls"><Checkbox checked={showArchived} onChange={event => setShowArchived(event.target.checked)}>显示归档</Checkbox><WandButton size="small" kind="ghost" disabled={busy || isCreating} onClick={() => void create()}><WandIcon name="plus" size={13}/>新建员工</WandButton></div>
      <div className="directory-label">{showArchived ? "全部员工" : "当前员工"}</div><div className="employee-items">
        {filtered.map(employee => <button type="button" className="employee-item" key={employee.id} data-directory-employee-id={employee.id} aria-current={!isCreating && selected?.id === employee.id ? "page" : undefined} onClick={() => void select(employee)} title={employee.name}><EmployeeAvatar employee={employee} provider="" size="md"/><span><strong>{employee.name}</strong><small>{employee.archivedAt ? "已归档" : siliconEmployeeTags(employee).join(" · ") || employee.duty || "硅基员工"}</small></span>{isFixedAvatarEmployee(employee) && <WandIcon name="lock" size={12}/>}</button>)}
        {!filtered.length && !loading && <div className="no-results" role="status"><WandIcon name="search" size={22}/><p>{query ? "没有匹配的员工" : "还没有硅基员工"}</p><WandButton kind="ghost" size="small" onClick={() => query ? setQuery("") : void create()}>{query ? "清空搜索" : "创建员工"}</WandButton></div>}
      </div>{loading && <span role="status"><Spin size="small"/>正在读取员工…</span>}
    </aside>
    <div className="employee-profile-content">{error && <Alert type="error" title="读取员工列表失败" description={error} action={<WandButton onClick={reload}>重新加载</WandButton>}/>} {mutationError && <Alert role="alert" type="error" title={mutationError}/>}
      {isCreating ? <EmployeeCreateForm catalog={catalog} providerOptions={providerOptions} onDirtyChange={setDirty} onSavingChange={setBusy} onSave={handleCreate} onCancel={() => { setIsCreating(false); setDirty(false); }}/>
        : selected ? <EmployeeCard key={selected.id} employee={selected} catalog={catalog} providerOptions={providerOptions} editorOnly onDirtyChange={setDirty} onSavingChange={setBusy} onSave={handleSave} onArchive={() => mutation("archive")} onUnarchive={() => mutation("unarchive")} onDelete={() => mutation("remove")}/>
        : !loading && <div className="no-results"><p>创建一位员工，配置它的角色和执行候选。</p><WandButton kind="primary" onClick={() => void create()}>新建员工</WandButton></div>}
    </div>
  </div>;
}
