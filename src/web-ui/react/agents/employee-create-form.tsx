import * as React from "react";
import { Alert, Flex, Collapse, Input, Typography } from "antd";
import { WandButton, WandIcon } from "../ui";
import { CandidatesListEditor } from "./candidate-editor.js";
import { EmployeeAvatar } from "./employee-avatar.js";
import { EmployeeAvatarWorkspace } from "./employee-avatar-workspace.js";
import type { IssueModelCatalog } from "../issues/task-board-agent.js";
import type { ProviderOptions } from "./candidate-editor.js";
import type { WandTaskAgent } from "../../../task-types.js";
import { candidateListError } from "./candidate-list.js";
import { createDefaultIssueAgent } from "../issues/task-board-agent.js";
import { siliconEmployeesRepository } from "./employee-repository.js";
import { EmployeeTagsField } from "./employee-tags-field.js";
import { SettingsActionButton, SettingsField } from "../settings/fields.js";
import { parseSiliconEmployeeTagInput } from "../../../ai-team-types.js";
import { HR_EMPLOYEE_ID, HR_EMPLOYEE_KEY, HR_EMPLOYEE_NAME, HR_EMPLOYEE_AVATAR } from "../../../hr-employee-identity.js";

export function EmployeeCreateForm({
  catalog,
  providerOptions,
  onSave,
  onCancel,
  onDirtyChange,
  onSavingChange,
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
  onDirtyChange?(dirty: boolean): void;
  onSavingChange?(saving: boolean): void;
}): React.ReactElement {
  const [expectation, setExpectation] = React.useState("");
  const [advanced, setAdvanced] = React.useState(false);
  const [name, setName] = React.useState("");
  const [duty, setDuty] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  const [avatar, setAvatar] = React.useState("");
  const [avatarOpen, setAvatarOpen] = React.useState(false);
  const [avatarBusy, setAvatarBusy] = React.useState(false);
  const [tagInput, setTagInput] = React.useState("");
  const [agents, setAgents] = React.useState<WandTaskAgent[]>(() => [{ ...createDefaultIssueAgent(), kind: "structured" }]);
  const [saving, setSaving] = React.useState(false);
  const [filling, setFilling] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const alive = React.useRef(true);
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const initialAgents = React.useRef(JSON.stringify(agents));
  const dirty = Boolean(expectation || name || duty || prompt || avatar || tagInput) || JSON.stringify(agents) !== initialAgents.current;
  React.useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  React.useEffect(() => { onSavingChange?.(saving || filling || avatarBusy); }, [saving, filling, avatarBusy, onSavingChange]);

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
    if (saving || filling || avatarBusy) return;
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
      setFilling(true);
      setError(null);
      const draft = await siliconEmployeesRepository.draft(expectation);
      if (!alive.current) return;
      setName(draft.name);
      setDuty(draft.duty);
      setPrompt(draft.prompt);
      setAgents(draft.candidates?.length ? draft.candidates : [draft.agent]);
      setAdvanced(true);
      return true;
    } catch (cause) {
      if (alive.current) setError(failureMessage(cause));
      return false;
    } finally {
      if (alive.current) setFilling(false);
    }
  };

  /** 重新拟定只更新人选资料，保留已选头像，不办理入职。 */
  const handleFillFromExpectation = async () => {
    if (!expectation.trim()) {
      setError("先在上面写下岗位需求，再请嘟嘟拟定人选。");
      return false;
    }
    try {
      setFilling(true);
      setError(null);
      const draft = await siliconEmployeesRepository.draft(expectation);
      if (!alive.current) return false;
      setName(draft.name);
      setDuty(draft.duty);
      setPrompt(draft.prompt);
      setAgents(draft.candidates?.length ? draft.candidates : [draft.agent]);
      return true;
    } catch (cause) {
      if (alive.current) setError(failureMessage(cause));
      return false;
    } finally {
      if (alive.current) setFilling(false);
    }
  };

  const manualMode = advanced && name.trim().length > 0;

  return (
    <section className="wand-team-member wand-employee-card is-new" data-open="true" aria-label="招聘员工">
      <div className="wand-team-member-body">
        <Flex vertical gap={10} style={{ minWidth: 0, paddingTop: 10 }} className="wand-team-member-inner">
          <Flex align="center" gap={12} className="wand-recruiter-summary">
            <EmployeeAvatar employee={{ id: HR_EMPLOYEE_ID, systemKey: HR_EMPLOYEE_KEY, name: HR_EMPLOYEE_NAME, avatar: HR_EMPLOYEE_AVATAR }} provider="" size="lg"/>
            <Flex vertical gap={2}>
              <Typography.Text strong>嘟嘟 · 招聘 HR</Typography.Text>
              <Typography.Text type="secondary">告诉我岗位需求，我来拟定人选；资料由你确认后再入职。</Typography.Text>
            </Flex>
          </Flex>
          <SettingsField label="岗位需求" htmlFor="new-employee-expectation">
            <Input.TextArea
              id="new-employee-expectation"
              rows={4}
              maxLength={4000}
              value={expectation}
              placeholder="例如：招聘一位前端工程师，负责界面与交互，熟悉 React，交付前完成浏览器验证。"
              disabled={saving || filling}
              autoFocus
              onChange={(e) => setExpectation(e.target.value)}
            />
            <Typography.Text type="secondary" className="wand-employee-hint">
              {manualMode
                ? "人选资料已就绪。请核对职责、角色设定和执行候选，再确认入职。"
                : "说明负责什么、需要哪些专长，以及你期望的交付方式。也可展开下方资料手动填写。"}
            </Typography.Text>
          </SettingsField>

          <EmployeeTagsField id="new-employee-tags" value={tagInput}
            disabled={saving || filling} onChange={setTagInput} />

          <Flex justify="end" wrap gap={6} className="wand-team-member-actions">
            <SettingsActionButton
              kind="primary"
              size="small"
              className="wand-employee-create-submit"
              pending={saving || filling}
              settled={error ? "error" : null}
              pendingLabel={manualMode ? "正在入职…" : "嘟嘟拟定中…"}
              successLabel="人选已拟定"
              errorLabel={manualMode ? "入职失败" : "拟定失败"}
              disabled={filling || avatarBusy}
              onClick={() => handleCreate()}
            >
              {manualMode ? "确认入职" : "请嘟嘟拟定人选"}
            </SettingsActionButton>
            <WandButton
              kind="ghost"
              size="small"
              disabled={saving}
              onClick={onCancel}
            >
              取消
            </WandButton>
          </Flex>
          {error ? <Alert className="wand-team-candidate-error" role="alert" type="error" showIcon title={error}/> : null}

          <Collapse
            className="wand-employee-advanced"
            ghost
            activeKey={advanced ? ["advanced"] : []}
            onChange={(keys) => setAdvanced((Array.isArray(keys) ? keys.length > 0 : !!keys))}
            items={[{
              key: "advanced",
              label: "人选资料（可手动填写）",
              // 收起时内容仍挂载：重新展开后候选列表的 key 与上一次填写的字段都在。
              forceRender: true,
              children: <Flex vertical gap={10} className="wand-employee-advanced-inner">
                <SettingsField label="名字" htmlFor="new-employee-name">
                  <Input
                    id="new-employee-name"
                    value={name}
                    placeholder="员工名字"
                    disabled={saving || filling}
                    onChange={(e) => setName(e.target.value)}
                  />
                </SettingsField>

                <div className="employee-create-avatar"><EmployeeAvatar employee={{ id: "new-employee", name, avatar }} provider="" size="lg"/>
                  <WandButton kind="ghost" disabled={saving || filling} aria-expanded={avatarOpen} onClick={() => setAvatarOpen(value => !value)}>{avatarOpen ? "收起头像" : "编辑头像"}</WandButton>
                </div>
                {avatarOpen && <EmployeeAvatarWorkspace employee={{ id: "new-employee", name, avatar }} disabled={saving || filling}
                  onChange={setAvatar} onBusyChange={setAvatarBusy} onClose={() => setAvatarOpen(false)}/>}

                <SettingsField label="职责" htmlFor="new-employee-duty">
                  <Input.TextArea
                    id="new-employee-duty"
                    rows={2}
                    value={duty}
                    placeholder="一句话职责：在侧栏、选择器和署名中显示"
                    disabled={saving || filling}
                    onChange={(e) => setDuty(e.target.value)}
                  />
                </SettingsField>

                <SettingsField label="角色设定 (Prompt)" htmlFor="new-employee-prompt">
                  <Input.TextArea
                    id="new-employee-prompt"
                    rows={4}
                    value={prompt}
                    placeholder="设定角色的专业能力、行为守则与交付习惯（创建会话时作为系统提示生效）"
                    disabled={saving || filling}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                </SettingsField>

                <CandidatesListEditor
                  agents={agents}
                  label={name || "新员工"}
                  catalog={catalog}
                  providerOptions={providerOptions}
                  disabled={saving || filling}
                  structuredOnly
                  onChange={setAgents}
                />

                <Flex justify="end" className="wand-employee-advanced-tools">
                  <SettingsActionButton
                    kind="ghost"
                    size="small"
                    pending={filling}
                    pendingLabel="生成中…"
                    successLabel="已生成"
                    errorLabel="生成失败"
                    disabled={saving || avatarBusy}
                    onClick={() => handleFillFromExpectation()}
                  >
                    <WandIcon name="spark" size={14} slot="start" />
                    请嘟嘟重新拟定
                  </SettingsActionButton>
                </Flex>
              </Flex>,
            }]}
          />


        </Flex>
      </div>
    </section>
  );
}
