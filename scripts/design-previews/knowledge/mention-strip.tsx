import * as React from "react";
import { Popover } from "antd";
import { WandIcon } from "../../../src/web-ui/react/ui/icons";
import { ProviderLogo } from "../../../src/web-ui/react/provider-logo";
import { EmployeeAvatar } from "../../../src/web-ui/react/agents/employee-avatar";

export interface MentionTarget {
  employeeId: string;
  employeeName: string;
  avatar: string;
  provider: "claude" | "codex" | "opencode" | "pi" | "grok" | "qoder";
  model: string;
  thinkingEffort: "off" | "low" | "medium" | "high" | "max";
}

export const EMPLOYEES: Array<{
  id: string;
  name: string;
  avatar: string;
  defaultProvider: MentionTarget["provider"];
  defaultModel: string;
  defaultThinking: MentionTarget["thinkingEffort"];
}> = [
  { id: "e_wand_default", name: "赛博虎妞", avatar: "plush-cat:v1:silver", defaultProvider: "claude", defaultModel: "claude-3-7-sonnet", defaultThinking: "high" },
  { id: "e_wand_ops", name: "勤劳的初二", avatar: "plush-cat:v1:orange", defaultProvider: "opencode", defaultModel: "deepseek-chat", defaultThinking: "medium" },
  { id: "designer", name: "设计伙伴", avatar: "产", defaultProvider: "pi", defaultModel: "default", defaultThinking: "low" },
  { id: "e_wand_hr", name: "嘟嘟", avatar: "plush-dog:v1:shiba:red-scarf", defaultProvider: "claude", defaultModel: "claude-3-5-sonnet", defaultThinking: "off" },
];

export const PROVIDERS: Array<{ id: MentionTarget["provider"]; name: string }> = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex CLI" },
  { id: "opencode", name: "OpenCode CLI" },
  { id: "pi", name: "Pi agent" },
  { id: "grok", name: "Grok CLI" },
  { id: "qoder", name: "Qoder CLI" },
];

export const MODELS_FOR_PROVIDER: Record<MentionTarget["provider"], string[]> = {
  claude: ["claude-3-7-sonnet", "claude-3-5-sonnet", "claude-3-5-haiku", "default"],
  codex: ["gpt-4.5-preview", "gpt-4o", "o3-mini", "default"],
  opencode: ["deepseek-chat", "deepseek-reasoner", "claude-3-7-sonnet", "default"],
  pi: ["default", "anthropic/claude-3-7-sonnet", "openai/gpt-4o", "google/gemini-2.0-flash"],
  grok: ["grok-2", "grok-beta", "default"],
  qoder: ["qoder-coder", "default"],
};

export const THINKING_LEVELS: Array<{ value: MentionTarget["thinkingEffort"]; label: string; desc: string }> = [
  { value: "off", label: "关闭", desc: "不启用深度思考，响应最快" },
  { value: "low", label: "低", desc: "轻度思考，适合常规文本总结" },
  { value: "medium", label: "中", desc: "适中思考，适合常规结构推理" },
  { value: "high", label: "高", desc: "深入思考，适合复杂规则与代码" },
  { value: "max", label: "极致", desc: "最大推理深度，适合疑难边界" },
];

export function createDefaultMention(employeeId: string): MentionTarget {
  const emp = EMPLOYEES.find(e => e.id === employeeId) || EMPLOYEES[0];
  return {
    employeeId: emp.id,
    employeeName: emp.name,
    avatar: emp.avatar,
    provider: emp.defaultProvider,
    model: emp.defaultModel,
    thinkingEffort: emp.defaultThinking,
  };
}

/**
 * 在文本框内部直接呈现的内联胶囊（Inline Capsule Token）。
 * 作为文本输入流的一部分显示，包含头像/名字、CLI、模型、思考深度四部分，每部分均可修改。
 */
export function MentionCapsule({
  mention,
  onChange,
  onRemove,
}: {
  mention: MentionTarget;
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
              {EMPLOYEES.map(emp => (
                <button
                  key={emp.id}
                  className={`strip-option-item ${emp.id === mention.employeeId ? "selected" : ""}`}
                  onClick={() => {
                    onChange({
                      ...mention,
                      employeeId: emp.id,
                      employeeName: emp.name,
                      avatar: emp.avatar,
                      provider: emp.defaultProvider,
                      model: emp.defaultModel,
                      thinkingEffort: emp.defaultThinking,
                    });
                    setEmpOpen(false);
                  }}
                >
                  <EmployeeAvatar employee={emp} size="toolbar" renderMode="static"/>
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

      {/* 取消 / 移除胶囊按钮 */}
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
