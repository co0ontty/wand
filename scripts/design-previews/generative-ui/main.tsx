import * as React from "react";
import { createRoot } from "react-dom/client";
import { Flex, Input, Progress, Slider, Statistic, Tag } from "antd";
import { WandUiProvider } from "../../../src/web-ui/react/theme";
import { installReactUiStyles } from "../../../src/web-ui/react/styles";
import { WandButton, WandIconButton } from "../../../src/web-ui/react/ui/button";
import { WandSelect } from "../../../src/web-ui/react/ui/select";
import { WandIcon, type WandIconName } from "../../../src/web-ui/react/ui/icons";
import { WandBrandMark } from "../../../src/web-ui/react/ui/brand-mark";
import { ChatMessage } from "../../../src/web-ui/react/chat/message";
import { ShellTopbar } from "../../../src/web-ui/react/shell/shell-topbar";
import { MemoryUiAdapter, type UiSnapshotData } from "../../../src/web-ui/react/shell/ui-store";
import { UiStoreProvider } from "../../../src/web-ui/react/shell/ui-store-react";
import { PlushAvatar } from "../../../src/web-ui/react/avatars/plush-avatar";
import "./style.css";

// Visual-only fixture. No credentials, API calls, model execution or production data.
installReactUiStyles();
const selected = { id: "demo-cost", source: "wand", provider: "pi", engine: "sdk", kind: "structured", title: "AI 客服 · 上线成本试算", description: "", cwd: "/workspace/demo", status: "idle", statusLabel: "", active: false, selected: true, resumable: true, permissionBlocked: false, inFlight: false, turnActive: false, titleGenerating: false } as const;
const snapshot: UiSnapshotData = {
  auth: { phase: "authenticated" }, viewport: { mobile: innerWidth < 640, online: true, embedTerminal: false, nativeInput: false },
  capabilities: { backToNative: false, switchServer: false },
  layout: { sessionsDrawerOpen: false, sidebarPinned: true, sidebarCollapsed: false, sidebarDrawer: innerWidth < 640, sidebarAnchored: innerWidth >= 640, sessionsBackdropVisible: false, filePanelOpen: false, filePanelBackdropVisible: false, topbarMoreOpen: false, currentView: "chat" },
  selected, sidebar: { interactiveCount: 1, totalCount: 1, manageMode: false, selectedCount: 0, groups: [] },
  topbar: { title: selected.title, description: "", statusLabel: "", statusTone: "", cwd: selected.cwd, currentTask: "", titleGenerating: false, git: null },
  legacyVisibility: { terminal: false, chat: true, blank: false, composer: true },
};
const store = new MemoryUiAdapter(snapshot);
const face = (size: number) => <PlushAvatar config={{ version: 1, kind: "cat", coat: "silver" }} size={size}/>;
const nav: Array<[WandIconName, string]> = [["chat", "对话"], ["folder", "工作区"], ["board", "任务"], ["users", "团队"], ["user", "通讯录"]];

function FixtureSidebar() {
  return <aside className="demo-sidebar" aria-label="Wand 导航示意">
    <div className="demo-rail"><WandBrandMark style={{ width: 28, height: 28 }}/>
      <div className="demo-nav">{nav.map(([icon, label]) => <div key={icon} className={icon === "chat" ? "demo-nav-item selected" : "demo-nav-item"}><WandIcon name={icon}/><span>{label}</span></div>)}</div>
      <div className="demo-nav-item demo-settings"><WandIcon name="gear"/><span>设置</span></div>
    </div>
    <div className="demo-directory">
      <header><strong>对话</strong><WandIcon name="edit" size={18}/></header>
      <div className="demo-search"><WandIcon name="search" size={15}/><span>搜索对话</span><kbd>⌘ K</kbd></div>
      <div className="demo-directory-label">今天</div>
      <div className="demo-conversation active"><span>{face(40)}</span><div><strong>赛博虎妞</strong><p>AI 客服 · 上线成本试算</p></div><time>14:32</time></div>
      <div className="demo-conversation"><span className="demo-group"><WandIcon name="users"/></span><div><strong>产品迭代</strong><p>下个版本的需求与交付</p></div><time>昨天</time></div>
      <div className="demo-sidebar-bottom"><WandIcon name="lock" size={13}/><span>视觉 Demo · 全部为示例内容</span></div>
    </div>
  </aside>;
}

function Demo() {
  React.useEffect(() => {
    const resize = () => {
      const mobile = innerWidth < 700;
      store.setSnapshot({ ...snapshot, viewport: { ...snapshot.viewport, mobile }, layout: { ...snapshot.layout, sidebarDrawer: mobile, sidebarAnchored: !mobile } });
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const [users, setUsers] = React.useState(200);
  const [questions, setQuestions] = React.useState(15);
  const [cache, setCache] = React.useState(40);
  const [price, setPrice] = React.useState("0.04");
  const [saved, setSaved] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const dailyCalls = users * questions * (1 - cache / 100);
  const modelCost = dailyCalls * 30 * Number(price);
  const monthly = modelCost + 300;
  const remaining = 3000 - monthly;
  const changed = (fn: () => void) => { fn(); setSaved(false); };
  const reset = () => changed(() => { setUsers(200); setQuestions(15); setCache(40); setPrice("0.04"); });
  const money = (n: number) => n.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
  const fields = [
    { id: "users", label: "每日活跃用户", value: users, suffix: "人", min: 50, max: 1000, step: 50, set: setUsers, endpoints: ["50 人", "1,000 人"] },
    { id: "questions", label: "每人每天提问", value: questions, suffix: "次", min: 1, max: 30, step: 1, set: setQuestions, endpoints: ["1 次", "30 次"] },
    { id: "cache", label: "缓存命中率", value: cache, suffix: "%", min: 0, max: 80, step: 5, set: setCache, endpoints: ["不使用缓存", "80%"] },
  ];
  return <WandUiProvider><UiStoreProvider store={store}>
    <div className="demo-app"><FixtureSidebar/><main className="demo-main">
      <ShellTopbar/>
      <div className="demo-mode"><WandIcon name="eye" size={14}/><span>Generative UI 效果预览</span><span className="demo-mode-note">示例参数 · 未接入模型</span></div>
      <div className="demo-scroll"><div className="demo-transcript">
        <div className="demo-day">今天 14:32</div>
        <ChatMessage own content="帮我做个 AI 客服成本试算面板。我想调调用户量、提问次数，看看每月 3,000 元够不够。" styles={{ root: { width: "100%" } }}/>
        <div className="demo-author">{face(38)}<strong>赛博虎妞</strong><span>Wand Agent</span></div>
        <ChatMessage content={<>
          <p className="demo-reply">可以，直接在下面调整参数，预算会跟着变化。<br className="demo-mobile-break"/>不用每改一个数字就重新问我。</p>
          <section className="demo-surface" aria-label="AI 客服成本试算面板">
            <header className="demo-surface-heading"><div><h2>AI 客服成本试算</h2><p>先算清成本，再决定上线规模。</p></div><Tag bordered={false} icon={<WandIcon name="sliders" size={13}/>}>交互面板</Tag></header>
            <div className="demo-surface-body">
              <div className="demo-parameters">
                {fields.map(field => <div className="demo-field" key={field.id}>
                  <div className="demo-field-label"><span id={`${field.id}-label`}>{field.label}</span><output><b>{money(field.value)}</b><span>{field.suffix}</span></output></div>
                  <Slider id={field.id} ariaLabelForHandle={field.label} min={field.min} max={field.max} step={field.step} value={field.value} tooltip={{ open: false }} onChange={value => changed(() => field.set(value))}/>
                  <div className="demo-range"><span>{field.endpoints[0]}</span><span>{field.endpoints[1]}</span></div>
                </div>)}
                <div className="demo-price"><label>单次模型调用成本</label><WandSelect ariaLabel="单次模型调用成本" value={price} options={[{ value: "0.02", label: "¥0.02 / 次" }, { value: "0.04", label: "¥0.04 / 次" }, { value: "0.08", label: "¥0.08 / 次" }]} onValueChange={value => changed(() => setPrice(value))}/></div>
                <div className="demo-assumptions">按 30 天估算，固定服务费 ¥300 / 月。<br/>单价为演示假设，不代表任何供应商报价。</div>
              </div>
              <div className="demo-results">
                <Statistic title="预计每月总成本" prefix="¥" value={monthly} precision={0} className="demo-total"/>
                <div className="demo-budget"><span>月预算 ¥3,000</span><span className={remaining < 0 ? "demo-danger" : "demo-success"}>{remaining < 0 ? `超出 ¥${money(-remaining)}` : `余量 ¥${money(remaining)}`}</span></div>
                <Progress percent={Math.min(100, Math.round(monthly / 30))} showInfo={false} strokeColor={remaining < 0 ? "var(--danger)" : "var(--accent)"} size="small"/>
                <dl className="demo-breakdown"><div><dt>模型调用</dt><dd>¥{money(modelCost)}<small> / 月</small></dd></div><div><dt>固定服务费</dt><dd>¥300<small> / 月</small></dd></div><div><dt>实际模型请求</dt><dd>{money(dailyCalls)}<small> 次 / 天</small></dd></div></dl>
                <div className={remaining < 0 ? "demo-conclusion over" : "demo-conclusion"}><WandIcon name={remaining < 0 ? "warning" : "check"} size={16}/><p>{remaining < 0 ? "当前规模超出预算。" : "当前规模在预算内。"}<span>{remaining < 0 ? "可以提高缓存命中率，或调整调用单价。" : "试着增加用户量，看看预算的边界。"}</span></p></div>
              </div>
            </div>
            <footer className="demo-surface-footer"><div><WandIcon name="zap" size={14}/><span>本地即时计算，不调用模型</span></div><Flex gap={8}><WandButton className="demo-reset" onClick={reset}>重置</WandButton><WandButton kind="primary" className="demo-save" onClick={() => setSaved(true)}>{saved ? "已暂存演示参数" : "暂存演示参数"}</WandButton></Flex></footer>
          </section>
          <div className="demo-followup"><WandIcon name="edit" size={14}/><span>需要改变面板？继续告诉我，例如“加一个月预算输入项”。</span></div>
        </>}/>
      </div></div>
      <div className="demo-composer"><div className="demo-composer-inner">
        <div className="demo-partner">{face(62)}<span><b>赛博虎妞：</b>调整参数不消耗模型额度</span><WandIcon name="sparkle" size={18}/></div>
        <Input.TextArea aria-label="演示输入框" autoSize={{ minRows: 1, maxRows: 2 }} value={draft} onChange={event => setDraft(event.target.value)} placeholder="继续描述你想怎么调整这个面板…" variant="borderless"/>
        <div className="demo-composer-bottom"><Flex gap={8} align="center"><WandIconButton aria-label="附件（演示不可用）" disabled><WandIcon name="paperclip"/></WandIconButton><WandIconButton aria-label="语音（演示不可用）" disabled><WandIcon name="mic"/></WandIconButton><span>Wand Agent</span><WandIcon name="chevronDown" size={12}/></Flex><WandIconButton kind="primary" aria-label="发送（未接入模型）" disabled><WandIcon name="up"/></WandIconButton></div>
      </div></div>
    </main></div>
  </UiStoreProvider></WandUiProvider>;
}
createRoot(document.getElementById("root")!).render(<Demo/>);
