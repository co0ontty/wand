import * as React from "react";
import { createRoot } from "react-dom/client";
import { Input } from "antd";
import { WandUiProvider } from "@wand/src/web-ui/react/theme";
import { installReactUiStyles } from "@wand/src/web-ui/react/styles";
import { WandButton, WandIconButton } from "@wand/src/web-ui/react/ui/button";
import { WandIcon } from "@wand/src/web-ui/react/ui/icons";
import { WandInput } from "@wand/src/web-ui/react/ui/input";
import { WandSearchField } from "@wand/src/web-ui/react/ui/search-field";
import { WandSelect } from "@wand/src/web-ui/react/ui/select";
import { PlushAvatar } from "@wand/src/web-ui/react/avatars/plush-avatar";
import { PixelCat, shrinkAvatarImage } from "@wand/src/web-ui/react/ai-teams/avatar";
import { ProviderLogo } from "@wand/src/web-ui/react/provider-logo";
import { PLUSH_SHAPES, PLUSH_COLORS, PLUSH_GLASSES, PLUSH_HATS, defaultPlushAvatar, encodePlushAvatar, parsePlushAvatar, type PlushAvatarConfig, type PlushCatAvatarConfig } from "@wand/src/plush-avatar";
import { AGENT_TOOL_OPTIONS } from "@wand/src/web-ui/provider-identity";
import { setWandTheme, wandThemeStore } from "@wand/src/web-ui/react/theme-preference";
import { SILICON_EMPLOYEE_AVATAR_MAX_CHARS, AI_TEAM_MAX_CANDIDATES } from "@wand/src/ai-team-types";
import { useReducedMotion } from "@wand/src/web-ui/react/ui/motion-tokens";
import type { WandThemeId } from "@wand/src/web-ui/react/theme-palettes";
import "./style.css";

installReactUiStyles();
const initial = [
  { id: "preview-employee", name: "产品设计师", tag: "设计", duty: "把复杂的工作流程变成清楚、自然的产品体验。", prompt: "先理解任务目标与使用场景，再提出有依据的设计方案。关注信息层级、键盘操作和细节一致性；保留已有业务含义。", avatar: "plush:v1:capsule:cream:none:none", agents: [{ tool: "codex", model: "gpt-6.1-sol", effort: "high", mode: "full-access" }, { tool: "pi", model: "openai-codex/gpt-6.1-sol", effort: "off", mode: "managed" }] },
  { id: "e_wand_default", name: "赛博虎妞", tag: "默认伙伴", fixed: "silver", duty: "协助完成日常工作，承接任务并保持上下文连续。", prompt: "这是隔离预览中的角色文字，可编辑以验证完整资料流程。", avatar: "plush-cat:v1:silver", agents: [{ tool: "codex", model: "gpt-6.1-sol", effort: "high", mode: "full-access" }, { tool: "pi", model: "openai-codex/gpt-6.1-sol", effort: "off", mode: "managed" }] },
  { id: "e_wand_ops", name: "勤劳的初二", tag: "系统用户", fixed: "orange", duty: "维护工作台，检查运行环境并协助处理系统问题。", prompt: "这是隔离预览中的角色文字，可编辑以验证完整资料流程。", avatar: "plush-cat:v1:orange", agents: [{ tool: "opencode", model: "opencode/mimo-v2.6-flash-free", effort: "off", mode: "default" }, { tool: "pi", model: "openai-codex/gpt-6-luna", effort: "off", mode: "default" }] },
  { id: "preview-legacy", name: "保留像素猫的员工", tag: "已有头像", duty: "验证已有员工身份保持不变。", prompt: "已有头像只在明确修改时替换。", avatar: "cat:1", agents: [{ tool: "codex", model: "", effort: "off", mode: "default" }] },
] as const;
type Agent = { tool: string; model: string; effort: string; mode: string };
type Employee = { id: string; name: string; tag: string; fixed?: string; duty: string; prompt: string; avatar: string; agents: Agent[] };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const sections = [{ id: "identity", label: "个人资料", icon: "user" }, { id: "role", label: "职责与角色", icon: "clipboard" }, { id: "tools", label: "执行候选", icon: "cpu" }, { id: "appearance", label: "头像", icon: "image" }, { id: "advanced", label: "高级设置", icon: "gear" }] as const;

function Face({ employee, size = 32, speaking = false, interactive = false }: { employee: Employee; size?: number; speaking?: boolean; interactive?: boolean }) {
  const cat = /^plush-cat:v1:(silver|orange)$/.exec(employee.avatar);
  if (cat) return <PlushAvatar config={{ version: 1, kind: "cat", coat: cat[1] } as PlushCatAvatarConfig} size={size} interactive={interactive} speaking={speaking}/>;
  if (employee.avatar.startsWith("data:image/")) return <img className="photo" src={employee.avatar} alt="" width={size} height={size}/>;
  if (/^cat:\d+$/.test(employee.avatar)) return <span className="pixel" style={{ width: size, height: size }}><PixelCat coat={Number(employee.avatar.slice(4))}/></span>;
  return <PlushAvatar config={parsePlushAvatar(employee.avatar) ?? defaultPlushAvatar(employee)} size={size} interactive={interactive} speaking={speaking}/>;
}

function Field({ label, id, hint, children }: { label: string; id: string; hint?: string; children: React.ReactNode }) {
  return <div className="field"><label htmlFor={id}>{label}</label>{children}{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}
function App() {
  const reducedMotion = useReducedMotion();
  const [employees, setEmployees] = React.useState<Employee[]>(clone(initial) as unknown as Employee[]);
  const [selected, setSelected] = React.useState(initial[0].id as string);
  const [draft, setDraft] = React.useState<Employee>(clone(initial[0]) as unknown as Employee);
  const [query, setQuery] = React.useState("");
  const [step, setStep] = React.useState("identity");
  const [avatarOpen, setAvatarOpen] = React.useState(true);
  const [collapsed, setCollapsed] = React.useState(() => window.matchMedia("(max-width:600px)").matches);
  const themeId = React.useSyncExternalStore(wandThemeStore.subscribe, wandThemeStore.getSnapshot);
  const [notice, setNotice] = React.useState("");
  const [error, setError] = React.useState("");
  const [speech, setSpeech] = React.useState(false);
  const [renderState, setRenderState] = React.useState("loading");
  const [processing, setProcessing] = React.useState(false);
  const epoch = React.useRef(0);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const mainFace = React.useRef<HTMLDivElement>(null);
  const avatarTrigger = React.useRef<HTMLButtonElement>(null);
  const stored = employees.find(e => e.id === selected)!;
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);
  const plush = parsePlushAvatar(draft.avatar) ?? defaultPlushAvatar(draft);
  const visible = employees.filter(e => `${e.name} ${e.tag}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const patch = (value: Partial<Employee>) => { setDraft(old => ({ ...old, ...value })); setError(""); setNotice(""); };
  React.useEffect(() => {
    const node = mainFace.current; if (!node) return;
    const read = () => setRenderState(node.querySelector('[data-plush-avatar]')?.getAttribute("data-renderer") ?? "legacy");
    const observer = new MutationObserver(read); observer.observe(node, { attributes: true, subtree: true, childList: true }); read();
    return () => observer.disconnect();
  }, [draft.id, avatarOpen, step, draft.avatar]);
  React.useEffect(() => () => { ++epoch.current; }, []);
  React.useEffect(() => { const media = window.matchMedia("(max-width:600px)"); const changed = () => setCollapsed(media.matches); media.addEventListener("change", changed); return () => media.removeEventListener("change", changed); }, []);
  const cancel = () => { ++epoch.current; setProcessing(false); setDraft(clone(stored)); setSpeech(false); setError(""); setNotice("已撤销本次修改"); };
  const save = () => {
    if (!draft.name.trim()) { setStep("identity"); setError("请输入员工名字。"); requestAnimationFrame(() => document.getElementById("employee-name")?.focus()); return; }
    if (!draft.agents.length) { setStep("tools"); setError("至少保留一个执行候选。"); return; }
    const keys = draft.agents.map(a => `${a.tool}:${a.model}:${a.effort}:${a.mode}`);
    if (new Set(keys).size !== keys.length) { setStep("tools"); setError("执行候选重复，请调整工具或模型。"); return; }
    setEmployees(old => old.map(e => e.id === selected ? clone(draft) : e)); setError(""); setNotice("已保存到本地预览；实际员工配置未变更。");
  };
  const select = (e: Employee) => { ++epoch.current; setProcessing(false); setSelected(e.id); setDraft(clone(e)); setError(""); setNotice(dirty ? "已丢弃上一位员工的预览修改" : ""); setSpeech(false); if(window.matchMedia("(max-width:600px)").matches) setCollapsed(true); };
  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 10 * 1024 * 1024) { setError("请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片。"); return; }
    const generation = ++epoch.current; setProcessing(true); setError("");
    try { const avatar = await shrinkAvatarImage(file, SILICON_EMPLOYEE_AVATAR_MAX_CHARS); if (epoch.current === generation) patch({ avatar }); }
    catch (e) { if (epoch.current === generation) setError(e instanceof Error ? e.message : "图片处理失败，请重试。"); }
    finally { if (epoch.current === generation) setProcessing(false); }
  };
  const modifyAgent = (i: number, value: Partial<Agent>) => patch({ agents: draft.agents.map((a, at) => at === i ? { ...a, ...value } : a) });
  const move = (i: number, delta: number) => { const agents = [...draft.agents]; [agents[i], agents[i + delta]] = [agents[i + delta], agents[i]]; patch({ agents }); };
  const closeAvatar = () => { setAvatarOpen(false); setSpeech(false); if(window.matchMedia("(max-width:900px)").matches) setStep("identity"); requestAnimationFrame(() => avatarTrigger.current?.focus()); };
  const optionGroup = (field: "shape" | "glasses" | "hat", label: string, options: readonly { id: string; label: string }[]) => <fieldset className={`option-group ${field}`}><legend>{label}<span>{options.find(o => o.id === plush[field])?.label}</span></legend><div className="options">{options.map(o => <label className="option" key={o.id} data-selected={plush[field] === o.id}>
    <input type="radio" name={field} checked={plush[field] === o.id} aria-label={o.label} onChange={() => patch({ avatar: encodePlushAvatar({ ...plush, [field]: o.id } as PlushAvatarConfig) })}/>
    {field === "shape" ? <PlushAvatar config={{ ...plush, shape: o.id, glasses: "none", hat: "none" } as PlushAvatarConfig} size={42}/> : o.id === "none" ? <WandIcon name="circle" size={16}/> : <PlushAvatar config={{ ...plush, [field]: o.id } as PlushAvatarConfig} size={31}/>}
    <span>{o.label.replace("眼镜", "框").replace("无框", "无")}</span></label>)}</div></fieldset>;
  const appearance = <aside className="appearance" aria-label="头像工作区" onKeyDown={e => { if (e.key === "Escape" && avatarOpen) { e.stopPropagation(); closeAvatar(); } }}>
    <div className="aside-title"><span><WandIcon name="image" size={15}/>头像</span>{!draft.fixed && <WandIconButton aria-label="收起头像工作区" onClick={closeAvatar}><WandIcon name="close" size={15}/></WandIconButton>}</div>
    <div ref={mainFace} className="avatar-stage"><Face employee={draft} size={136} speaking={speech && renderState === "webgl"} interactive/><div className="preview-state" role="status"><i data-live={renderState === "webgl"}/>{renderState === "webgl" ? reducedMotion ? "3D 静态预览 · 已减少动效" : "3D 预览" : renderState === "fallback" ? "静态预览 · 当前浏览器 3D 不可用" : renderState === "loading" ? "正在加载 3D…" : draft.avatar.startsWith("cat:") ? "保留原有像素猫" : "图片预览"}</div>
      {renderState === "webgl" && <WandButton size="small" kind="ghost" aria-pressed={speech} disabled={reducedMotion} onClick={() => setSpeech(s => !s)}><WandIcon name="audio" size={14}/>{speech ? "停止动作预览" : "预览说话动作"}</WandButton>}
    </div>
    {draft.fixed ? <div className="fixed-avatar"><WandIcon name="lock" size={16}/><strong>系统固定头像</strong><p>{draft.fixed === "silver" ? "沿用华杰的银渐层猫形象" : "沿用石一的橘猫形象"}<br/>头像由系统固定，其他资料可编辑。</p></div> : <>
      <div className="avatar-modes"><WandButton size="small" kind="ghost" onClick={() => fileInput.current?.click()} disabled={processing}><WandIcon name="image" size={14}/>上传图片</WandButton><WandButton size="small" kind="ghost" onClick={() => patch({ avatar: "" })} disabled={!draft.avatar || processing}>恢复默认</WandButton></div>
      <small className="upload-note">PNG、JPEG、WebP · 最大 10 MB</small>
      <input hidden type="file" ref={fileInput} accept="image/png,image/jpeg,image/webp" aria-label="上传头像图片" onChange={upload}/>
      {draft.avatar.startsWith("data:image/") || draft.avatar.startsWith("cat:") ? <div className="preserved"><p>现有头像保持原样。</p><WandButton size="small" onClick={() => patch({ avatar: encodePlushAvatar(defaultPlushAvatar(draft)) })}>改用毛绒头像</WandButton></div> : <>
        {optionGroup("shape", "造型", PLUSH_SHAPES)}
        <fieldset className="option-group colors"><legend>颜色<span>{PLUSH_COLORS.find(c => c.id === plush.color)?.label}</span></legend><div className="options">{PLUSH_COLORS.map(o => <label className="color-option" key={o.id} data-selected={plush.color === o.id} title={o.label}><input type="radio" name="color" aria-label={o.label} checked={plush.color === o.id} onChange={() => patch({ avatar: encodePlushAvatar({ ...plush, color: o.id }) })}/><span style={{ background: o.color }}/></label>)}</div></fieldset>
        {optionGroup("glasses", "眼镜", PLUSH_GLASSES)}{optionGroup("hat", "帽子", PLUSH_HATS)}
      </>}
    </>}
    <div className="context-preview"><span>在工作台中的显示</span><div><Face employee={draft} size={28}/><span>{draft.name || "员工名字"}<small>导航与对话共用同一身份</small></span></div></div>
    <small className="aside-foot">头像与资料统一保存，取消可撤销修改。</small>
  </aside>;
  return <WandUiProvider><div className="preview-banner"><span>Wand · 员工资料设计预览</span><span>隔离环境 · 保存仅作用于本页</span><WandSelect ariaLabel="预览主题" value={themeId} options={[{ value: "warm", label: "暖白" }, { value: "blue", label: "海蓝" }, { value: "forest", label: "森林" }, { value: "mauve", label: "雾紫" }, { value: "graphite", label: "石墨" }]} onValueChange={v => setWandTheme(v as WandThemeId)}/></div>
    <div className="workspace" data-collapsed={collapsed}>
      <nav className="rail" aria-label="工作台"><div className="wand-mark" aria-label="Wand">w</div><WandIconButton aria-label="员工目录" aria-current="page" onClick={() => setCollapsed(c => !c)}><WandIcon name="users" size={20}/></WandIconButton><span className="rail-line"/><WandIconButton aria-label={collapsed ? "展开员工侧栏" : "折叠员工侧栏"} onClick={() => setCollapsed(c => !c)}><WandIcon name="rail" size={18}/></WandIconButton><span className="rail-bottom">W</span></nav>
      {!collapsed && <button className="directory-backdrop" aria-label="关闭员工目录" onClick={() => setCollapsed(true)}/>}<aside className="directory" aria-label="员工目录" onKeyDown={e => { if(e.key === "Escape") { e.stopPropagation();setCollapsed(true); } }}><header><h1>员工</h1><span>{employees.length}</span><WandIconButton aria-label="折叠员工侧栏" onClick={() => setCollapsed(true)}><WandIcon name="rail" size={16}/></WandIconButton></header><WandSearchField value={query} onValueChange={setQuery} label="搜索员工" placeholder="搜索名字或标签"/>
        <div className="directory-label">全部员工</div><div className="employee-items">{visible.map(e => <button className="employee-item" key={e.id} aria-current={selected === e.id ? "page" : undefined} onClick={() => select(e)} title={e.name}><Face employee={e} size={32}/><span><strong>{e.name}</strong><small>{e.tag}</small></span>{e.fixed && <WandIcon name="lock" size={12}/>}</button>)}{!visible.length && <div className="no-results" role="status"><WandIcon name="search" size={22}/><p>没有匹配的员工</p><WandButton size="small" kind="ghost" onClick={() => setQuery("")}>清空搜索</WandButton></div>}</div><footer>此预览不连接实际工作或模型。</footer>
      </aside>
      <main className="profile"><header className="profile-header"><div><span className="crumb">员工 <WandIcon name="chevron" size={12}/> 个人资料</span><h2>{draft.name || "未命名员工"}</h2></div><div className="save-actions"><span className="dirty">{processing ? "正在处理图片…" : dirty ? "有未保存修改" : "已保存"}</span><WandButton kind="ghost" onClick={cancel} disabled={processing}>取消</WandButton><WandButton kind="primary" onClick={save} disabled={!dirty || processing}>保存修改</WandButton></div></header>
        <nav className="profile-tabs" aria-label="资料分区">{sections.map(s => <button key={s.id} data-step={s.id} aria-current={step === s.id ? "page" : undefined} onClick={() => { setStep(s.id); if (s.id === "appearance") setAvatarOpen(true); }}><WandIcon name={s.icon} size={14}/>{s.label}</button>)}</nav>
        {(notice || error) && <div className={`feedback ${error ? "error" : ""}`} role={error ? "alert" : "status"}>{error || notice}</div>}
        <div className="profile-body" data-avatar-open={avatarOpen}>
          <div className="editor" data-step={step}><div className="identity-summary"><Face employee={draft} size={44}/><div><strong>{draft.name || "未命名员工"}</strong><small>{draft.tag}</small></div><WandButton ref={avatarTrigger} kind="ghost" size="small" onClick={() => { setAvatarOpen(true); setStep("appearance"); }}><WandIcon name={draft.fixed ? "lock" : "edit"} size={13}/>{draft.fixed ? "查看头像" : "编辑头像"}</WandButton></div>
            <section id="identity" className="form-section"><div className="section-heading"><h3>个人资料</h3><span>在工作台中识别这位员工</span></div><div className="identity-fields"><Field label="员工名字" id="employee-name"><WandInput id="employee-name" value={draft.name} maxLength={40} aria-invalid={Boolean(error && !draft.name.trim())} onChange={e => patch({ name: e.target.value })}/></Field><Field label="标签" id="employee-tag"><WandInput id="employee-tag" value={draft.tag} disabled={Boolean(draft.fixed)} onChange={e => patch({ tag: e.target.value })}/></Field></div></section>
            <section id="role" className="form-section"><div className="section-heading"><h3>职责与角色</h3><span>定义工作范围与协作方式</span></div><Field label="一句话职责" id="employee-duty"><Input.TextArea id="employee-duty" value={draft.duty} rows={2} maxLength={120} onChange={e => patch({ duty: e.target.value })}/></Field><Field label="角色设定" id="employee-prompt" hint="保存的设定会用于之后的新工作；此处仅为交互预览。"><Input.TextArea id="employee-prompt" value={draft.prompt} rows={4} onChange={e => patch({ prompt: e.target.value })}/></Field></section>
            <section id="tools" className="form-section"><div className="section-heading"><h3>执行候选 <span className="count">{draft.agents.length}</span></h3><WandButton size="small" kind="ghost" disabled={draft.agents.length >= AI_TEAM_MAX_CANDIDATES} onClick={() => patch({ agents: [...draft.agents, { tool: "codex", model: "", effort: "off", mode: "default" }] })}><WandIcon name="plus" size={13}/>添加候选</WandButton></div><p className="section-hint">按以下顺序尝试；工具与模型保留各自配置。</p>
              <div className="candidate-list">{draft.agents.map((a, i) => <div className="candidate" key={i}><div className="candidate-title"><span className="order">{String(i + 1).padStart(2, "0")}</span><ProviderLogo provider={AGENT_TOOL_OPTIONS.find(o => o.id === a.tool)?.provider}/><span>{i === 0 ? "首选" : "后备"}</span><div className="candidate-actions"><WandIconButton aria-label={`上移候选 ${i + 1}`} disabled={i === 0} onClick={() => move(i, -1)}><WandIcon name="chevronUp" size={13}/></WandIconButton><WandIconButton aria-label={`下移候选 ${i + 1}`} disabled={i === draft.agents.length - 1} onClick={() => move(i, 1)}><WandIcon name="chevronDown" size={13}/></WandIconButton><WandIconButton aria-label={`移除候选 ${i + 1}`} disabled={draft.agents.length === 1} onClick={() => patch({ agents: draft.agents.filter((_, at) => at !== i) })}><WandIcon name="close" size={13}/></WandIconButton></div></div><div className="candidate-fields"><Field label="工具" id={`tool-${i}`}><WandSelect ariaLabel={`候选 ${i + 1} 工具`} value={a.tool} searchable searchPlaceholder="搜索执行工具" options={AGENT_TOOL_OPTIONS.map(o => ({ value: o.id, label: o.label }))} onValueChange={tool => modifyAgent(i, { tool, model: "", effort: "off", mode: "default" })}/></Field><Field label="模型" id={`model-${i}`}><WandInput id={`model-${i}`} value={a.model} placeholder="工具默认模型" onChange={e => modifyAgent(i, { model: e.target.value })}/></Field></div><details className="candidate-detail"><summary>思考深度与工作模式 <span>{a.effort === "off" ? "默认深度" : a.effort} · {a.mode}</span></summary><div className="candidate-fields"><Field label="思考深度" id={`effort-${i}`}><WandSelect ariaLabel={`候选 ${i + 1} 思考深度`} value={a.effort} options={[{ value: "off", label: "默认" }, { value: "high", label: "高" }]} onValueChange={effort => modifyAgent(i, { effort })}/></Field><Field label="工作模式" id={`mode-${i}`}><WandInput id={`mode-${i}`} value={a.mode} onChange={e => modifyAgent(i, { mode: e.target.value })}/></Field></div></details></div>)}</div>
            </section>
            <section id="advanced" className="form-section"><details className="advanced-details" open={step === "advanced"}><summary>高级设置<span>身份与知识</span></summary><div className="advanced-content"><Field label="员工 ID" id="employee-id"><WandInput id="employee-id" value={draft.id} readOnly/></Field><p>长期知识在实际产品中独立管理；此预览不读取或改写知识记录。</p></div></details></section>
          </div>{avatarOpen && appearance}
        </div>
      </main>
    </div>
  </WandUiProvider>;
}
createRoot(document.getElementById("root")!).render(<App/>);
