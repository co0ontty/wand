import * as React from "react";
import { Alert, Avatar, Button, Card, Collapse, Empty, Flex, Input, InputNumber, List, Tabs, Tag, Tooltip, Typography } from "antd";
import {
  AI_TEAM_AVATAR_MAX_CHARS,
  AI_TEAM_DEFAULT_MAX_STEPS,
  AI_TEAM_MAX_CANDIDATES,
  AI_TEAM_MAX_MEMBERS,
  AI_TEAM_MAX_STEPS,
  AI_TEAM_MIN_MEMBERS,
  AI_TEAM_MIN_STEPS,
  agentKey,
  memberAgents,
} from "../../../ai-team-types";
import type { SiliconEmployee } from "../../../ai-team-types.js";
import { useSiliconEmployees } from "../agents/employee-repository.js";
import { TeamEmployeeInvite } from "./team-employee-invite.js";
import { TeamDispatchPanel, TeamDispatchTrigger } from "./team-dispatch.js";
import { bindTeamEmployee, duplicateTeamEmployees, employeeJoinError, teamRequestInput, teamSaveDefinitelyRejected,
  type TeamDraftInput, type TeamMemberDraft } from "./team-employee-binding.js";
import type { WandTaskAgent } from "../../../task-types";
import { failureMessage } from "../errors";
import { AgentFields } from "../issues/agent-fields";
import {
  createDefaultIssueAgent,
  issueAgentProviderLabel,
  issueAgentProviderModelLine,
  ISSUE_AGENT_PROVIDERS,
  normalizeIssueModelCatalog,
  type IssueAgentProvider,
  type IssueModelCatalog,
  type IssueWorkspace,
} from "../issues/task-board-agent";
import { taskBoardController, taskBoardStore } from "../issues/task-board-controller";
import { taskBoardRepository } from "../issues/task-board-repository";
import { RUN_STATUS, TeamRunView } from "../issues/team-run-panel";
import { mergeTeamChatDetail } from "./team-chat-view";
import { subscribeWandModelCatalog, wandModelDisplayName } from "../model-catalog";
import { wandOverlay } from "../overlay-controller";
import { sortProviderOptions, useProviderUsage } from "../provider-usage";
import {
  SettingsActionButton,
  SettingsField,
  SettingsSaveBar,
  SettingsToggle,
} from "../settings/fields";
import { SidebarToggleIcon } from "../shell/sidebar-toggle-icon";
import { WandBadge, WandBreadcrumb, WandButton, WandIcon, WandIconButton, WandSearchField, WandSelect, WandStretchTabs } from "../ui";
import { CAT_COATS, PixelCat, shrinkAvatarImage, TeamAvatar, TeamAvatarStack } from "./avatar";
import {
  aiTeamsRepository,
  subscribeAiTeamRunChanges,
  type AiTeam,
  type AiTeamDirectRun,
  type AiTeamInput,
  type AiTeamMember,
  type AiTeamRunDetail,
  type AiTeamRunSummary,
} from "./repository";

type ProviderOptions = Array<{ value: IssueAgentProvider; label: string }> | null;
type TeamFilter = "all" | "running" | "attention";

const NEW_TEAM = "__new__";
const ATTENTION: ReadonlyArray<AiTeamRunSummary["status"]> = ["awaiting_approval", "waiting_user"];

interface TeamTemplate {
  id: string;
  name: string;
  summary: string;
  instructions: string;
  members: Array<{ name: string; duty: string; isLeader?: boolean }>;
}

/** 新建团队的起步模板：挑一个再改，比从空白开始快。 */
const TEMPLATES: readonly TeamTemplate[] = [
  {
    id: "dev",
    name: "开发三人组",
    summary: "负责人拆解与验收，一人实现，一人审查",
    instructions: "审查者只读代码，问题写进报告，由负责人决定是否返工。",
    members: [
      { name: "负责人", isLeader: true, duty: "拆解任务、分派步骤，审阅报告并决定下一步或完成。" },
      { name: "实现者", duty: "按步骤改代码并自测，报告写清改动与验证方式。" },
      { name: "审查者", duty: "审查改动与测试，指出问题和风险，不直接修改。" },
    ],
  },
  {
    id: "bugfix",
    name: "修 Bug 二人组",
    summary: "负责人定位与验证，一人修复",
    instructions: "先复现再修，修复附上验证步骤。",
    members: [
      { name: "负责人", isLeader: true, duty: "复现并定位根因，写清修改范围，修完后验证。" },
      { name: "修复者", duty: "按定位修改代码，补回归测试，报告附验证输出。" },
    ],
  },
  {
    id: "research",
    name: "调研加评审",
    summary: "两人并行调研不同方向，负责人汇总",
    instructions: "调研员可同时开始，只读不改文件。",
    members: [
      { name: "负责人", isLeader: true, duty: "拆出互不重叠的调研方向，汇总结论给出建议。" },
      { name: "调研员甲", duty: "按分派的方向调研，结论附出处。" },
      { name: "调研员乙", duty: "按分派的方向调研，结论附出处。" },
    ],
  },
  {
    id: "blank",
    name: "空白团队",
    summary: "一位负责人加一位成员，自己写职责",
    instructions: "",
    members: [
      { name: "负责人", isLeader: true, duty: "" },
      { name: "成员", duty: "" },
    ],
  },
];

function templateInput(template: TeamTemplate, agent: WandTaskAgent): AiTeamInput {
  return {
    name: template.id === "blank" ? "" : template.name,
    description: template.summary,
    instructions: template.instructions,
    requirePlanApproval: true,
    maxSteps: AI_TEAM_DEFAULT_MAX_STEPS,
    members: template.members.map((member) => ({
      id: "",
      name: member.name,
      duty: member.duty,
      isLeader: !!member.isLeader,
      agents: [{ ...agent }],
      agent: { ...agent },
      // 没有用户自定义就不写头像：系统按成员身份生成，不替用户先挑一只猫。
      avatar: "",
    })),
  };
}

function inputOf(team: AiTeam): AiTeamInput {
  return {
    name: team.name,
    description: team.description,
    instructions: team.instructions,
    requirePlanApproval: team.requirePlanApproval,
    maxSteps: team.maxSteps,
    members: team.members.map((member) => ({ ...member, agent: { ...member.agent } })),
  };
}

function leaderFirst(members: AiTeamMember[]): AiTeamMember[] {
  return [...members].sort((a, b) => Number(b.isLeader) - Number(a.isLeader));
}

import {
  CandidatesListEditor,
  candidateLabel,
  addCandidate,
  setCandidate,
  removeCandidate,
  moveCandidate,
  duplicateCandidates,
  candidateListError,
} from "../agents/candidate-editor.js";
export {
  candidateLabel,
  addCandidate,
  setCandidate,
  removeCandidate,
  moveCandidate,
  duplicateCandidates,
  candidateListError,
};

/** 保存前的整份草稿校验，与 §4.1 服务端同口径；返回要原位显示的中文文案。 */
export function validateTeamDraft(members: TeamMemberDraft[]): string[] {
  const errors: string[] = [];
  if (members.length < AI_TEAM_MIN_MEMBERS) errors.push(`至少要有 ${AI_TEAM_MIN_MEMBERS} 位成员。`);
  if (members.length > AI_TEAM_MAX_MEMBERS) errors.push(`最多 ${AI_TEAM_MAX_MEMBERS} 位成员。`);
  const leaders = members.filter((member) => member.isLeader).length;
  if (leaders !== 1) errors.push(`负责人要恰好 1 位，当前 ${leaders} 位。`);
  for (const name of duplicateTeamEmployees(members)) errors.push(`${name}：同一员工不能重复加入团队。`);
  members.forEach((member, index) => {
    const error = candidateListError(memberAgents(member));
    if (error) errors.push(`${member.name || `成员 ${index + 1}`}：${error}`);
  });
  return errors;
}

/** 头像选择：八种毛色 + 上传小图；不挑也不上传就是按成员身份生成的默认头像。 */
function AvatarPicker({
  member,
  disabled,
  onChange,
}: {
  member: TeamMemberDraft;
  disabled: boolean;
  onChange(avatar: string): void;
}): React.ReactElement {
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [error, setError] = React.useState("");
  const current = member.avatar ?? "";
  const selectedMatch = /^cat:(\d+)$/.exec(current);
  const selectedCoat = selectedMatch ? Number(selectedMatch[1]) % CAT_COATS.length : null;
  return <Flex wrap gap={6} align="center" role="group" aria-label="头像">
    {CAT_COATS.map((entry, index) => <Tooltip key={entry.name} title={entry.name}>
      <Button
        className="wand-team-coat"
        shape="circle"
        size="small"
        aria-label={entry.name}
        aria-pressed={!current.startsWith("data:") && selectedCoat === index}
        disabled={disabled}
        onClick={() => { setError(""); onChange(`cat:${index}`); }}
      >
        <PixelCat coat={index}/>
      </Button>
    </Tooltip>)}
    <Tooltip title="上传图片">
      <Button
        className="wand-team-coat is-upload"
        shape="circle"
        size="small"
        aria-label="上传头像图片"
        aria-pressed={current.startsWith("data:")}
        disabled={disabled}
        onClick={() => fileRef.current?.click()}
      >
        {current.startsWith("data:") ? <Avatar size={18} src={current} alt=""/> : <WandIcon name="image" size={14}/>}
      </Button>
    </Tooltip>
    <input
      ref={fileRef}
      type="file"
      accept="image/png,image/jpeg,image/webp"
      hidden
      tabIndex={-1}
      aria-label="上传头像图片"
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        setError("");
        void shrinkAvatarImage(file, AI_TEAM_AVATAR_MAX_CHARS).then(onChange)
          .catch((cause) => setError(failureMessage(cause, "图片处理失败。")));
      }}
    />
    {error ? <Alert type="error" showIcon role="alert" title={error}/> : null}
  </Flex>;
}

/** 组织图里的一张成员卡：点卡片在原位展开编辑区，再点一次原路收起。 */
function MemberCard({
  member,
  index,
  open,
  catalog,
  providerOptions,
  disabled,
  canRemove,
  employeeSource,
  members,
  onBind,
  onToggle,
  onChange,
  onRemove,
}: {
  member: TeamMemberDraft;
  index: number;
  open: boolean;
  catalog: IssueModelCatalog | null;
  providerOptions: ProviderOptions;
  disabled: boolean;
  canRemove: boolean;
  employeeSource: ReturnType<typeof useSiliconEmployees>;
  members: TeamMemberDraft[];
  onBind(employee: SiliconEmployee): void;
  onToggle(): void;
  onChange(patch: Partial<TeamMemberDraft>): void;
  onRemove(): void;
}): React.ReactElement {
  const bound = !!member.employeeId;
  const employee = employeeSource.employees.find((entry) => entry.id === member.employeeId);
  if (bound && employee?.agents.length) member = bindTeamEmployee(member, employee);
  const label = member.name || `成员 ${index + 1}`;
  const agents = memberAgents(member);
  const showAgents = (next: WandTaskAgent[]): void => {
    // 双写兼容字段：agent 永远是 agents[0]（§3.6）。
    onChange({ agents: next, agent: { ...next[0]! } });
  };

  return <Card
    size="small"
    className="wand-team-member"
    data-leader={member.isLeader || undefined}
    data-open={open || undefined}
  >
    <WandButton kind="ghost" type="button" className="wand-team-member-head" style={{ width: "100%", height: "auto", minHeight: 56, textAlign: "start", alignItems: "center", gap: 12 }} aria-expanded={open} onClick={onToggle}>
      <TeamAvatar member={member} size="md"/>
      <Flex vertical gap={2} className="wand-team-member-copy" style={{ flex: 1, minWidth: 0 }}>
        <Flex align="center" gap={6} className="wand-team-member-name-line"><Typography.Text strong ellipsis title={label}>{label}</Typography.Text>{member.isLeader ? <Tag>负责人</Tag> : null}</Flex>
        <Typography.Text type="secondary" ellipsis title={member.duty || "还没写职责"}>{member.duty || "还没写职责"}</Typography.Text>
        <Typography.Text type="secondary" ellipsis className="wand-team-member-agent" title={issueAgentProviderModelLine(member.agent, catalog)}>
          {issueAgentProviderModelLine(member.agent, catalog)}
        </Typography.Text>
      </Flex>
      <WandIcon name="chevronDown" size={14}/>
    </WandButton>
    <Collapse bordered={false} ghost activeKey={open ? ["editor"] : []}
        styles={{ header: { display: "none" }, body: { padding: 0 } }}
        items={[{ key: "editor", label: "成员编辑", showArrow: false, forceRender: true, children:
          <div className="wand-team-member-body" inert={!open}>
      <Flex vertical gap={10} style={{ minWidth: 0, paddingTop: 10 }} className="wand-team-member-inner">
        <TeamEmployeeInvite {...employeeSource} members={members} replacingIndex={index}
          disabled={disabled} onPick={onBind}/>
        {bound ? <>
          <Typography.Text type="secondary">已绑定通讯录员工；名字、头像、基础角色与候选只读。知识归属仍是该员工，不共享私聊。</Typography.Text>
          {employee?.archivedAt || (!employeeSource.loading && !employeeSource.error && !employee)
            ? <Alert type="warning" showIcon role="alert" title="绑定员工已归档或删除，绑定保留。请明确替换、移除或改为手工 CLI 成员。"/> : null}
          <WandButton kind="ghost" size="small" disabled={disabled}
            onClick={() => onChange({ ...member, employeeId: null })}>改为手工 CLI 成员（解除绑定）</WandButton>
        </> : null}
        <SettingsField label="名字" htmlFor={`team-member-${index}-name`}>
          <Input
            id={`team-member-${index}-name`}
            value={member.name}
            placeholder="成员名字"
            disabled={disabled || bound}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </SettingsField>
        <AvatarPicker member={member} disabled={disabled || bound} onChange={(avatar) => onChange({ avatar })}/>
        <Input.TextArea
          className="wand-ai-team-duty"
          rows={3}
          value={member.duty}
          placeholder="职责：这位成员负责什么、交付什么"
          aria-label={`${label}的职责`}
          disabled={disabled}
          onChange={(event) => onChange({ duty: event.target.value })}
        />
        <CandidatesListEditor
          agents={agents}
          label={label}
          catalog={catalog}
          providerOptions={providerOptions}
          disabled={disabled || bound}
          onChange={showAgents}
        />
        <SettingsField label="团队角色">
          <WandSelect ariaLabel={`${label}的团队角色`} value={member.role ?? "any"} disabled={disabled}
            options={[{ value: "any", label: "不限" }, { value: "plan", label: "规划" },
              { value: "work", label: "执行" }, { value: "verify", label: "验证" }]}
            onValueChange={(role) => onChange({ role: role as AiTeamMember["role"] })}/>
        </SettingsField>
        <Flex justify="end" wrap gap={6} className="wand-team-member-actions">
          {member.isLeader ? null : <WandButton kind="ghost" size="small" disabled={disabled} onClick={() => onChange({ isLeader: true })}>
            设为负责人
          </WandButton>}
          <WandButton kind="ghost" size="small" disabled={disabled || !canRemove} onClick={onRemove}>
            <WandIcon name="trash" size={14} slot="start"/>移除
          </WandButton>
        </Flex>
      </Flex>
    </div> }]}/>
  </Card>;
}

export function TeamEditor({
  team,
  initial,
  active = true,
  catalog,
  providerOptions,
  defaultAgent,
  onSaved,
  onDeleted,
  onDirtyChange,
}: {
  team: AiTeam | null;
  initial: AiTeamInput;
  active?: boolean;
  catalog: IssueModelCatalog | null;
  providerOptions: ProviderOptions;
  defaultAgent: WandTaskAgent;
  onSaved(team: AiTeam, created: boolean): void;
  onDeleted(id: string): void;
  /** 草稿是否偏离初始值；宿主用它决定离开前要不要确认，编辑过程本身不上报服务端。 */
  onDirtyChange?: (dirty: boolean, pending: boolean) => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState<TeamDraftInput>(initial);
  const [openMember, setOpenMember] = React.useState(-1);
  const [pending, setPending] = React.useState(false);
  const employeeSource = useSiliconEmployees({ includeArchived: true, enabled: active });
  const [unknownSave, setUnknownSave] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const [tone, setTone] = React.useState<"info" | "success" | "error">("info");
  const busy = pending || deleting || unknownSave;
  const idPrefix = `ai-team-${team?.id ?? "new"}`;
  const leaderIndex = draft.members.findIndex((member) => member.isLeader);
  // 草稿是否偏离初始值：AiTeamInput 是纯数据（成员数量有限），直接比序列化结果，
  // 不给每个字段单独维护 touched 标记。宿主只读一个布尔，编辑过程零开销。
  const initialKey = JSON.stringify(initial);
  const dirty = React.useMemo(() => JSON.stringify(draft) !== initialKey, [draft, initialKey]);
  React.useEffect(() => { onDirtyChange?.(dirty || busy, pending || deleting); }, [dirty, busy, pending, deleting, onDirtyChange]);

  const patchMember = (index: number, patch: Partial<TeamMemberDraft>): void => {
    setDraft((current) => ({
      ...current,
      members: current.members.map((member, at) => {
        if (at === index) return { ...member, ...patch };
        // 负责人只能有一位：把别人设为负责人时这里同步卸任。
        return patch.isLeader ? { ...member, isLeader: false } : member;
      }),
    }));
  };

  const removeMember = (index: number): void => {
    setOpenMember(-1);
    setDraft((current) => {
      const members = current.members.filter((_, at) => at !== index);
      if (!members.some((member) => member.isLeader) && members[0]) members[0] = { ...members[0], isLeader: true };
      return { ...current, members };
    });
  };

  async function save(): Promise<void> {
    if (busy) return;
    const errors = validateTeamDraft(draft.members);
    if (errors.length > 0) {
      // 与 §4.1 同口径的前端拦截：错误原位显示在保存条上，不另起浮层。
      setStatus(errors[0]!);
      setTone("error");
      return;
    }
    setPending(true);
    setStatus("");
    try {
      const saved = team ? await aiTeamsRepository.update(team.id, teamRequestInput(draft)) : await aiTeamsRepository.create(teamRequestInput(draft));
      setDraft(inputOf(saved));
      setStatus(team ? "已保存。" : "团队模板已创建。");
      setTone("success");
      onSaved(saved, !team);
    } catch (cause) {
      const rejected = teamSaveDefinitelyRejected(cause);
      setUnknownSave(!rejected);
      setStatus(rejected ? failureMessage(cause, "保存团队模板失败。")
        : "保存结果尚未确认，草稿保留。请先核对团队模板列表，不要重复保存。");
      setTone("error");
    } finally {
      setPending(false);
    }
  }

  async function remove(): Promise<boolean | void> {
    if (!team) return;
    const answer = await wandOverlay.dialog({
      title: `删除团队模板「${team.name}」？`,
      description: "已经开始的运行不受影响，会按启动时的团队快照继续。",
      actions: [
        { label: "取消", value: false, autoFocus: true },
        { label: "删除团队模板", value: true, kind: "danger" },
      ],
    });
    if (answer.dismissed === true || !answer.action) return;
    setDeleting(true);
    try {
      await aiTeamsRepository.remove(team.id);
      onDeleted(team.id);
    } catch (cause) {
      setStatus(failureMessage(cause, "删除团队模板失败。"));
      setTone("error");
      return false;
    } finally {
      setDeleting(false);
    }
  }

  const card = (index: number): React.ReactElement => <MemberCard
    key={index}
    member={draft.members[index]!}
    index={index}
    open={openMember === index}
    catalog={catalog}
    providerOptions={providerOptions}
    disabled={busy}
    canRemove={draft.members.length > AI_TEAM_MIN_MEMBERS}
    employeeSource={employeeSource}
    members={draft.members}
    onBind={(employee) => setDraft((current) => employeeJoinError(employee, current.members, index)
      ? current : { ...current, members: current.members.map((member, at) =>
        at === index ? bindTeamEmployee(member, employee) : member) })}
    onToggle={() => setOpenMember((current) => current === index ? -1 : index)}
    onChange={(patch) => patchMember(index, patch)}
    onRemove={() => removeMember(index)}
  />;

  return <Flex vertical gap={22} className="wand-team-editor">
    <Flex component="section" vertical gap={12} className="wand-team-section" aria-label="成员">
      <Flex className="wand-team-section-head" justify="space-between" align="baseline" gap={8} wrap>
        <Typography.Title level={5} style={{ margin: 0 }}>成员</Typography.Title>
        <Typography.Text type="secondary">{draft.members.length}/{AI_TEAM_MAX_MEMBERS} · 点成员卡展开编辑</Typography.Text>
      </Flex>
      <TeamEmployeeInvite {...employeeSource} members={draft.members}
        disabled={busy || draft.members.length >= AI_TEAM_MAX_MEMBERS}
        onPick={(employee) => {
          setDraft((current) => employeeJoinError(employee, current.members) ? current : ({ ...current, members: [...current.members, bindTeamEmployee({
            id: "", name: "", duty: employee.duty, agents: [], agent: defaultAgent, isLeader: false,
          }, employee)] }));
          setOpenMember(draft.members.length);
        }}/>
      <div className="wand-team-org">
        {leaderIndex >= 0 ? <div className="wand-team-org-leader">{card(leaderIndex)}</div> : null}
        <div className="wand-team-org-members">
          {draft.members.map((member, index) => member.isLeader ? null : card(index))}
          <WandButton
            kind="ghost"
            size="small"
            className="wand-team-member-add"
            disabled={busy || draft.members.length >= AI_TEAM_MAX_MEMBERS}
            onClick={() => {
              setDraft((current) => ({
                ...current,
                members: [...current.members, {
                  id: "", name: "", duty: "", agents: [{ ...defaultAgent }], agent: { ...defaultAgent }, isLeader: false,
                  // 与模板成员一致：不替用户挑毛色，留空交给系统按身份生成。
                  avatar: "",
                }],
              }));
              setOpenMember(draft.members.length);
            }}
          >
            <WandIcon name="plus" size={16} slot="start"/>
            <span>添加手工 CLI 成员</span>
          </WandButton>
        </div>
      </div>
    </Flex>
    <Flex component="section" vertical gap={12} className="wand-team-section" aria-label="协作设置">
      <Flex className="wand-team-section-head" justify="space-between" align="baseline" gap={8} wrap><Typography.Title level={5} style={{ margin: 0 }}>协作设置</Typography.Title></Flex>
      <Flex className="wand-ai-team-editor-grid" gap={12} wrap>
        <div className="wand-ai-team-editor-cell">
        <SettingsField label="团队模板名称" htmlFor={`${idPrefix}-name`}>
          <Input
            id={`${idPrefix}-name`}
            value={draft.name}
            placeholder="例如：全栈小组"
            disabled={busy}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </SettingsField>
        </div>
        <div className="wand-ai-team-editor-cell">
        <SettingsField
          label="步数上限"
          htmlFor={`${idPrefix}-steps`}
          hint={`负责人轮次与成员步骤合计，${AI_TEAM_MIN_STEPS}–${AI_TEAM_MAX_STEPS}`}
        >
          <InputNumber
            id={`${idPrefix}-steps`}
            min={AI_TEAM_MIN_STEPS}
            max={AI_TEAM_MAX_STEPS}
            value={draft.maxSteps}
            disabled={busy}
            style={{ width: "100%" }}
            onChange={(value) => setDraft((current) => ({ ...current, maxSteps: Number(value ?? AI_TEAM_DEFAULT_MAX_STEPS) }))}
          />
        </SettingsField>
        </div>
      </Flex>
      <SettingsField label="简介" htmlFor={`${idPrefix}-description`}>
        <Input
          id={`${idPrefix}-description`}
          value={draft.description}
          placeholder="可选：这组员工擅长什么"
          disabled={busy}
          onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
        />
      </SettingsField>
      <SettingsField label="协作指令" htmlFor={`${idPrefix}-instructions`} hint="写进负责人和每位成员的提示词：分工约定、工作要求、注意事项。">
        <Input.TextArea
          id={`${idPrefix}-instructions`}
          className="wand-ai-team-duty"
          rows={4}
          value={draft.instructions}
          placeholder="例如：先读 AGENTS.md；改动必须附测试；不要动 migrations 目录。"
          disabled={busy}
          onChange={(event) => {
            const instructions = event.target.value;
            setDraft((current) => ({ ...current, instructions }));
          }}
        />
      </SettingsField>
      <SettingsToggle
        label="计划需要我批准"
        description="负责人给出第一份计划后先停下，等你批准或退回再开始执行。"
        checked={draft.requirePlanApproval}
        disabled={busy}
        onCheckedChange={(requirePlanApproval) => setDraft((current) => ({ ...current, requirePlanApproval }))}
      />
    </Flex>
    <Flex align="end" justify="space-between" wrap gap={12} className="wand-ai-team-editor-footer">
      {team ? <SettingsActionButton
        kind="danger"
        size="small"
        pending={deleting}
        pendingLabel="删除中…"
        errorLabel="删除失败"
        disabled={pending || unknownSave}
        onClick={remove}
      >
        删除团队模板
      </SettingsActionButton> : null}
      <SettingsSaveBar
        label={team ? "保存团队模板" : "创建团队模板"}
        pending={pending}
        disabled={deleting || unknownSave}
        onSave={() => void save()}
        status={status}
        tone={tone}
      />
    </Flex>
  </Flex>;
}

/** 直接开工能选的项目：只有已有项目，全局工作区会被服务端 400 掉（§4.2 R2）；与临时派工共用同一份规则。 */
export { defaultTeamStartProject, teamStartProjects } from "./team-start-projects";
import { defaultTeamStartProject, teamStartProjects } from "./team-start-projects";

type StartPhase = "idle" | "sending" | "sent" | "failed";

/**
 * 团队卡的「直接开工」：表单从按钮原位长出来（§7 要求 1），收起是展开的倒放，
 * 三条关闭路径（收起按钮 / Esc / 点到行外）。提交后在同一位置依次是
 * 加载 → 完成 → 结果，不用 Toast；停留时长走 `aiTeamsRepository.settle()`，
 * 只从 motion-tokens 取值。提交期间按钮禁用，防止连点建出两个运行。
 */
function TeamStartRow({
  teamId,
  teamName,
  projects,
  projectsLoaded,
  openRequest = 0,
  onStarted,
}: {
  teamId: string;
  teamName: string;
  projects: readonly IssueWorkspace[];
  projectsLoaded: boolean;
  openRequest?: number;
  onStarted(run: AiTeamDirectRun): void;
}): React.ReactElement {
  const startable = teamStartProjects(projects);
  const [open, setOpen] = React.useState(openRequest > 0);
  const [settled, setSettled] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [workspaceId, setWorkspaceId] = React.useState("");
  const [phase, setPhase] = React.useState<StartPhase>("idle");
  const [message, setMessage] = React.useState("");
  const rowRef = React.useRef<HTMLDivElement>(null);
  const noteRef = React.useRef<React.ComponentRef<typeof Input.TextArea>>(null);
  const projectMenuClass = "wand-team-start-project-menu-" + React.useId();
  const picked = workspaceId || defaultTeamStartProject(projects);
  const busy = phase === "sending" || phase === "sent";

  React.useEffect(() => {
    if (openRequest > 0) {
      setOpen(true);
      setSettled(false);
    } else {
      setOpen(false);
      setSettled(false);
    }
  }, [openRequest]);

  function collapse(): void {
    if (phase === "sending") return;
    setOpen(false);
    setSettled(false);
    if (phase === "failed") setMessage("");
  }

  React.useLayoutEffect(() => {
    if (!open || settled) return undefined;
    // 双帧：先让收起态画一帧，下一帧放开并聚焦输入框，过渡才有起点（同候选行）。
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        setSettled(true);
        noteRef.current?.focus();
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [open, settled]);

  React.useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (rowRef.current?.contains(event.target as Node)) return;
      // The authored select's popup lives in a portal outside this row.
      // Treat only this row's popup as inside; unrelated outside clicks still close it.
      if (event.target instanceof Element
        && event.target.closest(".wand-ui-select-content")?.classList.contains(projectMenuClass)) return;
      collapse();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, phase, projectMenuClass]);

  async function start(): Promise<void> {
    if (busy) return;
    const trimmed = note.trim();
    if (!trimmed || !picked) return;
    setPhase("sending");
    setMessage("");
    try {
      const started = await aiTeamsRepository.startDirect(teamId, { note: trimmed, workspaceId: picked });
      setPhase("sent");
      setMessage(`${teamName}已开工，正在打开群聊…`);
      await aiTeamsRepository.settle("success");
      onStarted(started);
      setOpen(false);
      setSettled(false);
      setPhase("idle");
      setMessage("");
      setNote("");
    } catch (cause) {
      setPhase("failed");
      setMessage(failureMessage(cause, "开工失败，请换个项目或稍后再试。"));
      await aiTeamsRepository.settle("error");
      setPhase("idle");
    }
  }

  return <div ref={rowRef} onKeyDown={(event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    collapse();
  }}>
    <Flex justify="end" wrap gap={6} className="wand-team-member-actions">
      <WandButton
        className="task-board-create-button"
        kind="ghost"
        size="small"
        aria-pressed={open}
        disabled={busy}
        onClick={() => (open ? collapse() : setOpen(true))}
      >
        <WandIcon name="plus" slot="start" className="wand-teams-create-icon"/>
        <span>直接开工</span>
      </WandButton>
    </Flex>
    <Collapse ghost bordered={false} className="wand-team-candidate-slot" activeKey={settled ? ["start"] : []}
      styles={{ header: { display: "none" }, body: { padding: 0 } }}
      items={[{ key: "start", label: "直接开工", showArrow: false, forceRender: true, children: <>
      <Flex vertical gap={10} style={{ minWidth: 0, paddingTop: 10 }} className="wand-team-member-inner" inert={!open}>
        <Card size="small" className="wand-team-candidates"><Flex vertical gap={8}>
          {startable.length === 0 ? (
            projectsLoaded
              ? <Alert type="error" showIcon role="alert" title="还没有可开工的项目，先在工作区创建一个项目。"/>
              : <Typography.Text type="secondary">正在加载项目…</Typography.Text>
          ) : <>
            <SettingsField label="项目">
              <div className="wand-team-select">
              <WandSelect
                ariaLabel="开工项目"
                contentClassName={projectMenuClass}
                value={picked}
                disabled={busy}
                searchable
                searchPlaceholder="搜索项目"
                options={startable.map((project) => ({
                  value: project.id, label: `${project.name} · ${project.cwd}`,
                }))}
                onValueChange={setWorkspaceId}
              />
              </div>
            </SettingsField>
            <SettingsField
              label="开工说明"
              htmlFor={`team-start-note-${teamId}`}
              hint="会建一张任务卡，并把这段说明交给负责人。"
            >
              <Input.TextArea
                id={`team-start-note-${teamId}`}
                ref={noteRef}
                className="wand-ai-team-duty"
                rows={2}
                value={note}
                placeholder="例如：把设置页的模型下拉换成可搜索的选择器，并补单测。"
                disabled={busy}
                onChange={(event) => setNote(event.target.value)}
              />
            </SettingsField>
          </>}
          {message ? <Alert
            type={phase === "failed" ? "error" : "success"}
            showIcon
            role={phase === "failed" ? "alert" : "status"}
            title={message}
          /> : null}
          {open && startable.length > 0 ? <Flex justify="end" wrap gap={6} className="wand-team-member-actions">
            <WandButton
              kind="primary"
              size="small"
              disabled={busy || !note.trim() || !picked}
              onClick={() => void start()}
            >
              {phase === "sending" ? "正在开工…" : phase === "sent" ? "已开工" : "开工"}
            </WandButton>
          </Flex> : null}
        </Flex></Card>
      </Flex>
          </> }]}/>
  </div>;
}

/** 团队的运行记录：点一条在原位展开完整的运行视图。 */
export function TeamRuns({
  runs,
  focusRunId,
  onOpenSession,
}: {
  runs: AiTeamRunSummary[] | null;
  focusRunId?: string;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement {
  const [openId, setOpenId] = React.useState("");
  const [detail, setDetail] = React.useState<AiTeamRunDetail | null>(null);
  const selectedRun = React.useRef(openId);
  const requestGeneration = React.useRef(0);
  const alive = React.useRef(true);
  selectedRun.current = openId;
  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; requestGeneration.current++; };
  }, []);

  const load = React.useCallback(async (runId: string) => {
    const generation = ++requestGeneration.current;
    const current = (): boolean => alive.current && selectedRun.current === runId
      && generation === requestGeneration.current;
    try {
      const next = await aiTeamsRepository.detail(runId);
      if (current() && next.run.id === runId) {
        setDetail((previous) => mergeTeamChatDetail(previous, next));
      }
    } catch {
      // A failed or superseded refresh never erases the latest confirmed delivery.
    }
  }, []);

  React.useEffect(() => {
    if (focusRunId) setOpenId(focusRunId);
  }, [focusRunId]);

  React.useEffect(() => {
    if (openId) void load(openId);
  }, [load, openId]);

  React.useEffect(() => subscribeAiTeamRunChanges((change) => {
    if (change.runId === openId) void load(openId);
  }), [load, openId]);

  if (runs === null) return <Typography.Text type="secondary">正在加载运行记录…</Typography.Text>;
  if (runs.length === 0) return <Empty
    image={Empty.PRESENTED_IMAGE_SIMPLE}
    description="还没有运行过。用团队卡下面的「直接开工」，或在任务看板派发任务时从「CLI 工具」里选这个团队。"
  />;
  return <List
    className="wand-team-runs"
    size="small"
    dataSource={runs}
    renderItem={(run) => {
      const open = openId === run.id;
      const status = RUN_STATUS[run.status];
      return <List.Item key={run.id} style={{ display: "block" }}>
        <Card size="small" className="wand-team-run" data-open={open || undefined}>
        <WandButton kind="ghost" type="button" className="wand-team-run-head" style={{ width: "100%", height: "auto", minHeight: 44, textAlign: "start", flexWrap: "wrap" }} aria-expanded={open} onClick={() => {
          requestGeneration.current++;
          selectedRun.current = open ? "" : run.id;
          setDetail(null);
          setOpenId((current) => current === run.id ? "" : run.id);
        }}>
          <Typography.Text type="secondary" code className="wand-team-run-id">{run.taskIdentifier}</Typography.Text>
          <Typography.Text ellipsis strong style={{ flex: 1, minWidth: 100 }}>{run.taskTitle || run.objective.split("\n")[0]}</Typography.Text>
          <WandBadge tone={status.tone}>{status.label}</WandBadge>
          {/* 时刻格式跟着浏览器 locale 走（和 team-chat-view.tsx 的 chatTurnClock 同一口径）：
              写死 "zh-CN" 会让英文环境的用户在同一页里看到两种日期写法。 */}
          <Typography.Text type="secondary">{new Date(run.updatedAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</Typography.Text>
          <WandIcon name="chevronDown" size={14}/>
        </WandButton>
        <Collapse ghost bordered={false} activeKey={open ? ["run"] : []}
          styles={{ header: { display: "none" }, body: { padding: "8px 0 0" } }}
          items={[{ key: "run", label: "运行详情", showArrow: false, children:
        <div className="wand-team-run-body" inert={!open}>
          <div className="wand-team-run-inner">
            {open && detail?.run.id === run.id
              ? <TeamRunView detail={detail} onChange={(next) => {
                  if (!alive.current || next.run.id !== selectedRun.current) return;
                  requestGeneration.current++;
                  setDetail((previous) => mergeTeamChatDetail(previous, next));
                }} onOpenSession={onOpenSession}/>
              : open ? <Typography.Text type="secondary">正在加载…</Typography.Text> : null}
          </div>
        </div> }]}/>
        </Card>
      </List.Item>;
    }}
  />;
}

import { EmployeeListPage } from "../agents/employee-list-page.js";

const DETAIL_TABS = [
  { value: "members", label: "成员与设置" },
  { value: "runs", label: "运行记录" },
];

const FILTER_TABS = [
  { value: "all", label: "全部" },
  { value: "running", label: "运行中" },
  { value: "attention", label: "待你处理" },
];

const PAGE_MODE_TABS = [
  { value: "employees", label: "员工" },
  { value: "teams", label: "团队模板" },
];

export interface AiTeamsPageProps {
  sidebarOpen?: boolean;
  onBack?(): void;
  onOpenSidebar?(): void;
  onOpenSession?(sessionId: string): void;
}

/**
 * AI 团队页：侧栏「AI 团队」进入。左边团队列表（搜索、按运行状态筛选），
 * 右边是选中团队的成员组织图、协作设置与运行记录；新建从模板开始。
 */
export function AiTeamsPage({ sidebarOpen = false, onBack, onOpenSidebar, onOpenSession }: AiTeamsPageProps): React.ReactElement {
  const teamRoute = React.useSyncExternalStore(taskBoardStore.subscribe, taskBoardStore.getSnapshot, taskBoardStore.getSnapshot);
  const usage = useProviderUsage(true);
  const providerOptions: ProviderOptions = usage === null ? null : sortProviderOptions(
    ISSUE_AGENT_PROVIDERS, usage, (entry) => entry.value,
  ).map((entry) => ({ value: entry.value, label: entry.label }));
  const [teams, setTeams] = React.useState<AiTeam[] | null>(null);
  const [pageMode, setPageMode] = React.useState<"employees" | "teams">("employees");
  const [runs, setRuns] = React.useState<AiTeamRunSummary[]>([]);
  const [loadError, setLoadError] = React.useState("");
  const [teamsLoading, setTeamsLoading] = React.useState(true);
  const [catalog, setCatalog] = React.useState<IssueModelCatalog | null>(null);
  const [defaultAgent, setDefaultAgent] = React.useState<WandTaskAgent>(() => createDefaultIssueAgent());
  const [selectedId, setSelectedId] = React.useState("");
  const [template, setTemplate] = React.useState<TeamTemplate | null>(null);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<TeamFilter>("all");
  const [detailTab, setDetailTab] = React.useState("members");
  const [projects, setProjects] = React.useState<IssueWorkspace[]>([]);
  const [projectsLoaded, setProjectsLoaded] = React.useState(false);
  const [focusRunId, setFocusRunId] = React.useState("");
  const [dispatchOpen, setDispatchOpen] = React.useState(false);
  const [dispatchBusy, setDispatchBusy] = React.useState(false);

  React.useEffect(() => {
    if (teamRoute.page !== "teams" || !teamRoute.teamId) return;
    setPageMode("teams");
    setSelectedId(window.matchMedia("(max-width: 760px)").matches ? "" : teamRoute.teamId);
  }, [teamRoute.page, teamRoute.teamId, teamRoute.revision]);

  const loadTeams = React.useCallback(async () => {
    setTeamsLoading(true);
    try {
      const list = await aiTeamsRepository.list();
      setTeams(list);
      setLoadError("");
      setSelectedId((current) => current || (window.matchMedia("(max-width: 760px)").matches ? "" : list[0]?.id ?? ""));
    } catch (cause) {
      setLoadError(failureMessage(cause, "团队模板加载失败。"));
    } finally {
      setTeamsLoading(false);
    }
  }, []);

  const loadRuns = React.useCallback(async () => {
    try {
      setRuns(await aiTeamsRepository.runs({ limit: 200 }));
    } catch {
      // 运行记录拉取失败不挡团队编辑，下一条通知会再试。
    }
  }, []);

  React.useEffect(() => {
    void loadTeams();
    void loadRuns();
    void taskBoardRepository.models()
      .then((payload) => setCatalog(normalizeIssueModelCatalog(payload)))
      .catch(() => setCatalog(null));
    void taskBoardRepository.agentDefaults().then(setDefaultAgent).catch(() => undefined);
    // 「直接开工」的项目候选：每次进页面拉一次，新建项目后回到团队页就能看到。
    void taskBoardRepository.workspaces()
      .then((list) => {
        setProjects(list);
        setProjectsLoaded(true);
      })
      .catch(() => setProjectsLoaded(true));
    return subscribeWandModelCatalog(setCatalog);
  }, [loadRuns, loadTeams]);

  React.useEffect(() => subscribeAiTeamRunChanges(() => void loadRuns()), [loadRuns]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true'], [role='dialog']")) return;
      if (pageMode === "teams" && selectedId) {
        // 和面包屑返回同一条路：脏草稿先问，取消就不离开（这里在 handler 里取，
        // 不放依赖数组——leaveDetail 是后声明的 const，渲染期取值会踩 TDZ）。
        void leaveDetail();
        return;
      }
      onBack ? onBack() : taskBoardController.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack, pageMode, selectedId]);

  const runsOf = (teamId: string): AiTeamRunSummary[] => runs.filter((run) => run.teamId === teamId);
  const teamState = (teamId: string): TeamFilter | "idle" => {
    const own = runsOf(teamId);
    if (own.some((run) => ATTENTION.includes(run.status))) return "attention";
    if (own.some((run) => run.status === "running")) return "running";
    return "idle";
  };
  const needle = query.trim().toLowerCase();
  const visible = (teams ?? []).filter((team) => {
    if (filter !== "all" && teamState(team.id) !== filter) return false;
    if (!needle) return true;
    return [team.name, team.description, ...team.members.map((member) => member.name)]
      .some((value) => value.toLowerCase().includes(needle));
  });
  const selected = teams?.find((team) => team.id === selectedId) ?? null;
  const creating = selectedId === NEW_TEAM;
  const detailOpen = pageMode === "teams" && (creating || !!selected);

  // 「新建团队」和换人、面包屑返回是同一件事：详情面板按 selectedId 挂 key，
  // 换过去就把正在编辑的编辑器整个卸载。所以这里也先走同一套确认（脏才弹，不脏零打扰）。
  const startCreate = async (): Promise<void> => {
    if (!await confirmDiscardTeamDraft()) return;
    teamDraftDirty.current = false;
    setTemplate(null);
    setSelectedId(NEW_TEAM);
  };

  // 编辑器只上报一个布尔，宿主用 ref 接：不因为每次击键重渲染整个页面。
  const teamDraftDirty = React.useRef(false);
  const teamDraftPending = React.useRef(false);
  const onTeamDraftDirtyChange = React.useCallback((dirty: boolean, pending: boolean): void => {
    teamDraftDirty.current = dirty;
    teamDraftPending.current = pending;
  }, []);

  /**
   * 离开详情 / 换模板前的同一套确认（对齐 `confirmDiscardTaskDraft` 的形状：
   * 默认继续编辑、危险动作才丢弃）。文案说明会丢什么，因为这里丢的是已存在团队的
   * 未保存修改，不是新建任务草稿。取消（含关掉浮层）一律不丢。
   */
  const confirmDiscardTeamDraft = async (): Promise<boolean> => {
    if (teamDraftPending.current) return false;
    if (!teamDraftDirty.current) return true;
    const answer = await wandOverlay.dialog({
      title: "放弃未保存的团队模板改动？",
      description: "名称、成员和各自的 CLI / 模型 / 执行模式改动还没保存，离开后回到上次保存的内容。",
      actions: [
        { label: "继续编辑", value: false, autoFocus: true },
        { label: "放弃改动", value: true, kind: "danger" },
      ],
    });
    return answer.dismissed === false && answer.action === true;
  };

  const leaveDetail = async (): Promise<void> => {
    if (!await confirmDiscardTeamDraft()) return;
    teamDraftDirty.current = false;
    setSelectedId("");
  };

  // 左侧列表换人和面包屑返回是同一件事：详情面板按 selectedId 挂 key，换过去就把
  // 未保存的编辑器整个卸载，所以走同一个确认。不脏直接放行，确认后立刻切，不插 loading。
  const selectTeam = async (teamId: string): Promise<void> => {
    if (teamId === selectedId) return;
    if (!await confirmDiscardTeamDraft()) return;
    teamDraftDirty.current = false;
    setSelectedId(teamId);
  };

  const backToTemplates = async (): Promise<void> => {
    if (!await confirmDiscardTeamDraft()) return;
    teamDraftDirty.current = false;
    setTemplate(null);
  };

  /**
   * 开工成功后的落点（§5.1 修正 B8）。
   * 首选 (a)：拿回包里的群聊会话 id 交给 shell 选中会话——服务端在建运行时就同步
   * 开好了那个 relay 会话，所以正常路径下 `chatSessionId` 一定有值。
   * 兜底 (b)：万一没有会话 id（会话创建失败但运行已存在），就地切到「团队详情 -
   * 运行记录」并展开这一条运行，不静默留在列表上。
   */
  const afterDirectRun = (teamId: string, started: AiTeamDirectRun): void => {
    void loadRuns();
    const sessionId = started.run.chatSessionId;
    if (sessionId && onOpenSession) {
      onOpenSession(sessionId);
      return;
    }
    setFocusRunId(started.run.id);
    setSelectedId(teamId);
    setDetailTab("runs");
  };

  return <Flex component="section" vertical className="task-board-native-page wand-teams-page" aria-label="员工与团队模板" style={{ position: "absolute", inset: 0, zIndex: 8, overflow: "hidden", minWidth: 0, minHeight: 0, background: "var(--bg-primary)" }} data-detail={detailOpen || undefined}>
    <Flex component="header" wrap align="center" justify="space-between" gap="small" className="task-board-workspace-header" style={{ flexShrink: 0, padding: 16 }}>
      <Flex align="center" gap="small" className="task-board-kicker" style={{ minWidth: 0 }}>
        {onOpenSidebar ? <WandIconButton
          className="task-board-icon-button"
          aria-label={sidebarOpen ? "关闭任务列表" : "打开任务"}
          onClick={onOpenSidebar}
        >
          <SidebarToggleIcon open={sidebarOpen} size={16}/>
        </WandIconButton> : null}
        {pageMode === "employees" || !selected ? <WandIconButton
          className="task-board-icon-button"
          aria-label="返回工作区"
          title="返回工作区"
          onClick={() => onBack ? onBack() : taskBoardController.close()}
        >
          <WandIcon name="chevronLeft"/>
        </WandIconButton> : null}
        <div className="task-board-heading-copy">
          {pageMode === "teams" && selected ? <WandBreadcrumb
            variant="title"
            ariaLabel="团队模板导航"
            items={[
              { label: "团队模板", onNavigate: () => { void leaveDetail(); } },
              { label: selected.name },
            ]}
          /> : <>
            <Typography.Title level={3} style={{ margin: 0 }}>{pageMode === "employees" ? "员工" : "团队模板"}</Typography.Title>
            <Typography.Paragraph type="secondary" style={{ margin: 0 }}>{pageMode === "employees" ? "设置员工的职责与工具，再从通讯录发起对话。" : "保存成员与协作规则，用于发起群聊或直接开工。"}</Typography.Paragraph>
          </>}
        </div>
      </Flex>
      <Flex wrap align="center" gap="small" className="task-board-header-actions">
        <WandStretchTabs
          tabs={PAGE_MODE_TABS}
          value={pageMode}
          ariaLabel="切换员工或团队模板"
          onValueChange={(val) => {
            void confirmDiscardTeamDraft().then((allowed) => {
              if (allowed) {
                teamDraftDirty.current = false;
                // 离开团队页就收起派工面板：回来时要从收起态重新展开，不带上次的草稿状态。
                setDispatchOpen(false);
                setPageMode(val as "employees" | "teams");
              }
            });
          }}
        />
        {pageMode === "teams" ? (
          <>
            <TeamDispatchTrigger
              open={dispatchOpen}
              busy={dispatchBusy}
              onToggle={() => setDispatchOpen((current) => !current)}
            />
            <WandButton
              className="task-board-create-button"
              kind="primary"
              size="small"
              aria-pressed={creating}
              onClick={() => (creating ? void leaveDetail() : void startCreate())}
            >
              <WandIcon name="plus" slot="start" className="wand-teams-create-icon"/>
              <span>新建团队模板</span>
            </WandButton>
          </>
        ) : null}
      </Flex>
    </Flex>
    {/* 面板在页头下方原位长出：入口按钮留在页头，不把页头拉宽、不把按钮挤走。 */}
    {pageMode === "teams" ? <TeamDispatchPanel
      open={dispatchOpen}
      onOpenChange={setDispatchOpen}
      onBusyChange={setDispatchBusy}
      projects={projects}
      projectsLoaded={projectsLoaded}
      onStarted={(started) => afterDirectRun(started.teamId, started)}
    /> : null}
    {pageMode === "employees" ? (
      <div className="wand-teams-layout wand-employees-layout" style={{ width: "100%", minWidth: 0 }}>
        <EmployeeListPage catalog={catalog} providerOptions={providerOptions} />
      </div>
    ) : (
    <div className="wand-teams-layout">
      <aside className="wand-teams-list" aria-label="团队模板列表">
        <WandSearchField value={query} onValueChange={setQuery} label="搜索团队模板或成员"/>
        <WandStretchTabs
          tabs={FILTER_TABS}
          value={filter}
          ariaLabel="按状态筛选"
          onValueChange={(value) => setFilter(value as TeamFilter)}
        />
        {loadError ? <Alert
          className="task-board-native-banner"
          type="error"
          showIcon
          role="alert"
          title={loadError}
          action={<WandButton kind="ghost" size="small" disabled={teamsLoading} onClick={() => void loadTeams()}>重新加载团队模板</WandButton>}
        /> : null}
        {teamsLoading ? <Typography.Paragraph type="secondary" role="status">正在读取团队模板…</Typography.Paragraph> : null}
        <Flex vertical gap={6} className="wand-teams-cards">
          {visible.map((team) => {
            const state = teamState(team.id);
            const providers = [...new Set(team.members.map((member) => member.agent.provider))];
            return <div key={team.id}>
              <Card
                size="small"
                hoverable
                className="wand-teams-card"
                role="button"
                tabIndex={0}
                aria-pressed={selectedId === team.id}
                data-state={state}
                onClick={() => { void selectTeam(team.id); }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  void selectTeam(team.id);
                }}
              >
                <Flex vertical gap={2} className="wand-teams-card-copy" style={{ minWidth: 0 }}>
                  <Flex align="center" gap={8} className="wand-teams-card-identity">
                    <span className="wand-teams-avatar-wrap"><TeamAvatarStack members={team.members} max={2}/></span>
                    <Typography.Text strong ellipsis title={team.name}>{team.name}</Typography.Text>
                  </Flex>
                  <Typography.Text type="secondary" ellipsis title={team.description || leaderFirst(team.members).map((member) => member.name).join(" · ")}>{team.description || leaderFirst(team.members).map((member) => member.name).join(" · ")}</Typography.Text>
                </Flex>
                <Flex className="wand-teams-card-meta">
                  <Typography.Text type="secondary" ellipsis>{team.members.length} 人 · {providers.map(issueAgentProviderLabel).join(" / ")}</Typography.Text>
                  {state !== "idle" ? <Typography.Text className="wand-teams-card-status" type="secondary">{state === "running" ? "运行中" : "待处理"}</Typography.Text> : null}
                </Flex>
              </Card>
              <TeamStartRow
                teamId={team.id}
                teamName={team.name}
                projects={projects}
                projectsLoaded={projectsLoaded}
                openRequest={teamRoute.teamId === team.id ? teamRoute.revision : 0}
                onStarted={(started) => afterDirectRun(team.id, started)}
              />
            </div>;
          })}
          {!teamsLoading && !loadError && teams !== null && visible.length === 0 ? <Empty
            className="wand-teams-empty"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={teams.length === 0 ? "还没有团队模板。" : "没有匹配的团队模板。"}
          >
            {teams.length === 0 ? <WandButton kind="soft" size="small" onClick={() => { void startCreate(); }}>从模板创建</WandButton> : null}
          </Empty> : null}
        </Flex>
      </aside>
      <div className="wand-teams-detail" key={creating ? `new-${template?.id ?? ""}` : selectedId}>
        {creating && !template ? <Flex vertical gap={12} className="wand-teams-templates">
          <Flex className="wand-team-section-head" justify="space-between" align="baseline" gap={8} wrap>
            <Typography.Title level={5} style={{ margin: 0 }}>从模板开始</Typography.Title>
            <Typography.Text type="secondary">创建前还能修改</Typography.Text>
          </Flex>
          <div className="wand-teams-template-grid">
            {TEMPLATES.map((entry) => {
              const preview = templateInput(entry, defaultAgent);
              return <Card
                key={entry.id}
                size="small"
                hoverable
                className="wand-teams-template"
                role="button"
                tabIndex={0}
                onClick={() => setTemplate(entry)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  setTemplate(entry);
                }}
              >
                <TeamAvatarStack members={preview.members} size="md"/>
                <Flex vertical gap={6}>
                  <Typography.Text strong>{entry.name}</Typography.Text>
                  <Typography.Text type="secondary">{entry.summary}</Typography.Text>
                </Flex>
              </Card>;
            })}
          </div>
        </Flex> : creating && template ? <>
          <Flex className="wand-teams-detail-head" align="center" gap={12} wrap>
            <WandIconButton className="task-board-icon-button" aria-label="换一个模板" onClick={() => { void backToTemplates(); }}>
              <WandIcon name="chevronLeft"/>
            </WandIconButton>
            <div>
              <Typography.Title level={4} style={{ margin: 0 }}>新建团队模板</Typography.Title>
              <Typography.Text type="secondary">模板：{template.name}</Typography.Text>
            </div>
          </Flex>
          <TeamEditor
            team={null}
            initial={templateInput(template, defaultAgent)}
            catalog={catalog}
            providerOptions={providerOptions}
            defaultAgent={defaultAgent}
            onDirtyChange={onTeamDraftDirtyChange}
            onSaved={(team) => {
              setTeams((current) => [team, ...(current ?? [])]);
              setSelectedId(team.id);
              setDetailTab("members");
            }}
            onDeleted={() => undefined}
          />
        </> : selected ? <>
          <Flex className="wand-teams-detail-head" align="center" gap={12} wrap>
            <TeamAvatarStack members={selected.members} size="md" max={6}/>
            <Typography.Text type="secondary">{selected.description || `${selected.members.length} 位成员`}</Typography.Text>
          </Flex>
          <Tabs activeKey={detailTab} onChange={setDetailTab} destroyOnHidden={false}
            items={DETAIL_TABS.map((tab) => ({ key: tab.value, label: tab.label, forceRender: true, children:
              <div className="wand-teams-detail-pane" data-hidden={detailTab !== tab.value || undefined} inert={detailTab !== tab.value}>
              {tab.value === "runs" ? <TeamRuns
                runs={teams === null ? null : runsOf(selected.id)}
                focusRunId={focusRunId}
                onOpenSession={onOpenSession}
              /> : <TeamEditor
                  key={selected.id}
                  active={detailTab === "members"}
                  team={selected}
                  initial={inputOf(selected)}
                  catalog={catalog}
                  providerOptions={providerOptions}
                  defaultAgent={defaultAgent}
                  onDirtyChange={onTeamDraftDirtyChange}
                  onSaved={(saved) => setTeams((current) => (current ?? []).map((item) => item.id === saved.id ? saved : item))}
                  onDeleted={(id) => {
                    teamDraftDirty.current = false;
                    setSelectedId("");
                    setTeams((current) => (current ?? []).filter((item) => item.id !== id));
                  }}
                />}
              </div> }))}/>
        </> : <Empty
          className="wand-teams-empty is-detail"
          image={<WandIcon name="parallel" size={28}/>}
          description={teamsLoading && !teams ? "正在读取团队模板…" : loadError && !teams ? "请先重新加载团队模板。" : "选一个团队模板，或新建一个。"}
        />}
      </div>
    </div>
    )}
  </Flex>;
}
