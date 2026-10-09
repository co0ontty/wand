import * as React from "react";
import { Alert, Checkbox, Descriptions, Flex, List, Typography } from "antd";
import type { AiTeam, AiTeamMember, SiliconEmployee } from "../../../ai-team-types.js";
import type { ConversationSummary } from "../../../conversation-types.js";
import { useSiliconEmployees } from "../agents/employee-repository";
import { useAiTeamListState } from "../ai-teams/repository";
import { EmployeeAvatar } from "../agents/employee-avatar";
import { WandButton, WandInput, WandSelect, WandStretchTabs } from "../ui";
import { WandMultiSelect } from "../ui/multi-select";
import { MOTION_DWELL_FAILED_MS, MOTION_DWELL_SENT_MS } from "../ui/motion-tokens";
import { conversationsRepository, UnconfirmedConversationError } from "./repository";
import type { ConversationSubmitPhase } from "./controls";
import { conversationUi } from "./state";

export function PresetDetails({ team }: { team: AiTeam }): React.ReactElement {
  return <Flex vertical gap={8}>
    <List size="small" dataSource={team.members} renderItem={m => <List.Item key={m.id}>
      <Flex vertical><Typography.Text strong>{m.name}{m.isLeader ? " · 负责人" : ""}</Typography.Text>
        <Typography.Text type="secondary">{m.duty || "未填写职责"}{m.employeeId ? "" : " · 未绑定通讯录 · 既有配置"}</Typography.Text></Flex>
    </List.Item>}/>
    <Descriptions size="small" column={1} items={[
      { key: "approval", label: "首轮审批", children: team.requirePlanApproval ? "需用户批准" : "按模板自动开工" },
      { key: "steps", label: "步数上限", children: team.maxSteps },
      { key: "instructions", label: "协作指令", children: <span style={{ whiteSpace: "pre-wrap" }}>{team.instructions || "未设置"}</span> },
    ]}/>
  </Flex>;
}

export interface GroupEditorProps {
  owner: string;
  open: boolean;
  presetId?: string;
  inviteTo?: ConversationSummary;
  onCancel(): void;
  onCreated(id: string): void;
}
export function GroupEditor({ owner, open, presetId, inviteTo, onCancel, onCreated }: GroupEditorProps): React.ReactElement {
  const { employees, error: employeesError, loading: employeesLoading, reload: reloadEmployees } = useSiliconEmployees({ includeArchived: true, enabled: open });
  const teamSource = useAiTeamListState(open);
  const { teams } = teamSource;
  const [tab, setTab] = React.useState("employees");
  const [employeeIds, setEmployeeIds] = React.useState<string[]>([]);
  const [templateId, setTemplateId] = React.useState(presetId ?? "");
  const [previewId, setPreviewId] = React.useState(presetId ?? "");
  const [replaceId, setReplaceId] = React.useState("");
  const [excluded, setExcluded] = React.useState<string[]>([]);
  const [leaderId, setLeaderId] = React.useState("");
  const [name, setName] = React.useState("");
  const [duties, setDuties] = React.useState<Record<string, string>>({});
  const [phase, setPhase] = React.useState<ConversationSubmitPhase>("idle");
  const [feedback, setFeedback] = React.useState("");
  const [unknown, setUnknown] = React.useState("");
  const opened = React.useRef(open); opened.current = open;
  const context = inviteTo?.id ?? "create";
  const editEpoch = React.useRef(0);
  const confirmations = React.useRef(new Map<string, { locked: boolean; accepted: boolean }>());
  if (!confirmations.current.has(context)) confirmations.current.set(context, { locked: false, accepted: false });
  const confirmation = confirmations.current.get(context)!;
  const activeConfirmation = React.useRef(confirmation); activeConfirmation.current = confirmation;
  const wasOpen = React.useRef(false);
  const newEditing = open && !wasOpen.current && confirmation.accepted;
  if (newEditing) { confirmation.locked = false; confirmation.accepted = false; }
  React.useEffect(() => { if (newEditing) { setPhase("idle"); setFeedback(""); setUnknown(""); } }, [newEditing]);
  if (wasOpen.current && !open) editEpoch.current += 1;
  wasOpen.current = open;
  const currentContext = React.useRef(context); currentContext.current = `${context}:${editEpoch.current}`;
  React.useEffect(() => { setEmployeeIds([]); setTemplateId(""); setExcluded([]); setLeaderId(""); setName(""); setDuties({}); setPhase("idle"); setFeedback(""); setUnknown(""); }, [context]);
  React.useEffect(() => { if (presetId) { setPreviewId(presetId); setTemplateId(presetId); setExcluded([]); setEmployeeIds([]); setLeaderId(""); setTab("presets"); } }, [presetId]);
  const source = teams?.find(t => t.id === templateId);
  const allEmployees = employees ?? [];
  const currentKeys = new Set(inviteTo?.team?.members.map(m => m.employeeId ?? `${m.legacyTemplateId}:${m.legacyMemberId}`));
  const sourceMembers = source?.members.filter(m => !excluded.includes(m.id)) ?? [];
  const selectedMembers: Array<Pick<AiTeamMember, "id" | "employeeId" | "name" | "duty" | "isLeader">> = [
    ...sourceMembers,
    ...employeeIds.filter(id => !sourceMembers.some(m => m.employeeId === id)).map((id, index) => {
      const employee = allEmployees.find(e => e.id === id)!;
      return { id, employeeId: id, name: employee?.name ?? id, duty: employee?.duty ?? "", isLeader: sourceMembers.length === 0 && index === 0 };
    }),
  ];
  const additional = selectedMembers.filter(m => !currentKeys.has(m.employeeId ?? `${source?.id}:${m.id}`));
  const size = (inviteTo?.team?.members.length ?? 0) + additional.length;
  const leader = inviteTo?.team?.members.find(m => m.isLeader)?.name ?? selectedMembers.find(m =>
    leaderId ? m.id === leaderId || m.employeeId === leaderId : m.isLeader)?.name;
  const invalid = selectedMembers.some(m => m.employeeId && (!allEmployees.find(e => e.id === m.employeeId) || allEmployees.find(e => e.id === m.employeeId)?.archivedAt));
  const usePreset = (id: string): void => { setTemplateId(id); setExcluded([]); setEmployeeIds([]); setLeaderId(""); setReplaceId(""); };
  const choosePreset = (id: string): void => {
    if ((templateId && templateId !== id) || employeeIds.length) setReplaceId(id);
    else usePreset(id);
  };
  const complete = async (id: string, capturedContext: string, selectedRevision: number): Promise<void> => {
    setPhase("sent"); setFeedback(inviteTo ? "已邀请；下一次新派工生效" : "群已建立，尚未派任务");
    await new Promise(resolve => setTimeout(resolve, MOTION_DWELL_SENT_MS));
    if (opened.current && currentContext.current === capturedContext && conversationUi.selectionRevision() === selectedRevision) onCreated(id);
  };
  const submit = async (): Promise<void> => {
    if (confirmation.locked || phase === "sending" || unknown || !additional.length || size > 8 || invalid) return;
    const capturedContext = currentContext.current, selectedRevision = conversationUi.selectionRevision();
    confirmation.locked = true; // Synchronous identity lock, including success dwell and detached UI.
    setPhase("sending"); setFeedback("");
    const group = { employeeIds, templateId: templateId || undefined, excludedMemberIds: excluded,
      leaderId: inviteTo ? undefined : leaderId || undefined, name: inviteTo ? undefined : name, duties };
    try {
      const receipt = await conversationsRepository.post(inviteTo ? `/api/conversations/${encodeURIComponent(inviteTo.id)}/invitations` : "/api/conversations",
        inviteTo ? { memberVersion: inviteTo.memberVersion, group } : { group });
      confirmation.accepted = true;
      if (activeConfirmation.current !== confirmation) return;
      if (receipt.error) { setPhase("failed"); setFeedback(receipt.error); return; }
      await complete(receipt.conversationId, capturedContext, selectedRevision);
    } catch (cause) {
      if (!(cause instanceof UnconfirmedConversationError)) confirmation.locked = false;
      if (activeConfirmation.current !== confirmation) return;
      setFeedback(cause instanceof Error ? cause.message : "操作失败。");
      if (cause instanceof UnconfirmedConversationError) { setPhase("unknown"); setUnknown(cause.requestId); }
      else { setPhase("failed"); await new Promise(resolve => setTimeout(resolve, MOTION_DWELL_FAILED_MS)); if (currentContext.current === capturedContext) setPhase("idle"); }
    }
  };
  const reconcile = async (): Promise<void> => {
    const capturedContext = currentContext.current, selectedRevision = conversationUi.selectionRevision();
    try {
      const receipt = await conversationsRepository.reconcile(unknown);
      if (receipt.state === "accepted") { confirmation.accepted = true; setUnknown(""); await complete(receipt.conversationId, capturedContext, selectedRevision); }
      else if (receipt.state === "rejected") { confirmation.locked = false; setUnknown(""); setPhase("failed"); setFeedback(receipt.error || "未接受，名单保留。"); }
      else setFeedback("仍未确认，请勿重复创建/邀请。");
    } catch (cause) { setFeedback(cause instanceof Error ? cause.message : "核对失败。"); }
  };
  const preview = teams?.find(t => t.id === previewId);
  return <Flex vertical gap={8} className="conversation-group-editor" aria-label={inviteTo ? "邀请成员" : "发起群聊"}>
    <Typography.Text strong>{inviteTo ? "邀请成员" : "发起群聊"}</Typography.Text>
    <Typography.Text type="secondary">我 + {size} 位员工（最多 8 位）{inviteTo ? ` · 本群负责人保持为${leader}` : " · 本次名单调整只影响此群"}</Typography.Text>
    <WandStretchTabs value={tab} onValueChange={setTab} ariaLabel="成员来源" tabs={[{ value: "employees", label: "员工" }, { value: "presets", label: "团队模板" }]}/>
    <div className="conversation-editor-scroll">
      {tab === "employees" ? <>
        {employeesError ? <Alert type="error" showIcon role="alert" title="员工加载失败" description={employeesError}
          action={<WandButton size="small" disabled={employeesLoading} onClick={reloadEmployees}>重新加载员工</WandButton>}/> : null}
        {employeesLoading ? <Typography.Text type="secondary" role="status">正在读取员工…</Typography.Text> : null}
        <WandMultiSelect value={employeeIds} onChange={setEmployeeIds} ariaLabel="选择员工" popupOwner={owner}
          disabled={employeesLoading && !allEmployees.length}
          options={allEmployees.map(e => ({ value: e.id, label: `${e.name} · ${e.duty} · ${e.id.slice(-6)}`,
            disabled: !!e.archivedAt || currentKeys.has(e.id) || (!employeeIds.includes(e.id) && size >= 8) }))}/>
        {!employeesLoading && !employeesError && !allEmployees.length ? <Typography.Text type="secondary">还没有员工，请到员工管理创建。</Typography.Text> : null}
      </> : <>
        {teamSource.error ? <Alert type="error" showIcon role="alert" title="团队模板加载失败" description={teamSource.error}
          action={<WandButton size="small" disabled={teamSource.loading} onClick={teamSource.reload}>重新加载团队模板</WandButton>}/> : null}
        {teamSource.loading ? <Typography.Text type="secondary" role="status">正在读取团队模板…</Typography.Text> : null}
        <WandSelect value={previewId} onValueChange={setPreviewId} ariaLabel="选择团队模板" placeholder="选择一个团队模板" searchable searchPlaceholder="搜索团队模板" popupOwner={owner}
          disabled={teamSource.loading && !teams.length} options={teams.map(t => ({ value: t.id, label: `${t.name} · ${t.members.length} 位员工` }))}/>
        {preview ? <><PresetDetails team={preview}/><WandButton onClick={() => choosePreset(preview.id)}>使用这个模板</WandButton></> : !teamSource.loading && !teamSource.error ? <Typography.Text type="secondary">
          {teams.length ? previewId ? "此团队模板已不可用，请重新选择。" : "选择一个团队模板，查看成员与协作规则。" : "还没有团队模板，可以直接选择员工发起群聊。"}
        </Typography.Text> : null}
        {replaceId ? <Flex vertical gap={8}><Typography.Text>替换本次群名单？原模板不变。</Typography.Text><Flex gap={8}>
          <WandButton onClick={() => usePreset(replaceId)}>确认替换</WandButton><WandButton onClick={() => setReplaceId("")}>保留原名单</WandButton>
        </Flex></Flex> : null}
      </>}
      {selectedMembers.map(m => {
        const employee: SiliconEmployee | undefined = allEmployees.find(e => e.id === m.employeeId);
        const reason = m.employeeId ? !employee ? employeesLoading ? "正在读取员工资料…" : employeesError ? "员工资料加载失败，请重试后核对。" : "绑定员工不存在，需显式移除/替换" : employee.archivedAt ? "已归档，需显式移除/替换" : "" : "未绑定通讯录 · 既有配置";
        const selectedKey = m.employeeId ?? m.id;
        return <Flex key={m.id} vertical gap={4} style={{ paddingBlock: 8 }}>
          <Flex align="center" gap={8}>{employee ? <EmployeeAvatar employee={employee} size="sm"/> : null}<Typography.Text>{m.name}</Typography.Text>
            {source?.members.some(s => s.id === m.id) ? <Checkbox checked={!excluded.includes(m.id)} onChange={() => setExcluded([...excluded, m.id])}>保留</Checkbox> : null}
          </Flex>
          {reason ? <Typography.Text type={employee?.archivedAt || (m.employeeId && !employee) ? "danger" : "secondary"}>{reason}</Typography.Text> : null}
          <WandInput aria-label={`${m.name}本群职责`} value={duties[selectedKey] ?? m.duty}
            onChange={e => setDuties({ ...duties, [selectedKey]: e.currentTarget.value })}/>
        </Flex>;
      })}
      {!inviteTo ? <><WandSelect value={leaderId || (selectedMembers.find(m => m.isLeader)?.employeeId ?? selectedMembers.find(m => m.isLeader)?.id)}
        ariaLabel="本群负责人" popupOwner={owner} options={selectedMembers.map(m => ({ value: m.employeeId ?? m.id, label: m.name }))} onValueChange={setLeaderId}/>
        <WandInput aria-label="群名（可选）" placeholder="群名（可选，填写后任务不会覆盖）" value={name} onChange={e => setName(e.currentTarget.value)}/></> : null}
    </div>
    <div className="conversation-form-feedback" role="status" aria-live="polite">{feedback || (invalid ? "请明确处理不可用成员。" : "")}
      {unknown ? <WandButton size="small" onClick={() => void reconcile()}>核对请求</WandButton> : null}</div>
    <Flex gap={8} justify="end"><WandButton onClick={onCancel}>取消</WandButton><WandButton className="conversation-form-submit" kind="primary"
      disabled={confirmation.locked || phase === "sending" || !!unknown || !additional.length || size > 8 || invalid} onClick={() => void submit()}>
      {phase === "sending" ? "处理中" : phase === "sent" ? "已完成" : phase === "failed" ? "失败" : phase === "unknown" ? "未确认" : inviteTo ? "邀请" : "建群"}
    </WandButton></Flex>
  </Flex>;
}
