import * as React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Alert, Collapse, Empty, Input, Tooltip } from "antd";
import { WandUiProvider } from "../../../src/web-ui/react/theme";
import { installReactUiStyles } from "../../../src/web-ui/react/styles";
import { WandButton, WandIconButton } from "../../../src/web-ui/react/ui/button";
import { WandIcon, type WandIconName } from "../../../src/web-ui/react/ui/icons";
import { WandBrandMark } from "../../../src/web-ui/react/ui/brand-mark";
import { WandSearchField } from "../../../src/web-ui/react/ui/search-field";
import { WandSelect } from "../../../src/web-ui/react/ui/select";
import { WandStretchTabs } from "../../../src/web-ui/react/ui/stretch-tabs";
import { MarkdownPreview } from "../../../src/web-ui/react/file-preview/markdown";
import { EmployeeAvatar } from "../../../src/web-ui/react/agents/employee-avatar";
import "./style.css";

type Scope = "overview" | "global" | "project" | "personal";
type Entry = { id: string; scope: Exclude<Scope, "overview">; owner: string; title: string; folder: string; body: string };
const projects = [{ value: "wand", label: "Wand", path: "~/Self/vibe_coding/wand" }, { value: "demo", label: "设计实验室", path: "~/Projects/design-lab" }];
const people = [
  { id: "e_wand_default", name: "赛博虎妞", systemKey: "wand-default", avatar: "plush-cat:v1:silver", duty: "默认任务伙伴 · 日常协作与代码实现", prompt: "你是用户的默认任务伙伴「赛博虎妞」，帮助用户完成日常任务。\n\n## 工作方式\n\n先理解本轮目标与已有约定，再采取小而准确的行动；基于真实状态与验证结果交付，不编造事实。\n\n需要修改代码时，先阅读现有实现，优先复用项目已有组件与能力。完成后说明做了什么、验证了什么，以及还未验证的部分。\n\n## 沟通习惯\n\n默认用中文简洁沟通，先结论后证据。重要取舍说明影响，缺少必要信息时再提问。\n\n## 协作边界\n\n保留已有输入、工作和历史。涉及删除、发布、权限或凭据的操作，遵守明确授权与项目约定。" },
  { id: "preview-designer", name: "设计伙伴", duty: "示例员工 · 产品设计与交互梳理", prompt: "你是产品设计伙伴，帮助用户把想法整理为可评审的界面方案。\n\n## 工作方式\n\n先理解用户目标与现有使用流程，再给出结构、内容层级与关键状态。\n\n## 交付方式\n\n提供可点击的设计稿，说明主要交互及失败、空状态与窄屏布局。" },
];
const initialEntries: Entry[] = [
  { id: "global-collaboration", scope: "global", owner: "global", title: "沟通与协作", folder: "通用约定", body: "## 沟通方式\n\n默认使用中文，先说明结论，再补充必要的依据。\n\n## 交付要求\n\n- 保留用户已有的工作和输入。\n- 只根据真实验证结果说明是否完成。\n- 对尚未确认的事实，说明不确定性与下一步。" },
  { id: "global-tools", scope: "global", owner: "global", title: "工具使用偏好", folder: "通用约定", body: "## 浏览器操作\n\n浏览器任务使用用户指定的工具。工具不可用时说明原因，保留已有工作。\n\n## 操作范围\n\n长期约定用于指导协作，不额外增加数据删除、发布或凭据操作的授权。" },
  { id: "project-ui", scope: "project", owner: "wand", title: "界面与交互约定", folder: "项目约定", body: "## 先复用，再微调\n\n开始设计前，先核对项目现有组件库。组件能够满足需求时直接复用；需要调整时，通过参数、主题或少量适配完成。\n\n## 让内容自然展开\n\n优先使用 Flex / Grid 和正常文档流，让展开的内容推动后续内容，避免依靠绝对定位和间距补丁解决重叠。\n\n- 触发按钮在展开前后保持位置与尺寸。\n- 详情在当前页面展开，收起时沿原方向返回。\n- 减少动态效果时，位移与缩放立即完成。\n\n## 保持多端一致\n\nMac 与 Web、Android 与 iOS 保持功能与交互语义一致，允许平台原生控件存在外观差异。" },
  { id: "project-architecture", scope: "project", owner: "wand", title: "会话与执行边界", folder: "架构参考", body: "## 服务与执行\n\nServer 负责业务、存储与会话协调；终端执行的生命周期独立管理。\n\n服务更新时保留已有会话与历史，并按现有恢复入口处理连接。\n\n## 输入与草稿\n\n提交结果与发起提交时的会话绑定。迟到回执不能覆盖用户的新输入，发送结果不明确时避免重复提交。" },
  { id: "project-delivery", scope: "project", owner: "wand", title: "构建与验收入口", folder: "交付规范", body: "## 按影响范围验证\n\n界面修改需要核对真实阅读与交互流程。类型检查与构建通过，不等于视觉与操作体验已验收。\n\n## 交付记录\n\n写清已完成的验证、可查看的产物与尚未验证的范围，保持结论可复核。" },
  { id: "project-mobile", scope: "project", owner: "demo", title: "移动端阅读规范", folder: "体验规范", body: "## 小屏阅读\n\n保留清楚的标题、来源和返回入口。长文在当前阅读区域滚动，主要操作始终可达。" },
  { id: "personal-review", scope: "personal", owner: "e_wand_default", title: "先看设计，再实现", folder: "协作偏好", body: "涉及重要界面改动时，先查看现有实现并提供针对性的设计稿；确认方向后再进入正式实现。\n\n设计稿应包含主要页面、关键交互与可查看的预览。" },
  { id: "personal-proof", scope: "personal", owner: "e_wand_default", title: "完成前核对实际效果", folder: "协作偏好", body: "交付前按用户实际操作路径核对结果。对于未验证的设备或场景，保留清楚的说明。" },
];
const nav: Array<{ id: Scope; title: string; icon: WandIconName }> = [
  { id: "overview", title: "提示词来源", icon: "layers" }, { id: "global", title: "全局约定", icon: "server" },
  { id: "project", title: "项目知识", icon: "folder" }, { id: "personal", title: "员工与知识", icon: "user" },
];
const ROLE_ID = "employee-role";
function transition(action: () => void) {
  if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.startViewTransition(() => flushSync(action));
  } else action();
}
function Chip({ kind = "reference", children }: { kind?: "auto" | "role" | "reference"; children: React.ReactNode }) {
  return <span className={`use-chip ${kind}`}><WandIcon name={kind === "auto" ? "check" : kind === "role" ? "user" : "file"} size={12}/>{children}</span>;
}
function App() {
  const [scope, setScope] = React.useState<Scope>("overview");
  const [project, setProject] = React.useState("wand");
  const [employeeId, setEmployeeId] = React.useState(people[0].id);
  const [entries, setEntries] = React.useState(initialEntries);
  const [selected, setSelected] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [mobileDocument, setMobileDocument] = React.useState(false);
  const [draft, setDraft] = React.useState<Entry | null>(null);
  const [saveState, setSaveState] = React.useState<"idle" | "saved" | "invalid">("idle");
  const [roleEdit, setRoleEdit] = React.useState(false);
  const [roleBodies, setRoleBodies] = React.useState(Object.fromEntries(people.map(person => [person.id, person.prompt])));
  const [roleDraft, setRoleDraft] = React.useState("");
  const [roleSaved, setRoleSaved] = React.useState(false);
  const [preview, setPreview] = React.useState(false);
  const [pending, setPending] = React.useState<(() => void) | null>(null);
  const reader = React.useRef<HTMLDivElement>(null);
  const employee = people.find(person => person.id === employeeId)!;
  const workspace = projects.find(item => item.value === project)!;
  const library = (value: Exclude<Scope, "overview">) => entries.filter(item => item.scope === value && item.owner === (value === "global" ? "global" : value === "project" ? project : employeeId));
  const documents = scope === "overview" ? [] : library(scope);
  const active = entries.find(item => item.id === selected);
  const isRole = selected === ROLE_ID;
  const changed = !!draft && (draft.id.startsWith("draft-") || draft.title !== active?.title || draft.body !== active?.body || draft.folder !== active?.folder);
  const dirty = changed || roleEdit && roleDraft !== roleBodies[employeeId];
  const resetEdit = () => { setDraft(null); setRoleEdit(false); setRoleSaved(false); setSaveState("idle"); setPreview(false); };
  const run = (action: () => void) => { if (dirty) setPending(() => action); else { resetEdit(); transition(action); } };
  const openScope = (value: Scope, id?: string) => run(() => {
    setScope(value); setQuery(""); setSelected(id ?? (value === "personal" ? ROLE_ID : value === "overview" ? "" : library(value)[0]?.id ?? ""));
    setMobileDocument(!!id); reader.current?.scrollTo({ top: 0 });
  });
  const openEntry = (id: string) => run(() => { setSelected(id); setMobileDocument(true); reader.current?.scrollTo({ top: 0 }); });
  const changeContext = (kind: "project" | "employee", value: string) => run(() => {
    if (kind === "project") { setProject(value); if (scope === "project") setSelected(entries.find(item => item.scope === scope && item.owner === value)?.id ?? ""); }
    else { setEmployeeId(value); if (scope === "personal") setSelected(ROLE_ID); }
    setQuery("");
  });
  const create = () => run(() => {
    const nextScope = scope === "overview" ? "project" : scope;
    setScope(nextScope); setSelected(""); setMobileDocument(true);
    setDraft({ id: `draft-${entries.length}`, title: "", body: "", folder: "未分类", scope: nextScope, owner: nextScope === "global" ? "global" : nextScope === "project" ? project : employeeId });
  });
  const save = () => {
    if (saveState === "saved" || !draft) return;
    if (!draft.title.trim() || !draft.body.trim()) { setSaveState("invalid"); return; }
    const entry = { ...draft, id: draft.id.replace("draft-", "preview-") };
    setEntries(items => items.some(item => item.id === entry.id) ? items.map(item => item.id === entry.id ? entry : item) : [...items, entry]);
    setSelected(entry.id); setDraft(entry); setSaveState("saved");
  };
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = documents.filter(item => `${item.title}\n${item.body}\n${item.folder}`.toLocaleLowerCase().includes(normalized));
  const roleMatches = scope === "personal" && `${employee.name}\n角色设定\n${roleBodies[employeeId]}`.toLocaleLowerCase().includes(normalized);
  const ownerLabel = scope === "global" ? "所有项目与员工" : scope === "project" ? workspace.label : employee.name;
  React.useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (pending) { setPending(null); return; }
      if (roleEdit) { run(() => setRoleEdit(false)); return; }
      if (draft) { run(() => setDraft(null)); return; }
      if (mobileDocument) setMobileDocument(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [pending, roleEdit, draft, mobileDocument, dirty]);
  const sources = [
    { id: "global" as Scope, title: "全局约定", icon: "server" as WandIconName, owner: "所有项目与员工共用", mode: "自动加载", kind: "auto" as const, description: "每轮提供完整正文，适用于所有对话。", docs: library("global") },
    { id: "project" as Scope, title: "项目知识", icon: "folder" as WandIconName, owner: workspace.label, mode: "正文按需读取", kind: "reference" as const, description: "绑定此项目时提供知识目录，需要时读取相关正文。", docs: library("project") },
    { id: "personal" as Scope, title: "员工角色设定", icon: "user" as WandIconName, owner: employee.name, mode: "角色来源", kind: "role" as const, description: "创建或切换员工执行时使用的角色设定。", docs: [] },
    { id: "personal" as Scope, title: "员工个人知识", icon: "lock" as WandIconName, owner: `仅属于${employee.name}`, mode: "正文按需读取", kind: "reference" as const, description: "随这位员工提供知识目录，不与其他员工共享。", docs: library("personal") },
  ];
  return <main className="design-workspace">
    <header className="design-heading"><div><span className="design-kicker">WAND / KNOWLEDGE</span><h1>知识库</h1><p>把角色、约定与知识，放回同一个阅读空间。</p></div><div className="design-stamp"><span>交互设计稿 · V1</span><small>示例内容 · 所有编辑仅在此预览内保留</small></div></header>
    <section className={`app-window ${scope === "overview" ? "overview-mode" : "library-mode"} ${mobileDocument ? "mobile-document" : "mobile-directory"}`}>
      <div className="window-bar"><div className="traffic" aria-hidden="true"><i/><i/><i/></div><span>Wand <span className="window-separator">/</span> 知识库</span><span className="window-caption">Web / macOS 布局方向</span></div>
      <div className="app-body">
        <nav className="app-rail" aria-label="应用导航"><WandBrandMark className="rail-logo"/>{([
          ["chat", "会话"], ["file", "知识库"], ["board", "任务"], ["users", "团队"], ["calendar", "定时"],
        ] as Array<[WandIconName, string]>).map(([icon, label]) => <Tooltip key={label} title={label === "知识库" ? "知识库" : "此设计稿仅展示知识库"}><button aria-label={label} aria-current={label === "知识库" ? "page" : undefined} aria-disabled={label !== "知识库"} className={label === "知识库" ? "active" : ""} onClick={() => { if (label === "知识库") openScope("overview"); }}><WandIcon name={icon} size={19}/><span>{label}</span></button></Tooltip>)}<div className="rail-spacer"/><span className="rail-settings" aria-label="设置示意"><WandIcon name="gear" size={18}/><small>设置</small></span></nav>
        <aside className="knowledge-nav" aria-label="知识库导航">
          <header className="nav-title"><h2>知识库</h2><WandIcon name="file" size={18}/></header>
          <div className="scope-navigation">{nav.map(item => <button key={item.id} data-scope={item.id} className={scope === item.id ? "selected" : ""} aria-current={scope === item.id ? "page" : undefined} onClick={() => openScope(item.id)}><WandIcon name={item.icon} size={16}/><span>{item.title}</span>{item.id !== "overview" && <small>{library(item.id).length}</small>}</button>)}</div>
          <div className="nav-context">
            <div className="nav-label">{scope === "overview" ? "浏览范围" : scope === "global" ? "适用范围" : "当前归属"}</div>
            {(scope === "overview" || scope === "project") && <div className="context-field"><label>项目</label><WandSelect ariaLabel="选择项目" value={project} onValueChange={value => changeContext("project", value)} options={projects} searchable searchPlaceholder="搜索项目" startSlot={<WandIcon name="folder" size={14}/>}/></div>}
            {(scope === "overview" || scope === "personal") && <div className="context-field"><label>员工</label><WandSelect ariaLabel="选择员工" value={employeeId} onValueChange={value => changeContext("employee", value)} options={people.map(person => ({ value: person.id, label: person.name }))} searchable searchPlaceholder="搜索员工" startSlot={<WandIcon name="user" size={14}/>}/></div>}
            {scope === "global" && <p className="global-scope"><WandIcon name="server" size={15}/>所有项目 · 所有员工</p>}
            {scope === "project" && <code className="repo-path">{workspace.path}</code>}
          </div>
          {scope === "overview" ? <div className="overview-nav-note"><WandIcon name="info" size={15}/><p>先查看来源，<br/>再点进每一份内容。</p></div> : <>
            <div className="directory-toolbar"><span className="nav-label">{scope === "personal" ? "角色与文档" : "文档目录"}</span><WandButton kind="ghost" size="small" onClick={create}><WandIcon name="plus" size={13}/>新建</WandButton></div>
            <div className="directory-search"><WandSearchField value={query} onValueChange={setQuery} label="搜索当前范围" placeholder="搜索标题或正文"/></div>
            <div className="entry-list">
              {roleMatches && <><div className="folder-label">员工资料</div><button className={`document-link role-link ${isRole ? "selected" : ""}`} onClick={() => openEntry(ROLE_ID)} data-entry={ROLE_ID}><WandIcon name="user" size={15}/><span>角色设定</span><small>来源</small></button></>}
              {[...new Set(filtered.map(entry => entry.folder))].map(folder => <React.Fragment key={folder}><div className="folder-label">{folder}</div>{filtered.filter(item => item.folder === folder).map(entry => <button key={entry.id} data-entry={entry.id} className={`document-link ${selected === entry.id ? "selected" : ""}`} onClick={() => openEntry(entry.id)} title={entry.title}><WandIcon name="file" size={14}/><span>{entry.title}</span></button>)}</React.Fragment>)}
              {!filtered.length && !roleMatches && <div className="directory-empty"><span>{query ? "没有匹配的内容" : "这里还没有知识文档"}</span><WandButton kind="ghost" size="small" onClick={query ? () => setQuery("") : create}>{query ? "清空搜索" : "新建第一篇"}</WandButton></div>}
            </div>
          </>}
          <footer className="nav-footer"><WandIcon name={scope === "personal" ? "lock" : "info"} size={14}/><span>{scope === "overview" ? "选择范围只影响浏览" : scope === "global" ? "全文自动加载 · 合计最多 24 KB" : scope === "project" ? "目录自动提供 · 正文按需读取" : "个人知识按员工独立保存"}</span></footer>
        </aside>
        <section className="reading-pane" aria-label="知识阅读区">
          <header className="reading-toolbar"><div className="location"><WandButton className="mobile-back" kind="ghost" aria-label="返回知识库目录" onClick={() => run(() => setMobileDocument(false))}><WandIcon name="chevronLeft"/>目录</WandButton><WandIcon name={nav.find(item => item.id === scope)!.icon} size={15}/><span>{nav.find(item => item.id === scope)!.title}</span>{scope !== "overview" && <><span className="crumb-divider">/</span><span className="owner-label">{ownerLabel}</span></>}</div><div className="reader-actions">{scope === "overview" ? <span className="view-hint">来源概览</span> : isRole ? <span className="view-hint">来自员工资料</span> : draft ? <><span className="draft-label">{saveState === "saved" ? "预览内已保存" : changed ? "未保存" : "编辑预览"}</span><WandButton size="small" onClick={() => run(() => setDraft(null))}>{saveState === "saved" ? "完成" : "取消"}</WandButton><WandButton size="small" kind="primary" className="save-action" onClick={save}>{saveState === "saved" ? <><WandIcon name="check" size={14}/>已保存</> : "保存"}</WandButton></> : active ? <WandButton size="small" onClick={() => { setDraft({ ...active }); setSaveState("idle"); }}><WandIcon name="edit" size={14}/>编辑</WandButton> : null}</div></header>
          {pending && <Alert className="unsaved-warning" type="warning" title="有未保存的修改" description="可以继续编辑，或放弃本次修改后切换。" action={<div className="warning-actions"><WandButton size="small" onClick={() => setPending(null)}>继续编辑</WandButton><WandButton size="small" onClick={() => { const action = pending; setPending(null); resetEdit(); transition(action); }}>放弃并切换</WandButton></div>}/>}
          <div className="reader-scroll" ref={reader}><div className="reading-content" data-view={scope === "overview" ? "overview" : isRole ? "role" : draft ? "editor" : "document"}>
            {scope === "overview" ? <div className="overview-content">
              <span className="eyebrow">工作依据，一处可见</span><h2>提示词来源</h2><p className="lead">查看项目与员工会用到的约定、角色和知识。</p>
              <div className="context-summary"><span><WandIcon name="folder" size={15}/>{workspace.label}</span><span className="context-plus">+</span><span><EmployeeAvatar employee={employee} size="toolbar" renderMode="static"/>{employee.name}</span><small>当前浏览组合</small></div>
              <div className="source-list">{sources.map((source, index) => <section className="source-row" key={source.title}>
                <div className="source-symbol">{index === 2 ? <EmployeeAvatar employee={employee} size="sm" renderMode="static"/> : <WandIcon name={source.icon} size={21}/>}</div>
                <div className="source-text"><div className="source-title"><h3>{source.title}</h3><Chip kind={source.kind}>{source.mode}</Chip></div><div className="source-owner">{source.owner}{index !== 2 && <span> · {source.docs.length} 篇文档</span>}</div><p>{source.description}</p>
                  {index === 2 ? <button className="role-excerpt" onClick={() => openScope("personal", ROLE_ID)}>{employee.duty}<WandIcon name="chevron" size={13}/></button> : <div className="source-links">{source.docs.length ? source.docs.slice(0, 3).map(item => <button key={item.id} onClick={() => openScope(source.id, item.id)}><WandIcon name="file" size={12}/>{item.title}</button>) : <span className="source-empty">尚未保存知识</span>}</div>}
                </div><WandIconButton className="source-open" aria-label={`查看${source.title}`} onClick={() => openScope(source.id, index === 2 ? ROLE_ID : source.docs[0]?.id)}><WandIcon name="chevron" size={18}/></WandIconButton>
              </section>)}</div>
              <div className="overview-footnote"><WandIcon name="info" size={15}/><p>这里展示所选组合的内容来源。已有会话可能保留创建时的角色设定。</p></div>
            </div> : isRole ? <div className="document-content role-content">
              <div className="document-eyebrow"><span className="eyebrow">员工资料</span><Chip kind="role">角色来源</Chip></div>
              <div className="role-heading"><EmployeeAvatar employee={employee} size="lg" renderMode="static"/><div><h2>{employee.name}</h2><p>{employee.duty}</p></div></div>
              <div className="role-source-note"><WandIcon name="user" size={17}/><div><strong>角色设定</strong><p>内容由员工资料维护，在知识库中统一阅读。</p></div><WandButton size="small" disabled={roleEdit} onClick={() => { setRoleDraft(roleBodies[employeeId]); setRoleEdit(true); setRoleSaved(false); }}>编辑角色</WandButton></div>
              <Collapse ghost activeKey={roleEdit ? ["edit"] : []} onChange={keys => { if (!keys.length) run(() => setRoleEdit(false)); }} items={[{ key: "edit", showArrow: false, label: roleEdit ? "编辑员工角色 · 仅此预览" : null, children: <div className="inline-role-editor"><Input.TextArea aria-label="员工角色正文" value={roleDraft} autoSize={{ minRows: 8, maxRows: 14 }} onChange={event => { setRoleDraft(event.target.value); setRoleSaved(false); }}/><div className="role-edit-actions"><small>修改源角色资料，知识库同步展示。</small><WandButton onClick={() => run(() => setRoleEdit(false))}>{roleSaved ? "收起" : "取消"}</WandButton><WandButton className="save-action" kind="primary" disabled={!roleDraft.trim()} onClick={() => { setRoleBodies(values => ({ ...values, [employeeId]: roleDraft })); setRoleSaved(true); }}>{roleSaved ? "已保存" : "保存角色"}</WandButton></div></div> }]}/>
              <MarkdownPreview content={roleBodies[employeeId]} variant="inline" wrap/>
              <footer className="document-source"><WandIcon name="info" size={14}/><span>当前员工配置。已创建会话是否更新，取决于会话的刷新方式。</span></footer>
              <div className="related-knowledge"><div><h3>这位员工的个人知识</h3><p>{library("personal").length} 篇独立保存的文档</p></div>{library("personal").length ? library("personal").map(item => <button key={item.id} onClick={() => openEntry(item.id)}><WandIcon name="file" size={14}/>{item.title}<WandIcon name="chevron" size={14}/></button>) : <p className="source-empty">还没有个人知识。角色设定仍可正常查看。</p>}</div>
            </div> : draft ? <div className="document-content editor-content">
              <div className="document-eyebrow"><span className="eyebrow">{ownerLabel} · {draft.id.startsWith("draft-") ? "新建文档" : "编辑文档"}</span><Chip kind={scope === "global" ? "auto" : "reference"}>{scope === "global" ? "自动加载" : "正文按需读取"}</Chip></div>
              {saveState === "invalid" && <Alert type="error" title="请填写文档标题和正文，输入已保留。"/>}
              <Input aria-label="文档标题" className="title-input" placeholder="文档标题" variant="borderless" value={draft.title} onChange={event => { setDraft({ ...draft, title: event.target.value }); setSaveState("idle"); }}/>
              <div className="editor-tools"><label>目录<Input aria-label="文档目录" value={draft.folder} onChange={event => { setDraft({ ...draft, folder: event.target.value }); setSaveState("idle"); }}/></label><WandStretchTabs ariaLabel="正文编辑方式" value={preview ? "preview" : "write"} tabs={[{ value: "write", label: "编辑" }, { value: "preview", label: "预览" }]} onValueChange={value => setPreview(value === "preview")}/></div>
              {preview ? <MarkdownPreview content={draft.body || "正文预览将显示在这里。"} variant="inline" wrap/> : <Input.TextArea aria-label="文档正文" value={draft.body} variant="borderless" placeholder="写下需要保存的约定与知识…" className="body-input" autoSize={{ minRows: 14 }} onChange={event => { setDraft({ ...draft, body: event.target.value }); setSaveState("idle"); }}/>}
            </div> : active ? <div className="document-content">
              <div className="document-eyebrow"><span className="eyebrow">{active.folder}</span><Chip kind={scope === "global" ? "auto" : "reference"}>{scope === "global" ? "自动加载" : "正文按需读取"}</Chip></div>
              <h2>{active.title}</h2><div className="document-meta"><span>{ownerLabel}</span><span>·</span><span>示例文档</span></div>
              <div className="use-note"><WandIcon name={scope === "global" ? "check" : "file"} size={16}/><span>{scope === "global" ? "全文作为全局约定提供，适用于所有项目与员工。" : scope === "project" ? "绑定此项目时自动提供文档目录，正文在需要时读取。" : "仅随这位员工提供知识目录，正文在需要时读取。"}</span></div>
              <MarkdownPreview content={active.body} variant="inline" wrap/>
              <footer className="document-source"><WandIcon name={scope === "personal" ? "lock" : "folder"} size={14}/><span>{scope === "global" ? "来自全局知识库" : scope === "project" ? `来自 ${workspace.label} 的项目知识库` : `来自 ${employee.name} 的个人知识库`}</span><WandButton kind="ghost" size="small" onClick={() => openScope("overview")}>查看提示词来源<WandIcon name="chevron" size={12}/></WandButton></footer>
            </div> : <div className="reader-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="从目录中选择一份内容"/><WandButton onClick={create}>新建文档</WandButton></div>}
          </div></div>
        </section>
      </div>
    </section>
    <footer className="design-notes"><div><span>01</span><p><strong>来源先讲清</strong>区分自动加载、角色设定和按需读取。</p></div><div><span>02</span><p><strong>阅读在原位</strong>目录一直可达，长文独立滚动。</p></div><div><span>03</span><p><strong>内容有归属</strong>角色回到员工资料，知识保留各自范围。</p></div></footer>
  </main>;
}
installReactUiStyles();
createRoot(document.getElementById("root")!).render(<WandUiProvider><App/></WandUiProvider>);
