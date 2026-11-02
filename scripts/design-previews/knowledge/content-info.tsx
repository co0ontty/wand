import * as React from "react";
import { Collapse, Popover } from "antd";
import { WandButton } from "../../../src/web-ui/react/ui/button";
import { WandIcon } from "../../../src/web-ui/react/ui/icons";
import { usePopupDismiss } from "../../../src/web-ui/react/ui/popup-lifecycle";

export type ContentOrigin = "manual" | "conversation" | "builtin" | "ai-draft" | "automatic" | "unknown";
export const originLabels: Record<ContentOrigin, string> = {
  manual: "手动编写", conversation: "对话中保存", builtin: "系统内置", "ai-draft": "AI 起草 · 已确认", automatic: "自动生成", unknown: "来源未记录",
};
export const usageRules = [
  { name: "全局知识", timing: "结构化会话每轮加载全文。终端会话在启动或恢复时加载；已开的 CLI 是否刷新取决于其能力。", creation: "手动编写，或用户明确要求后由员工保存；不会自行从聊天里生成。" },
  { name: "项目知识", timing: "绑定此项目的结构化会话，每轮提供目录，正文按需读取。终端会话通过知识工具搜索、读取。", creation: "手动编写或明确要求保存。当前不会自动扫描仓库生成 Wiki。" },
  { name: "个人知识", timing: "绑定此员工的结构化会话，每轮提供目录，正文按需读取。终端会话通过知识工具搜索、读取。", creation: "手动编写或明确要求保存；按员工独立，不自动分享。" },
  { name: "员工角色", timing: "创建或显式切换员工执行时写入角色设定。已有会话可能保留之前的版本。", creation: "内置模板、手动编写或招聘时 AI 起草后确认；不是每天自动生成。" },
  { name: "近期使用偏好", timing: "记忆启用且内容未过期时，拼入默认员工的角色配置，供后续采用该配置的执行使用；不重写已有会话。", creation: "对近 30 天的有效使用记录进行归纳，通常每天一次，也可手动重新生成。" },
];
const how: Record<ContentOrigin, string> = {
  manual: "由用户在知识库中直接编辑和保存，不由系统自动生成。",
  conversation: "用户明确要求记住后，员工结合完整语义确定保存范围，再调用知识工具保存；不按关键词自动写入。",
  builtin: "安装时由内置模板初始化，后续保留用户的角色修改。模板不代表持续自动生成。",
  "ai-draft": "HR 根据岗位期望，通过其配置的执行候选起草职责与角色，用户确认后保存。重新生成仍需先审阅。",
  automatic: "从近 30 天有效提示与成功操作中选取近期记录，先过滤敏感内容，再由系统运维员工的候选模型归纳沟通、工作方式和近期关注。最多 10 条，每条引用输入证据；不以旧摘要继续推导新摘要。",
  unknown: "历史内容未保存来源记录，无法判断是手写还是 AI 起草；不会根据文字内容猜测来源，也不显示重新生成。",
};
export function ContentInfo({ origin, kind, owner }: { origin: ContentOrigin; kind: number; owner: string }) {
  const [open, setOpen] = React.useState(false);
  const button = React.useRef<HTMLButtonElement>(null);
  usePopupDismiss(open, () => { setOpen(false); button.current?.focus({ preventScroll: true }); });
  return <Popover trigger="click" placement="bottomRight" arrow={false} open={open} onOpenChange={setOpen} content={<section className="content-info" aria-label="内容使用说明">
    <h3>内容说明</h3><p className="info-subtitle">{owner} · {usageRules[kind].name}</p>
    <dl><dt>什么时候注入</dt><dd>{usageRules[kind].timing}</dd>
      <dt>是否自动生成</dt><dd>{originLabels[origin]}{origin === "automatic" ? " · 开启记忆后定期整理" : origin === "ai-draft" ? "，确认后保存，不定时重写" : origin === "unknown" ? "，待核对" : "，不定时生成"}</dd>
      <dt>{origin === "automatic" || origin === "ai-draft" ? "生成原理" : "内容从哪里来"}</dt><dd>{how[origin]}</dd>
      <dt>底部评论的作用</dt><dd>文档底部的评论与意见会在下次自动更新或重新生成时，作为明确的指令要求给到生成 Agent，Agent 会直接依据评论内容吸收并生成新版本。</dd>
      {origin === "automatic" && <><dt>更新与有效期</dt><dd>默认每日检查整理，至少需要 3 条有效记录。手动整理也受 1 分钟冷却限制。依据证据的 30 天期限失效，不保证从生成起再保留完整 30 天。</dd></>}
    </dl>
    <Collapse ghost items={[{ key: "all", label: "其他知识如何使用", children: <div className="all-knowledge-rules">{usageRules.map(rule => <section key={rule.name}><strong>{rule.name}</strong><p>{rule.timing}</p><p>{rule.creation}</p></section>)}<p>外部群执行仅接收全局约定，不包含个人与项目知识。项目知识按项目归属绑定；仓库里的 AGENTS.md 等规则仍由各 CLI 自己读取。</p></div> }]}/>
  </section>}><WandButton ref={button} size="small" kind="ghost" aria-label="内容说明" aria-expanded={open}><WandIcon name="info" size={14}/>说明</WandButton></Popover>;
}
