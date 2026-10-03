import * as React from "react";
import { WandButton, WandIcon } from "../ui";
import { CandidatesListEditor } from "./candidate-editor.js";
import { EmployeeAvatarPicker } from "./employee-avatar.js";
import type { IssueModelCatalog } from "../issues/task-board-agent.js";
import type { ProviderOptions } from "./candidate-editor.js";
import type { WandTaskAgent } from "../../../task-types.js";
import { candidateListError } from "./candidate-list.js";
import { createDefaultIssueAgent } from "../issues/task-board-agent.js";
import { siliconEmployeesRepository } from "./employee-repository.js";
import { EmployeeTagsField } from "./employee-tags-field.js";
import { parseSiliconEmployeeTagInput } from "../../../ai-team-types.js";

export function EmployeeCreateForm({
  catalog,
  providerOptions,
  onSave,
  onCancel,
}: {
  catalog: IssueModelCatalog | null;
  providerOptions: ProviderOptions;
  onSave(draft: {
    name: string;
    duty: string;
    prompt: string;
    avatar: string;
    tags: string[];
    agents: WandTaskAgent[];
  }): Promise<void>;
  onCancel(): void;
}): React.ReactElement {
  const [expectation, setExpectation] = React.useState("");
  const [advanced, setAdvanced] = React.useState(false);
  const [name, setName] = React.useState("");
  const [duty, setDuty] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  const [avatar, setAvatar] = React.useState("");
  const [tagInput, setTagInput] = React.useState("");
  const [agents, setAgents] = React.useState<WandTaskAgent[]>(() => [{ ...createDefaultIssueAgent(), kind: "structured" }]);
  const [saving, setSaving] = React.useState(false);
  const [filling, setFilling] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const failureMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

  /** 高级配置里手动填了名字就按手动配置落库，否则一律按期望让 AI 起草。 */
  const manualDraft = () => {
    if (!name.trim()) {
      setError("员工名字不能为空；也可以留空让 AI 按期望生成。");
      return null;
    }
    const listErr = agents.some((agent) => agent.kind !== "structured")
      ? "硅基员工只能使用结构化候选。"
      : candidateListError(agents);
    if (listErr) {
      setError(listErr);
      return null;
    }
    return { name, duty, prompt, avatar, agents };
  };

  const handleCreate = async () => {
    let tags: string[];
    try { tags = parseSiliconEmployeeTagInput(tagInput); }
    catch (cause) { setError(failureMessage(cause)); return; }
    if (advanced && name.trim()) {
      const draft = manualDraft();
      if (!draft) return;
      try {
        setSaving(true);
        setError(null);
        await onSave({ ...draft, tags });
      } catch (cause) {
        setError(failureMessage(cause));
      } finally {
        setSaving(false);
      }
      return;
    }

    if (!expectation.trim()) {
      setError("先说说你对这位员工的期望吧。");
      return;
    }
    try {
      setSaving(true);
      setError(null);
      const draft = await siliconEmployeesRepository.draft(expectation);
      await onSave({
        name: draft.name,
        duty: draft.duty,
        prompt: draft.prompt,
        avatar: "",
        tags,
        agents: [draft.agent],
      });
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  /** 高级配置里的「按期望生成」：只填充字段，不落库，留给用户改完再创建。 */
  const handleFillFromExpectation = async () => {
    if (!expectation.trim()) {
      setError("先在上面写下你的期望，再让 AI 起草。");
      return;
    }
    try {
      setFilling(true);
      setError(null);
      const draft = await siliconEmployeesRepository.draft(expectation);
      setName(draft.name);
      setDuty(draft.duty);
      setPrompt(draft.prompt);
      setAvatar("");
      setAgents([draft.agent]);
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setFilling(false);
    }
  };

  const manualMode = advanced && name.trim().length > 0;

  return (
    <div className="wand-team-member wand-employee-card is-new" data-open="true">
      <div className="wand-team-member-body">
        <div className="wand-team-member-inner">
          <div className="wand-settings-field">
            <label className="wand-settings-label" htmlFor="new-employee-expectation">
              想要什么样的员工
            </label>
            <textarea
              id="new-employee-expectation"
              className="wand-settings-input resize-none"
              rows={3}
              value={expectation}
              placeholder="说说你的期望：让它负责什么、需要什么专长、希望它怎么交付……"
              disabled={saving}
              autoFocus
              onChange={(e) => setExpectation(e.target.value)}
            />
            <p className="wand-employee-hint">
              {manualMode
                ? "将按下面填好的配置创建。"
                : "AI 会按你的期望配好名字、职责、角色设定和执行工具。"}
            </p>
          </div>

          <EmployeeTagsField id="new-employee-tags" value={tagInput}
            disabled={saving || filling} onChange={setTagInput} />

          <div className="wand-employee-advanced-toggle" data-open={advanced || undefined}>
            <WandButton
              kind="ghost"
              size="small"
              aria-expanded={advanced}
              disabled={saving}
              onClick={() => setAdvanced((value) => !value)}
            >
              <WandIcon name="sliders" size={14} slot="start" />
              高级配置
              <WandIcon name="chevronDown" size={14} slot="end" />
            </WandButton>
          </div>

          <section
            className="wand-employee-advanced"
            data-open={advanced || undefined}
            aria-hidden={!advanced}
            inert={!advanced}
          >
            <div className="wand-employee-advanced-inner">
              <div className="wand-settings-field">
                <label className="wand-settings-label" htmlFor="new-employee-name">
                  名字
                </label>
                <input
                  id="new-employee-name"
                  type="text"
                  className="wand-settings-input"
                  value={name}
                  placeholder="员工名字"
                  disabled={saving || filling}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <EmployeeAvatarPicker
                avatar={avatar}
                name={name}
                disabled={saving || filling}
                onChange={setAvatar}
              />

              <div className="wand-settings-field">
                <label className="wand-settings-label" htmlFor="new-employee-duty">
                  职责
                </label>
                <textarea
                  id="new-employee-duty"
                  className="wand-settings-input resize-none"
                  rows={2}
                  value={duty}
                  placeholder="一句话职责：在侧栏、选择器和署名中显示"
                  disabled={saving || filling}
                  onChange={(e) => setDuty(e.target.value)}
                />
              </div>

              <div className="wand-settings-field">
                <label className="wand-settings-label" htmlFor="new-employee-prompt">
                  角色设定 (Prompt)
                </label>
                <textarea
                  id="new-employee-prompt"
                  className="wand-settings-input resize-none"
                  rows={4}
                  value={prompt}
                  placeholder="设定角色的专业能力、行为守则与交付习惯（创建会话时作为系统提示生效）"
                  disabled={saving || filling}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>

              <CandidatesListEditor
                agents={agents}
                label={name || "新员工"}
                catalog={catalog}
                providerOptions={providerOptions}
                disabled={saving || filling}
                structuredOnly
                onChange={setAgents}
              />

              <div className="wand-employee-advanced-tools">
                <WandButton
                  kind="ghost"
                  size="small"
                  disabled={saving || filling}
                  onClick={() => void handleFillFromExpectation()}
                >
                  <WandIcon name="spark" size={14} slot="start" />
                  {filling ? "生成中…" : "按期望生成"}
                </WandButton>
              </div>
            </div>
          </section>

          <div className="wand-team-member-actions">
            <WandButton
              kind="primary"
              size="small"
              className="wand-employee-create-submit"
              aria-busy={saving || undefined}
              disabled={saving}
              onClick={() => void handleCreate()}
            >
              {saving ? "正在创建…" : "创建员工"}
            </WandButton>
            <WandButton
              kind="ghost"
              size="small"
              disabled={saving}
              onClick={onCancel}
            >
              取消
            </WandButton>
          </div>
          {error ? <div className="wand-team-candidate-error" role="alert">{error}</div> : null}
        </div>
      </div>
    </div>
  );
}
