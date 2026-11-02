import * as React from "react";
import { Popover } from "antd";
import { WandIcon } from "../ui/icons";
import { ProviderLogo } from "../provider-logo";
import { EmployeeAvatar } from "../agents/employee-avatar";

export interface MentionTarget {
  employeeId: string;
  employeeName: string;
  avatar: string;
  provider: string;
  model: string;
  thinkingEffort: string;
}

export const DEFAULT_EMPLOYEES_CONFIG: Array<{
  id: string;
  name: string;
  avatar: string;
  defaultProvider: string;
  defaultModel: string;
  defaultThinking: string;
}> = [
  { id: "e_wand_default", name: "赛博虎妞", avatar: "plush-cat:v1:silver", defaultProvider: "claude", defaultModel: "claude-3-7-sonnet", defaultThinking: "high" },
  { id: "e_wand_ops", name: "勤劳的初二", avatar: "plush-cat:v1:orange", defaultProvider: "opencode", defaultModel: "deepseek-chat", defaultThinking: "medium" },
  { id: "e_wand_hr", name: "嘟嘟", avatar: "plush-dog:v1:shiba:red-scarf", defaultProvider: "claude", defaultModel: "claude-3-5-sonnet", defaultThinking: "off" },
];

export const PROVIDERS = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex CLI" },
  { id: "opencode", name: "OpenCode CLI" },
  { id: "pi", name: "Pi agent" },
  { id: "grok", name: "Grok CLI" },
  { id: "qoder", name: "Qoder CLI" },
];

export const MODELS_FOR_PROVIDER: Record<string, string[]> = {
  claude: ["claude-3-7-sonnet", "claude-3-5-sonnet", "claude-3-5-haiku", "default"],
  codex: ["gpt-4.5-preview", "gpt-4o", "o3-mini", "default"],
  opencode: ["deepseek-chat", "deepseek-reasoner", "claude-3-7-sonnet", "default"],
  pi: ["default", "anthropic/claude-3-7-sonnet", "openai/gpt-4o", "google/gemini-2.0-flash"],
  grok: ["grok-2", "grok-beta", "default"],
  qoder: ["qoder-coder", "default"],
};

export const THINKING_LEVELS = [
  { value: "off", label: "关闭", desc: "不启用深度思考，响应最快" },
  { value: "low", label: "低", desc: "轻度思考，适合常规文本总结" },
  { value: "medium", label: "中", desc: "适中思考，适合常规结构推理" },
  { value: "high", label: "高", desc: "深入思考，适合复杂规则与代码" },
  { value: "max", label: "极致", desc: "最大推理深度，适合疑难边界" },
];

export function createDefaultMention(employeeId: string, employeeName = "员工", avatar = ""): MentionTarget {
  const emp = DEFAULT_EMPLOYEES_CONFIG.find(e => e.id === employeeId);
  return {
    employeeId,
    employeeName: emp?.name || employeeName,
    avatar: emp?.avatar || avatar,
    provider: emp?.defaultProvider || "claude",
    model: emp?.defaultModel || "default",
    thinkingEffort: emp?.defaultThinking || "medium",
  };
}

export function MentionCapsule({
  mention,
  employees = DEFAULT_EMPLOYEES_CONFIG,
  onChange,
  onRemove,
}: {
  mention: MentionTarget;
  employees?: Array<{ id: string; name: string; avatar?: string }>;
  onChange(next: MentionTarget): void;
  onRemove(): void;
}) {
  const [empOpen, setEmpOpen] = React.useState(false);
  const [cliOpen, setCliOpen] = React.useState(false);
  const [modelOpen, setModelOpen] = React.useState(false);
  const [thinkOpen, setThinkOpen] = React.useState(false);

  const availableModels = MODELS_FOR_PROVIDER[mention.provider] || ["default"];
  const thinkLabel = THINKING_LEVELS.find(t => t.value === mention.thinkingEffort)?.label || "中";
  const cliName = PROVIDERS.find(p => p.id === mention.provider)?.name || mention.provider;

  return (
    <span className="inline-mention-capsule" role="group" aria-label="指派执行胶囊">
      {/* 1. 头像与员工名称 */}
      <Popover
        open={empOpen}
        onOpenChange={setEmpOpen}
        trigger="click"
        arrow={false}
        placement="topLeft"
        content={
          <div className="strip-popover-menu">
            <div className="popover-title">切换员工</div>
            <div className="popover-options">
              {employees.map(emp => (
                <button
                  key={emp.id}
                  className={`strip-option-item ${emp.id === mention.employeeId ? "selected" : ""}`}
                  onClick={() => {
                    onChange(createDefaultMention(emp.id, emp.name, emp.avatar || ""));
                    setEmpOpen(false);
                  }}
                >
                  <EmployeeAvatar employee={{ id: emp.id, name: emp.name, avatar: emp.avatar }} size="toolbar" renderMode="static"/>
                  <span className="opt-name">{emp.name}</span>
                  {emp.id === mention.employeeId && <WandIcon name="check" size={13}/>}
                </button>
              ))}
            </div>
          </div>
        }
      >
        <button className="capsule-part employee-part" aria-label={`员工：${mention.employeeName}，点击修改`}>
          <EmployeeAvatar
            employee={{ id: mention.employeeId, name: mention.employeeName, avatar: mention.avatar }}
            size="toolbar"
            renderMode="static"
          />
          <span className="part-text">@{mention.employeeName}</span>
          <WandIcon name="chevronDown" size={10} className="part-caret"/>
        </button>
      </Popover>

      <span className="capsule-divider" aria-hidden="true"/>

      {/* 2. CLI 图标与名称 */}
      <Popover
        open={cliOpen}
        onOpenChange={setCliOpen}
        trigger="click"
        arrow={false}
        placement="topLeft"
        content={
          <div className="strip-popover-menu">
            <div className="popover-title">修改执行工具 (CLI)</div>
            <div className="popover-options">
              {PROVIDERS.map(p => (
                <button
                  key={p.id}
                  className={`strip-option-item ${p.id === mention.provider ? "selected" : ""}`}
                  onClick={() => {
                    const newProvider = p.id;
                    const nextModel = (MODELS_FOR_PROVIDER[newProvider] || ["default"])[0];
                    onChange({
                      ...mention,
                      provider: newProvider,
                      model: nextModel,
                    });
                    setCliOpen(false);
                  }}
                >
                  <ProviderLogo provider={p.id} className="capsule-cli-logo"/>
                  <span className="opt-name">{p.name}</span>
                  {p.id === mention.provider && <WandIcon name="check" size={13}/>}
                </button>
              ))}
            </div>
          </div>
        }
      >
        <button className="capsule-part cli-part" aria-label={`CLI：${cliName}，点击修改`}>
          <ProviderLogo provider={mention.provider} className="capsule-cli-logo"/>
          <span className="part-text">{cliName}</span>
          <WandIcon name="chevronDown" size={10} className="part-caret"/>
        </button>
      </Popover>

      <span className="capsule-divider" aria-hidden="true"/>

      {/* 3. 模型名称 */}
      <Popover
        open={modelOpen}
        onOpenChange={setModelOpen}
        trigger="click"
        arrow={false}
        placement="topLeft"
        content={
          <div className="strip-popover-menu">
            <div className="popover-title">修改执行模型</div>
            <div className="popover-options">
              {availableModels.map(m => (
                <button
                  key={m}
                  className={`strip-option-item ${m === mention.model ? "selected" : ""}`}
                  onClick={() => {
                    onChange({ ...mention, model: m });
                    setModelOpen(false);
                  }}
                >
                  <span className="opt-code">{m}</span>
                  {m === mention.model && <WandIcon name="check" size={13}/>}
                </button>
              ))}
            </div>
          </div>
        }
      >
        <button className="capsule-part model-part" aria-label={`模型：${mention.model}，点击修改`}>
          <WandIcon name="cpu" size={11}/>
          <span className="part-text model-code">{mention.model}</span>
          <WandIcon name="chevronDown" size={10} className="part-caret"/>
        </button>
      </Popover>

      <span className="capsule-divider" aria-hidden="true"/>

      {/* 4. 思考深度 */}
      <Popover
        open={thinkOpen}
        onOpenChange={setThinkOpen}
        trigger="click"
        arrow={false}
        placement="topLeft"
        content={
          <div className="strip-popover-menu">
            <div className="popover-title">设置思考深度</div>
            <div className="popover-options">
              {THINKING_LEVELS.map(t => (
                <button
                  key={t.value}
                  className={`strip-option-item ${t.value === mention.thinkingEffort ? "selected" : ""}`}
                  onClick={() => {
                    onChange({ ...mention, thinkingEffort: t.value });
                    setThinkOpen(false);
                  }}
                >
                  <div className="think-item-copy">
                    <span className="opt-name">思考：{t.label}</span>
                    <small className="opt-desc">{t.desc}</small>
                  </div>
                  {t.value === mention.thinkingEffort && <WandIcon name="check" size={13}/>}
                </button>
              ))}
            </div>
          </div>
        }
      >
        <button className="capsule-part think-part" aria-label={`思考深度：${thinkLabel}，点击修改`}>
          <WandIcon name="brain" size={11}/>
          <span className="part-text">思考:{thinkLabel}</span>
          <WandIcon name="chevronDown" size={10} className="part-caret"/>
        </button>
      </Popover>

      <button
        className="capsule-close-btn"
        title="移除 @ 胶囊"
        aria-label="移除 @ 胶囊"
        onClick={e => {
          e.stopPropagation();
          onRemove();
        }}
      >
        <WandIcon name="close" size={10}/>
      </button>
    </span>
  );
}

export const MentionStrip = MentionCapsule;
