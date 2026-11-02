import * as React from "react";
import { Collapse, Empty, Radio } from "antd";
import { WandButton } from "../../../src/web-ui/react/ui/button";
import { WandIcon } from "../../../src/web-ui/react/ui/icons";
import { MarkdownPreview } from "../../../src/web-ui/react/file-preview/markdown";
import type { ContentOrigin } from "./content-info";

export interface GeneratedDocument { id: string; content: string; origin?: ContentOrigin; }
const memoryResult = "## 沟通\n\n偏好中文沟通，先说明结果，再补充必要依据。\n\n## 工作方式\n\n界面改动先提供可查看的设计稿，确认布局与交互后再进入实现。\n\n## 近期关注\n\n希望在知识库直接阅读项目知识和员工描述，界面采用简洁的目录与正文结构。";
const roleResult = "你是产品设计伙伴，帮助用户把想法整理为可以评审的界面与交互。\n\n## 工作方式\n\n先阅读现有流程与组件，明确用户希望完成的任务。优先复用熟悉的文档与目录结构，减少额外的理解成本。\n\n## 交付标准\n\n提供可点击的设计稿与关键截图，并核对内容层级、空状态、失败反馈和窄屏阅读。\n\n## 协作方式\n\n先交付设计供用户确认，再进入正式实现。需要做取舍时说明具体影响。";

export function RegenerateControl({ document: entry, onApply }: { document: GeneratedDocument; onApply(content: string): void }) {
  const [open, setOpen] = React.useState(false);
  const [phase, setPhase] = React.useState<"idle" | "generating" | "review" | "empty" | "error" | "applied">("idle");
  const [scenario, setScenario] = React.useState("success");
  const [candidate, setCandidate] = React.useState("");
  const sequence = React.useRef(0);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const isMemory = entry.origin === "automatic";
  React.useEffect(() => () => { sequence.current++; }, []);
  React.useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && open) { event.preventDefault(); sequence.current++; setOpen(false); setPhase("idle"); trigger.current?.focus(); } };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open]);
  const generate = async () => {
    const generation = ++sequence.current;
    setPhase("generating");
    // Local fixture generation only. A real completion drives every visible phase; no timer or API call.
    const result = await Promise.resolve().then(() => ({ outcome: scenario, text: isMemory ? memoryResult : roleResult }));
    if (generation !== sequence.current) return;
    if (result.outcome === "failed") setPhase("error");
    else if (result.outcome === "empty") setPhase("empty");
    else { setCandidate(result.text); setPhase("review"); }
  };
  const close = () => { sequence.current++; setPhase("idle"); setOpen(false); };
  const title = phase === "generating" ? "生成中…" : phase === "review" ? "待确认" : phase === "applied" ? "已更新" : phase === "error" ? "生成失败" : phase === "empty" ? "暂无新内容" : "重新生成";
  return <section className="regenerate-section" aria-label="自动生成内容管理">
    <div className="generated-status"><span><WandIcon name="sparkle" size={13}/>{isMemory ? "根据近期记录自动整理" : "根据岗位期望由 AI 起草"}</span><WandButton ref={trigger} size="small" className="regenerate-trigger" aria-expanded={open} aria-label="重新生成内容" onClick={() => { if (open) close(); else { setOpen(true); setPhase("idle"); } }}><WandIcon name="refresh" size={13}/>{title}</WandButton></div>
    <Collapse ghost activeKey={open ? ["regenerate"] : []} items={[{ key: "regenerate", showArrow: false, label: null, children: <div className="regenerate-panel">
      <h3>{phase === "review" ? "核对新内容" : phase === "applied" ? "已使用新内容" : "重新生成"}</h3>
      {phase === "review" ? <><p>比较后决定是否替换，当前内容仍然保留。</p><div className="compare-grid"><section><h4>当前内容</h4><MarkdownPreview content={entry.content} variant="inline" wrap/></section><section><h4>新内容 · 待确认</h4><MarkdownPreview content={candidate} variant="inline" wrap/></section></div><div className="regenerate-actions"><span>{isMemory ? "只替换这份近期偏好，保留手写知识与基础角色。" : "只替换已核对的角色正文，保留知识文档及其他员工配置。"}</span><WandButton size="small" onClick={close}>保留原内容</WandButton><WandButton size="small" kind="primary" className="apply-generated" onClick={() => { onApply(candidate); setPhase("applied"); }}>使用新内容</WandButton></div></> : phase === "applied" ? <><p role="status">已更新本地预览。现有会话、手写知识和其他员工内容保持不变。</p><WandButton size="small" onClick={close}>收起</WandButton></> : <>
        <dl><dt>生成依据</dt><dd>{isMemory ? "近 30 天有效记录，过滤敏感内容后提取沟通、工作方式和近期关注。" : "该员工原始岗位期望，由 HR 已配置的执行候选重新起草角色。"}</dd><dt>生成范围</dt><dd>{isMemory ? "仅这份近期使用偏好，最多 10 条。" : "仅该员工角色，不更改名字、头像和执行候选。"}</dd><dt>更新方式</dt><dd>生成候选 → 核对差异 → 确认替换。</dd></dl>
        {phase === "error" && <p className="regenerate-error" role="alert">生成未成功，原内容已保留。可检查执行候选后重试。</p>}
        {phase === "empty" && <div className="regenerate-empty" role="status"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="有效记录不足或没有新内容，保留当前版本。"/></div>}
        <div className="preview-outcomes"><span>交互演示结果</span><Radio.Group value={scenario} onChange={event => setScenario(event.target.value)} options={[{ label: "生成成功", value: "success" }, { label: "无新内容", value: "empty" }, { label: "失败", value: "failed" }]}/></div>
        <div className="regenerate-actions"><small>此处使用示例结果；正式生成会使用已配置的 AI 候选，费用随候选模型。</small><WandButton size="small" onClick={close}>取消</WandButton><WandButton size="small" kind="primary" className="generate-submit" loading={phase === "generating"} onClick={() => void generate()}>{phase === "error" ? "重试生成" : phase === "generating" ? "生成中…" : "开始生成"}</WandButton></div>
      </>}
    </div> }]}/>
  </section>;
}
