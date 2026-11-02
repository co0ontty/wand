import * as React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Alert, Empty, Input, Popover, Tree, type TreeDataNode } from "antd";
import { WandUiProvider } from "../../../src/web-ui/react/theme";
import { installReactUiStyles } from "../../../src/web-ui/react/styles";
import { WandButton, WandIconButton } from "../../../src/web-ui/react/ui/button";
import { WandIcon, type WandIconName } from "../../../src/web-ui/react/ui/icons";
import { WandBrandMark } from "../../../src/web-ui/react/ui/brand-mark";
import { WandSearchField } from "../../../src/web-ui/react/ui/search-field";
import { WandSelect } from "../../../src/web-ui/react/ui/select";
import { WandStretchTabs } from "../../../src/web-ui/react/ui/stretch-tabs";
import { MarkdownPreview } from "../../../src/web-ui/react/file-preview/markdown";
import { usePopupDismiss } from "../../../src/web-ui/react/ui/popup-lifecycle";
import { ContentInfo, originLabels, type ContentOrigin } from "./content-info";
import { RegenerateControl } from "./regenerate";
import "./style.css";

type Document = { id: string; library: string; title: string; content: string; role?: boolean; origin?: ContentOrigin };
const libraries = [
  { id: "global", name: "全局知识", group: "全局", icon: "server" as WandIconName },
  { id: "wand", name: "Wand", group: "项目", icon: "folder" as WandIconName },
  { id: "design", name: "设计实验室", group: "项目", icon: "folder" as WandIconName },
  { id: "tiger", name: "赛博虎妞", group: "员工", icon: "user" as WandIconName },
  { id: "designer", name: "设计伙伴", group: "员工", icon: "user" as WandIconName },
];
const initialDocuments: Document[] = [
  { id: "global-collaboration", library: "global", origin: "manual", title: "沟通与协作", content: "## 沟通方式\n\n默认用中文沟通。先说明结论，再补充必要的背景与依据。\n\n需要做取舍时，说明选择会带来的影响；缺少必要信息时再提问。\n\n## 保留已有工作\n\n修改前先看清现有状态，保留用户已有的输入、工作与历史。\n\n## 如实交付\n\n完成后说明做了什么、验证了什么，以及还未验证的部分。只有实际保存或执行成功后，才确认结果。" },
  { id: "global-tools", library: "global", origin: "conversation", title: "工具使用偏好", content: "## 遵循用户的工具选择\n\n工具优先按用户明确指定的方式使用。不可用时说明原因，保留已有工作。\n\n## 操作范围\n\n长期约定用于指导协作，不额外增加数据删除、发布或凭据操作的授权。" },
  { id: "wand-ui", library: "wand", origin: "manual", title: "界面与交互约定", content: "设计与实现界面时，先理解现有使用流程。让用户能直接找到内容、完成操作，把注意力留给正在做的事。\n\n## 优先复用现有组件\n\n开始前先核对项目的组件库。现有组件能满足需求时直接复用；需要调整时，优先使用组件参数、主题与少量适配。\n\n按钮、输入框、选择器和文档阅读保持一致的视觉与交互，让每个页面都像同一个产品。\n\n## 展开与收起保持自然\n\n用正常的文档流安排内容。能在当前页面展开的详情，就在原位置展开，让后面的内容自然下移。\n\n- 触发按钮在展开前后保持位置与尺寸。\n- 收起沿展开的方向返回，保留用户的阅读位置。\n- 操作结果在原来的按钮位置反馈。\n\n## 各端保持一致\n\nMac 与 Web、Android 与 iOS 保持功能与交互语义一致。允许使用平台原生控件，但信息归属、操作含义和失败后的恢复方式需要一致。" },
  { id: "wand-architecture", library: "wand", origin: "conversation", title: "会话与执行边界", content: "## 职责划分\n\nServer 负责业务、存储与会话协调；终端执行的生命周期独立管理。服务更新时保留已有会话与历史。\n\n## 输入与草稿\n\n提交结果与发起提交时的会话绑定。迟到回执不能覆盖用户的新输入，结果不明确时避免重复提交。\n\n## 验证\n\n在实际运行环境中核对受影响的流程，不把局部检查通过当作所有功能都已验证。" },
  { id: "wand-delivery", library: "wand", origin: "unknown", title: "构建与验收入口", content: "## 按影响范围验证\n\n界面修改需要核对真实阅读与交互流程。类型检查与构建通过，不等于视觉与操作体验已验收。\n\n## 交付记录\n\n写清已完成的验证、可查看的产物与尚未验证的范围，保持结论可复核。" },
  { id: "design-reading", library: "design", origin: "manual", title: "移动端阅读规范", content: "## 小屏阅读\n\n保留清楚的标题、来源和返回入口。长文在当前阅读区域滚动，主要操作始终可达。\n\n## 目录与正文\n\n点选目录进入正文，返回时保留目录展开状态和滚动位置。" },
  { id: "tiger-role", library: "tiger", origin: "builtin", title: "角色设定", role: true, content: "你是用户的默认任务伙伴「赛博虎妞」，帮助用户完成日常任务。\n\n## 职责\n\n理解本轮目标与已有约定，协助用户完成日常协作、代码实现和问题排查。基于真实状态与验证结果交付，不编造事实。\n\n## 工作方式\n\n先看清现有实现，再采取小而准确的行动。优先复用项目已有组件与能力，保留用户正在进行的工作。\n\n需要持续处理的任务，沿着已经明确的目标继续推进。完成后说明做了什么、验证了什么，以及还未验证的部分。\n\n## 沟通习惯\n\n默认用中文简洁沟通，先结论后证据。重要取舍说明影响，缺少必要信息时再提问。\n\n## 协作边界\n\n保留已有输入、工作和历史。涉及删除、发布、权限或凭据的操作，遵守明确授权与项目约定。" },
  { id: "tiger-preferences", library: "tiger", origin: "automatic", title: "近期使用偏好", content: "## 沟通\n\n偏好中文沟通，结论放在前面。\n\n## 工作方式\n\n界面改动前，先看设计稿再进入具体实现。\n\n## 近期关注\n\n关注知识库的文档阅读与员工信息展示。" },
  { id: "tiger-design", library: "tiger", origin: "conversation", title: "先看设计，再实现", content: "涉及重要界面改动时，先查看现有实现并提供针对性的设计稿；确认方向后再进入正式实现。\n\n设计稿包含主要页面、关键交互与可查看的预览。" },
  { id: "tiger-proof", library: "tiger", origin: "manual", title: "完成前核对实际效果", content: "交付前按用户实际操作路径核对结果。\n\n对于尚未验证的设备或场景，保留清楚的说明。" },
  { id: "designer-role", library: "designer", origin: "ai-draft", title: "角色设定", role: true, content: "你是产品设计伙伴，帮助用户把想法整理为可评审的界面方案。\n\n## 工作方式\n\n先理解用户目标与现有使用流程，再给出结构、内容层级与关键状态。\n\n## 交付方式\n\n提供可点击的设计稿，说明主要交互及失败、空状态与窄屏布局。" },
];
function changeView(action: () => void) {
  if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) document.startViewTransition(() => flushSync(action));
  else action();
}
function App() {
  const [documents, setDocuments] = React.useState(initialDocuments);
  const [selectedId, setSelectedId] = React.useState("wand-ui");
  const [expanded, setExpanded] = React.useState<React.Key[]>(["group-global", "group-project", "library-wand", "group-employee", "library-tiger"]);
  const [query, setQuery] = React.useState("");
  const [draft, setDraft] = React.useState<Document | null>(null);
  const [pending, setPending] = React.useState<(() => void) | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [invalid, setInvalid] = React.useState(false);
  const [preview, setPreview] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createLibrary, setCreateLibrary] = React.useState("wand");
  const [mobileReading, setMobileReading] = React.useState(false);
  const scroll = React.useRef<HTMLDivElement>(null);
  const createTrigger = React.useRef<HTMLButtonElement>(null);
  const active = documents.find(doc => doc.id === selectedId)!;
  const shown = draft ?? active;
  const owner = libraries.find(item => item.id === shown.library)!;
  const automatic = shown.origin === "automatic";
  const regeneratable = automatic || shown.origin === "ai-draft";
  const origin = shown.origin ?? "unknown";
  const usageKind = automatic ? 4 : shown.role ? 3 : owner.group === "全局" ? 0 : owner.group === "项目" ? 1 : 2;
  const dirty = !!draft && (draft.id.startsWith("draft-") || draft.title !== active.title || draft.content !== active.content || draft.library !== active.library);
  const reset = () => { setDraft(null); setSaved(false); setInvalid(false); setPreview(false); };
  const guard = (action: () => void) => { setCreateOpen(false); if (dirty) setPending(() => action); else { reset(); changeView(action); } };
  const choose = (id: string) => guard(() => { setSelectedId(id); setMobileReading(true); scroll.current?.scrollTo({ top: 0 }); });
  usePopupDismiss(createOpen, () => { setCreateOpen(false); createTrigger.current?.focus({ preventScroll: true }); });
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (createOpen) { setCreateOpen(false); return; }
      if (pending) { setPending(null); return; }
      if (draft) { guard(() => setDraft(null)); return; }
      setMobileReading(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [createOpen, pending, draft, dirty]);
  const normalized = query.trim().toLocaleLowerCase();
  const matching = documents.filter(doc => [doc.title, doc.content, libraries.find(lib => lib.id === doc.library)!.name].join("\n").toLocaleLowerCase().includes(normalized));
  const documentNode = (doc: Document): TreeDataNode => ({ key: doc.id, title: <span data-document={doc.id}>{doc.title}</span>, icon: <WandIcon name="file" size={15}/>, isLeaf: true });
  const libraryNode = (id: string): TreeDataNode => { const library = libraries.find(item => item.id === id)!; return { key: `library-${id}`, title: library.name, selectable: false, icon: <WandIcon name={library.icon} size={15}/>, children: matching.filter(doc => doc.library === id).map(documentNode) }; };
  const tree: TreeDataNode[] = [
    { key: "group-global", title: "全局", selectable: false, icon: <WandIcon name="server" size={15}/>, children: matching.filter(doc => doc.library === "global").map(documentNode) },
    { key: "group-project", title: "项目", selectable: false, icon: <WandIcon name="folders" size={15}/>, children: ["wand", "design"].filter(id => !query || matching.some(doc => doc.library === id)).map(libraryNode) },
    { key: "group-employee", title: "员工", selectable: false, icon: <WandIcon name="users" size={15}/>, children: ["tiger", "designer"].filter(id => !query || matching.some(doc => doc.library === id)).map(libraryNode) },
  ].filter(item => !query || item.children.length);
  const allKeys = ["group-global", "group-project", "group-employee", ...libraries.map(item => `library-${item.id}`)];
  const newDocument = () => guard(() => {
    setCreateOpen(false); setMobileReading(true); setQuery("");
    setExpanded(allKeys); scroll.current?.scrollTo({ top: 0 });
    setDraft({ id: `draft-${documents.length}`, library: createLibrary, origin: "manual", title: "", content: "" });
  });
  const save = () => {
    if (!draft || saved) return;
    if (!draft.title.trim() || !draft.content.trim()) { setInvalid(true); return; }
    const entry = { ...draft, id: draft.id.replace("draft-", "preview-") };
    setDocuments(items => items.some(item => item.id === entry.id) ? items.map(item => item.id === entry.id ? entry : item) : [...items, entry]);
    setSelectedId(entry.id); setDraft(entry); setSaved(true); setInvalid(false);
  };
  const wordCount = shown.content.replace(/\s/g, "").length;
  return <main className="mockup-page">
    <div className="mockup-label"><span>Wand · 知识库</span><span>设计稿 V3 · 示例内容</span></div>
    <section className={`knowledge-app ${mobileReading ? "show-reading" : "show-directory"}`}>
      <nav className="app-rail" aria-label="应用导航"><WandBrandMark className="rail-brand"/>{([
        ["chat", "会话"], ["file", "知识库"], ["board", "任务"], ["users", "团队"], ["calendar", "定时"],
      ] as Array<[WandIconName, string]>).map(([icon, label]) => <button key={label} aria-label={label} aria-current={label === "知识库" ? "page" : undefined} disabled={label !== "知识库"} className={label === "知识库" ? "active" : ""} onClick={() => setMobileReading(false)}><WandIcon name={icon} size={19}/><span>{label}</span></button>)}<div className="rail-gap"/><span className="rail-settings"><WandIcon name="gear" size={18}/><small>设置</small></span></nav>
      <aside className="library-directory" aria-label="知识库目录">
        <header className="directory-heading"><h1>知识库</h1><Popover open={createOpen} onOpenChange={open => { setCreateOpen(open); if (open) setCreateLibrary(owner.id); }} trigger="click" placement="bottomLeft" arrow={false} content={<div className="create-menu"><h3>新建文档</h3><label>保存到</label><WandSelect ariaLabel="新文档保存位置" value={createLibrary} options={libraries.map(lib => ({ value: lib.id, label: lib.name, group: lib.group }))} onValueChange={setCreateLibrary}/><WandButton kind="primary" onClick={newDocument}>创建文档</WandButton><small>设计预览中的修改仅保留在本页</small></div>}><WandIconButton ref={createTrigger} aria-label="新建文档" title="新建文档"><WandIcon name="plus" size={18}/></WandIconButton></Popover></header>
        <div className="directory-search"><WandSearchField label="搜索知识库" placeholder="搜索知识库" value={query} onValueChange={value => { setQuery(value); setCreateOpen(false); }}/></div>
        <div className="directory-caption"><span>{query ? `${matching.length} 个结果` : "目录"}</span><WandIconButton aria-label={expanded.length ? "收起全部目录" : "展开全部目录"} title={expanded.length ? "收起全部目录" : "展开全部目录"} onClick={() => setExpanded(expanded.length ? [] : allKeys)}><WandIcon name="layers" size={14}/></WandIconButton></div>
        <div className="document-tree">{tree.length ? <Tree treeData={tree} showIcon blockNode selectedKeys={[selectedId]} expandedKeys={query ? allKeys : expanded} autoExpandParent={false} onExpand={keys => setExpanded(keys)} onSelect={(keys, info) => { if (info.node.isLeaf && keys[0]) choose(String(keys[0])); }} onClick={(_event, node) => { if (!node.isLeaf && !query) setExpanded(keys => keys.includes(node.key) ? keys.filter(key => key !== node.key) : [...keys, node.key]); }}/> : <div className="no-results"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有找到相关文档"/><WandButton kind="ghost" onClick={() => setQuery("")}>清空搜索</WandButton></div>}</div>
        <footer className="directory-footer"><WandIcon name="file" size={13}/><span>{documents.length - documents.filter(doc => doc.role || doc.origin === "automatic").length} 篇知识 · {documents.filter(doc => doc.role || doc.origin === "automatic").length} 份员工资料</span></footer>
      </aside>
      <section className="reader" aria-label="文档阅读区">
        <header className="document-toolbar"><div className="breadcrumbs"><WandButton className="directory-back" kind="ghost" aria-label="返回目录" onClick={() => guard(() => setMobileReading(false))}><WandIcon name="chevronLeft" size={16}/>目录</WandButton><span>{owner.group}</span><span className="slash">/</span><span>{owner.name}</span><span className="slash">/</span><span className="crumb-title">{shown.title || "未命名文档"}</span></div><div className="document-actions"><ContentInfo key={shown.id} origin={origin} kind={usageKind} owner={owner.name}/>{draft ? <><span className="save-status" role="status">{saved ? "预览内已保存" : dirty ? "未保存" : "编辑中"}</span><WandButton size="small" onClick={() => guard(() => setDraft(null))}>{saved ? "完成" : "取消"}</WandButton><WandButton kind="primary" size="small" className="save-button" onClick={save}>{saved ? <><WandIcon name="check" size={13}/>已保存</> : "保存"}</WandButton></> : !automatic ? <WandButton size="small" onClick={() => { setDraft({ ...active }); setSaved(false); setPreview(false); }}><WandIcon name="edit" size={14}/>{active.role ? "编辑员工资料" : "编辑"}</WandButton> : null}</div></header>
        {pending && <Alert className="draft-guard" type="warning" title="有未保存的修改" action={<div><WandButton size="small" onClick={() => setPending(null)}>继续编辑</WandButton><WandButton size="small" onClick={() => { const action = pending; reset(); setPending(null); changeView(action); }}>放弃并切换</WandButton></div>}/>}
        <div className="document-scroll" ref={scroll}><article className="document-paper" data-view={draft ? "edit" : automatic ? "automatic" : active.role ? "role" : "document"}>
          {invalid && <Alert type="error" title="请填写标题和正文。输入已保留。" className="validation-error"/>}
          {draft ? <><Input aria-label="文档标题" variant="borderless" className="document-title-input" placeholder="文档标题" value={draft.title} readOnly={draft.role} onChange={event => { setDraft({ ...draft, title: event.target.value }); setSaved(false); }}/><div className="editor-meta"><span>{draft.role ? `${owner.name} · 员工资料` : `${owner.name} · 知识文档`}</span><WandStretchTabs value={preview ? "preview" : "write"} ariaLabel="文档编辑方式" tabs={[{ value: "write", label: "编辑" }, { value: "preview", label: "预览" }]} onValueChange={value => setPreview(value === "preview")}/></div>{preview ? <MarkdownPreview content={draft.content || "正文将显示在这里。"} variant="inline" wrap/> : <Input.TextArea aria-label="文档正文" variant="borderless" className="document-body-input" placeholder="开始记录…" value={draft.content} autoSize={{ minRows: 16 }} onChange={event => { setDraft({ ...draft, content: event.target.value }); setSaved(false); }}/>}</> : <><h1>{active.title}</h1><div className="document-meta"><WandIcon name={owner.icon} size={13}/><span>{owner.name}</span><span>·</span><span>{automatic ? "近期偏好" : active.role ? "员工资料" : owner.group === "员工" ? "个人知识" : owner.group === "全局" ? "全局知识" : "项目知识"}</span><span>·</span><span className="origin-label">{originLabels[origin]}</span></div>{regeneratable && <RegenerateControl key={active.id} document={active} onApply={content => setDocuments(items => items.map(item => item.id === active.id ? { ...item, content } : item))}/>}<MarkdownPreview content={active.content} variant="inline" wrap/></>}
          <footer className="document-footnote">{automatic ? "仅在启用且未过期时拼入默认员工的角色配置；不会改写已有会话，也不会转存为长期知识。" : shown.role ? "来自员工资料的当前角色设定；已有会话可能保留创建时的版本。" : owner.group === "全局" ? "此文档作为全局约定自动加载。" : owner.group === "项目" ? "此项目的知识目录随绑定会话提供，正文按需读取。" : "此员工的个人知识目录随会话提供，正文按需读取。"}</footer>
        </article></div>
        <footer className="reader-footer"><span>{wordCount} 字</span><span>{automatic ? "自动整理的近期偏好" : shown.role ? "员工角色设定" : "知识文档"}</span></footer>
      </section>
    </section>
  </main>;
}
installReactUiStyles();
createRoot(document.getElementById("root")!).render(<WandUiProvider><App/></WandUiProvider>);
