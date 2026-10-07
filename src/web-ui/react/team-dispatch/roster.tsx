import { Alert, Checkbox, Flex, List, Radio, Tag, Typography } from "antd";
import * as React from "react";

import { AI_TEAM_MAX_MEMBERS, AI_TEAM_MIN_MEMBERS } from "../../../ai-team-types";
import {
  aiTeamsRepository,
  type AiTeamDispatchRun,
  type TeamDispatchPlan,
  type TeamDispatchPlanMember,
} from "../ai-teams/repository";
import { failureMessage } from "../errors";
import { WandButton, WandIcon } from "../ui";

/** 面板阶段：结果留在原位（不用 Toast），失败态停留更久。 */
export type TeamDispatchPhase = "idle" | "planning" | "planned" | "starting" | "started" | "failed";

/** 面板里当前的名单选择：成员集合 + 负责人（员工 id）。 */
export interface DispatchSelection {
  members: TeamDispatchPlanMember[];
  leaderId: string;
}

/** 初始选择 = 服务端建议的全员（负责人沿用服务端标记，缺省取第一位）。 */
export function initialDispatchSelection(plan: TeamDispatchPlan): DispatchSelection {
  const members = [...plan.members];
  const leader = members.find((member) => member.isLeader) ?? members[0];
  return { members, leaderId: leader?.employeeId ?? "" };
}

/** 勾选/取消一名员工；取消负责人时负责人落到剩下第一位，名单为空时清空负责人。 */
export function toggleDispatchMember(selection: DispatchSelection, member: TeamDispatchPlanMember): DispatchSelection {
  const exists = selection.members.some((item) => item.employeeId === member.employeeId);
  const members = exists
    ? selection.members.filter((item) => item.employeeId !== member.employeeId)
    : [...selection.members, member].sort((a, b) => b.probability - a.probability || a.name.localeCompare(b.name, "zh-Hans-CN"));
  if (members.length > AI_TEAM_MAX_MEMBERS) return selection;
  const leaderId = members.some((item) => item.employeeId === selection.leaderId)
    ? selection.leaderId
    : members[0]?.employeeId ?? "";
  return { members, leaderId };
}

/** 指定负责人；不在名单里的 id 不接受（UI 也只给名单内的行提供入口）。 */
export function setDispatchLeader(selection: DispatchSelection, employeeId: string): DispatchSelection {
  if (!selection.members.some((member) => member.employeeId === employeeId)) return selection;
  return { ...selection, leaderId: employeeId };
}

/** 回传服务端的形状：负责人标记只落一个人。 */
export function dispatchSelectionPayload(selection: DispatchSelection): Array<{ employeeId: string; isLeader?: boolean }> {
  return selection.members.map((member) => ({
    employeeId: member.employeeId,
    ...(member.employeeId === selection.leaderId ? { isLeader: true } : {}),
  }));
}

/**
 * 开工按钮为什么不能点：返回人类可读原因，空串表示可以开工。
 * UI 只用它拼文案与 disabled，规则本身仍然由服务端复验。
 */
export function dispatchStartBlockedReason(input: {
  selection: DispatchSelection;
  workspaceId: string;
  note: string;
  busy: boolean;
}): string {
  if (input.busy) return "正在处理…";
  if (!input.note.trim()) return "先写清这次要做什么。";
  if (!input.workspaceId) return "先选一个项目。";
  if (input.selection.members.length < AI_TEAM_MIN_MEMBERS) {
    return `团队开工至少需要 ${AI_TEAM_MIN_MEMBERS} 名员工（含负责人）。`;
  }
  return "";
}

/** 概率只作参考：展示成整数百分比，不是正确率。 */
export function dispatchProbabilityLabel(probability: number): string {
  if (!Number.isFinite(probability)) return "";
  return `${Math.round(Math.max(0, Math.min(1, probability)) * 100)}%`;
}

/** 备选行给不给“加入”入口：名单已满就不再提供。 */
export function canAddDispatchMember(selection: DispatchSelection): boolean {
  return selection.members.length < AI_TEAM_MAX_MEMBERS;
}

/** 主按钮文案：三个入口（通讯录 / 看板新建任务 / 任务详情指派）共用同一套。 */
export function dispatchPrimaryActionLabel(phase: TeamDispatchPhase, hasPlan: boolean): string {
  if (phase === "planning") return "正在判断…";
  if (phase === "starting") return "正在开工…";
  if (phase === "started") return "已开工";
  return hasPlan ? "确认开工" : "让决策模型选人";
}

export interface TeamDispatchFlow {
  phase: TeamDispatchPhase;
  plan: TeamDispatchPlan | null;
  selection: DispatchSelection;
  message: string;
  maxMembers: number;
  busy: boolean;
  hasPlan: boolean;
  updateSelection(next: DispatchSelection): void;
  updateMaxMembers(value: number): void;
  /** 换项目 / 改人数 / 改说明后，旧名单不再对应当前输入。 */
  resetResults(): void;
  planNow(note: string): Promise<void>;
  /** 确认后开工；成功返回 run，导航交给调用方。 */
  startNow(workspaceId: string, note: string): Promise<AiTeamDispatchRun | null>;
}

/**
 * 派工流程的三步都收在这里：说明 → 建议名单 → 确认开工。
 * 失败就地在位报错并在原位停留更久，错误文案只有这一份（三个入口共用）。
 */
export function useTeamDispatchFlow(initialMaxMembers = 3): TeamDispatchFlow {
  const [phase, setPhase] = React.useState<TeamDispatchPhase>("idle");
  const [plan, setPlan] = React.useState<TeamDispatchPlan | null>(null);
  const [selection, setSelection] = React.useState<DispatchSelection>({ members: [], leaderId: "" });
  const [message, setMessage] = React.useState("");
  const [maxMembers, setMaxMembers] = React.useState(initialMaxMembers);
  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);

  const busy = phase === "planning" || phase === "starting" || phase === "started";
  const hasPlan = plan !== null;

  const resetResults = React.useCallback((): void => {
    setPlan(null);
    setSelection({ members: [], leaderId: "" });
    setMessage("");
  }, []);

  const planNow = React.useCallback(async (note: string): Promise<void> => {
    const trimmed = note.trim();
    if (!trimmed || phase === "planning" || phase === "starting") return;
    setPhase("planning");
    setMessage("");
    setPlan(null);
    setSelection({ members: [], leaderId: "" });
    try {
      const planned = await aiTeamsRepository.dispatchPlan({ note: trimmed, maxMembers });
      if (!alive.current) return;
      setPlan(planned);
      setSelection(initialDispatchSelection(planned));
      setPhase("planned");
    } catch (cause) {
      if (!alive.current) return;
      setPhase("failed");
      setMessage(failureMessage(cause, "决策选人失败，请稍后再试。"));
      await aiTeamsRepository.settle("error");
      if (alive.current) setPhase("idle");
    }
  }, [maxMembers, phase]);

  const startNow = React.useCallback(async (workspaceId: string, note: string): Promise<AiTeamDispatchRun | null> => {
    const trimmed = note.trim();
    if (dispatchStartBlockedReason({ selection, workspaceId, note: trimmed, busy: false }) !== "") return null;
    if (phase === "starting") return null;
    setPhase("starting");
    setMessage("");
    try {
      const started = await aiTeamsRepository.dispatchStart({
        workspaceId,
        note: trimmed,
        members: dispatchSelectionPayload(selection),
      });
      if (!alive.current) return null;
      setPhase("started");
      setMessage("已开工，正在打开群聊…");
      await aiTeamsRepository.settle("success");
      if (alive.current) {
        setPhase("idle");
        resetResults();
      }
      return started;
    } catch (cause) {
      if (!alive.current) return null;
      setPhase("failed");
      setMessage(failureMessage(cause, "开工失败，请换个项目或稍后再试。"));
      await aiTeamsRepository.settle("error");
      if (alive.current) setPhase("idle");
      return null;
    }
  }, [phase, resetResults, selection]);

  return {
    phase,
    plan,
    selection,
    message,
    maxMembers,
    busy,
    hasPlan,
    updateSelection: setSelection,
    updateMaxMembers: (value) => setMaxMembers(Math.min(AI_TEAM_MAX_MEMBERS, Math.max(AI_TEAM_MIN_MEMBERS, value))),
    resetResults,
    planNow,
    startNow,
  };
}

/**
 * 建议名单区：人数上限（还没出名单时才显示）→ 说明 → 成员行 → 备选 → 结果。
 * 通讯录面板、看板新建任务、任务详情指派三处共用，避免各写一份会漂移的 UI。
 */
export function TeamDispatchRoster({
  flow,
  blockedReason = "",
  showMaxMembers = true,
}: {
  flow: TeamDispatchFlow;
  /** 出名单之后的禁用原因：直接显示出来，用户不必靠禁用按钮猜。 */
  blockedReason?: string;
  showMaxMembers?: boolean;
}): React.ReactElement {
  const plan = flow.plan;
  return <Flex vertical gap={12}>
    {showMaxMembers && !flow.hasPlan ? <Flex wrap align="center" gap={8}>
      <Typography.Text type="secondary">人数上限</Typography.Text>
      <Radio.Group aria-label="人数上限" value={flow.maxMembers} disabled={flow.busy}
        options={Array.from({ length: AI_TEAM_MAX_MEMBERS - AI_TEAM_MIN_MEMBERS + 1 }, (_, index) => AI_TEAM_MIN_MEMBERS + index)
          .map((value) => ({ value, label: String(value) }))}
        onChange={(event) => { flow.updateMaxMembers(event.target.value); flow.resetResults(); }}/>
    </Flex> : null}
    {flow.hasPlan && plan ? <Flex vertical gap={8}>
      <Typography.Text type="secondary" role="status">{plan.note}</Typography.Text>
      <List size="small">
        {plan.members.map((member) => <DispatchMemberRow key={member.employeeId} member={member} flow={flow}/>)}
      </List>
      {plan.bench.length > 0 ? <Flex vertical gap={6}>
        <Typography.Text type="secondary">{canAddDispatchMember(flow.selection) ? "备选（点一下加入）" : "备选（名单已满）"}</Typography.Text>
        <List size="small">
          {plan.bench.map((member) => <DispatchMemberRow key={member.employeeId} member={member} flow={flow}/>)}
        </List>
      </Flex> : null}
    </Flex> : null}
    {flow.hasPlan && blockedReason ? <Alert type="info" role="status" title={blockedReason}/> : null}
    {flow.message ? <Alert type={flow.phase === "failed" ? "error" : "info"} showIcon
      role={flow.phase === "failed" ? "alert" : "status"} title={flow.message}/> : null}
  </Flex>;
}

function DispatchMemberRow({ member, flow }: { member: TeamDispatchPlanMember; flow: TeamDispatchFlow }): React.ReactElement {
  const picked = flow.selection.members.some((item) => item.employeeId === member.employeeId);
  const isLeader = picked && flow.selection.leaderId === member.employeeId;
  const fieldId = `dispatch-member-${member.employeeId}`;
  return <List.Item data-picked={picked || undefined}>
    <Flex align="center" gap={8} wrap style={{ width: "100%" }}>
    <Checkbox
      id={fieldId}
      checked={picked}
      disabled={flow.busy}
      onChange={() => flow.updateSelection(toggleDispatchMember(flow.selection, member))}
    />
    <label htmlFor={fieldId} style={{ flex: 1, minWidth: 120 }}><Flex vertical>
      <Typography.Text strong>{member.name}</Typography.Text>
      <Typography.Text type="secondary">{member.duty || "未填写职责"}</Typography.Text>
    </Flex></label>
    <Tag title="本地决策给出的参与概率，仅作参考">{dispatchProbabilityLabel(member.probability)}</Tag>
    {picked ? <WandButton kind={isLeader ? "soft" : "ghost"}
      type="button"
      aria-pressed={isLeader}
      disabled={flow.busy}
      onClick={() => flow.updateSelection(setDispatchLeader(flow.selection, member.employeeId))}
    >{isLeader ? "负责人" : "设为负责人"}</WandButton> : null}
    </Flex>
  </List.Item>;
}

/**
 * 「让决策模型选人 / 确认开工」这一个按钮：同一个位置依次承担 选人 → 开工，
 * 加载与结果也在原位（三个入口共用，不各自拼文案）。
 */
export function TeamDispatchActionButton({
  flow,
  blockedReason,
  canPlan,
  onClick,
}: {
  flow: TeamDispatchFlow;
  /** 出名单之后才生效：确认开工的全部校验原因（含项目与人数）。 */
  blockedReason: string;
  /** 还没出名单时能不能点：只要求写清说明（人数/项目要到开工那一步才校验）。 */
  canPlan: boolean;
  /** 省略时按 submit 按钮渲染：交给宿主表单的 onSubmit 处理（看板新建任务就是这么用的）。 */
  onClick?(): void;
}): React.ReactElement {
  return <WandButton
    className="wand-dispatch-action"
    kind="primary"
    size="small"
    type={onClick ? "button" : "submit"}
    disabled={flow.busy || (flow.hasPlan ? blockedReason !== "" : !canPlan)}
    title={(flow.hasPlan ? blockedReason : "") || undefined}
    onClick={onClick}
  >
    <WandIcon name={flow.hasPlan ? "enter" : "sparkle"} slot="start"/>
    <span>{dispatchPrimaryActionLabel(flow.phase, flow.hasPlan)}</span>
  </WandButton>;
}
