import * as React from "react";
import { Alert, Card, Flex, InputNumber, Switch, Typography } from "antd";
import type { SiliconEmployee } from "../../../ai-team-types";
import type { WandTaskAgent } from "../../../task-types";
import { AGENT_TOOL_OPTIONS, WAND_AGENT_TOOL_ID } from "../../provider-identity";
import { WandButton, WandDialogSurface, WandSelect, WandSkeleton } from "../ui";
import { issueAgentEffortOptions, issueAgentModelOptions, withIssueAgentTarget, type IssueModelCatalog } from "./task-board-agent";
import { taskBoardRepository, type TaskAutoFlowSettings, type TaskAutoFlowStage, type TaskAutoFlowState, type WandTaskListed } from "./task-board-repository";

const STAGES: ReadonlyArray<{ id: TaskAutoFlowStage; label: string; detail: string }> = [
  { id: "review", label: "待验收", detail: "优先独立验收" },
  { id: "doing", label: "执行中", detail: "继续实现或补证" },
  { id: "todo", label: "等待认领", detail: "认领新任务" },
];
const TOOL_OPTIONS = AGENT_TOOL_OPTIONS.filter(item => item.id !== WAND_AGENT_TOOL_ID)
  .map(item => ({ value: item.id, label: item.label }));
const PERIODS = [5, 10, 15, 30, 60, 120, 360, 720, 1440]
  .map(value => ({ value: String(value), label: value < 60 ? `每 ${value} 分钟` : `每 ${value / 60} 小时` }));
const scanResultLabel = (result: string): string => ({ accepted: "已派发", queued: "已排队", failed: "派发失败", unknown: "送达未确认" }[result] ?? result);

export function TaskAutoFlowSettingsView({ employees, catalog, tasks, onOpenTask, onOpenSession, scanShortcut, onScanShortcutConsumed }: { employees: ReadonlyArray<SiliconEmployee>; catalog: IssueModelCatalog | null; tasks: ReadonlyArray<WandTaskListed>; onOpenTask(id: string): void; onOpenSession?(id: string): void; scanShortcut?: TaskAutoFlowStage | null; onScanShortcutConsumed?(): void }): React.ReactElement {
  const [saved, setSaved] = React.useState<TaskAutoFlowState | null>(null);
  const [draft, setDraft] = React.useState<TaskAutoFlowSettings | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [runStage, setRunStage] = React.useState<TaskAutoFlowStage | null>(null);
  const [runCount, setRunCount] = React.useState(1);
  const [runError, setRunError] = React.useState("");
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");

  React.useEffect(() => {
    let active = true;
    void taskBoardRepository.autoFlow().then(state => {
      if (!active) return;
      setSaved(state);
      setDraft(state.settings);
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : "巡检设置读取失败。");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  React.useEffect(() => {
    if (!scanShortcut || loading) return;
    setRunCount(1);
    setRunError("");
    setRunStage(scanShortcut);
    onScanShortcutConsumed?.();
  }, [scanShortcut, loading, onScanShortcutConsumed]);

  const updateStage = (stage: TaskAutoFlowStage, patch: Partial<TaskAutoFlowSettings["stages"][TaskAutoFlowStage]>): void => {
    setDraft(current => current ? { ...current, stages: { ...current.stages, [stage]: { ...current.stages[stage], ...patch } } } : current);
    setNotice("");
  };
  const save = async (): Promise<void> => {
    if (!draft || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const state = await taskBoardRepository.saveAutoFlow(draft);
      setSaved(state);
      setDraft(state.settings);
      setNotice("巡检设置已保存；后续扫描按新配置执行。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "巡检设置保存失败，请刷新核对。");
    } finally { setSaving(false); }
  };
  const refresh = async (): Promise<void> => {
    try {
      const state = await taskBoardRepository.autoFlow();
      setSaved(state);
      setDraft(current => current && JSON.stringify(current) !== JSON.stringify(saved?.settings) ? current : state.settings);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "巡检日志刷新失败。"); }
  };
  const runOnce = async (stage?: TaskAutoFlowStage, count = 1): Promise<void> => {
    if (!saved || running) return;
    setRunning(true);
    setError("");
    setRunError("");
    setNotice("");
    try {
      const state = await taskBoardRepository.runAutoFlow(saved.lastScan?.at ?? null, stage, count);
      setSaved(state);
      setRunStage(null);
      setNotice(`巡检已运行：实际派发 ${state.lastScan?.dispatchedTaskIds?.length ?? 0} 项。`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "巡检结果未确认，请刷新日志后核对。";
      if (stage) setRunError(message); else setError(message);
    } finally { setRunning(false); }
  };

  if (loading) return <WandSkeleton className="task-board-skeleton"/>;
  if (!draft) return <Alert type="error" showIcon title={error || "巡检设置不可用"}
    action={<WandButton onClick={() => window.location.reload()}>重新加载</WandButton>}/>;

  const available = employees.filter(employee => !employee.archivedAt);
  const employeeOptions = available.map(employee => ({ value: employee.id, label: employee.name }));
  const invalid = STAGES.some(({ id }) => !draft.stages[id].employeeId || !draft.stages[id].agent);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved?.settings);

  return <section className="task-auto-flow-settings" aria-label="自动巡检设置">
    <Flex wrap align="start" justify="space-between" gap="middle" className="task-auto-flow-intro">
      <div><Typography.Title level={3}>自动巡检</Typography.Title>
        <Typography.Text type="secondary">定期巡检按待验收、执行中、等待认领的顺序，每阶段最多派发 3 项，每轮最多 9 项；超过员工并发上限的任务排队，验收失败的任务优先进入修复与复验循环。</Typography.Text></div>
      <Flex align="center" gap="small"><span>启用自动巡检</span><Switch aria-label="启用自动巡检" checked={draft.enabled}
        onChange={enabled => { setDraft({ ...draft, enabled }); setNotice(""); }}/></Flex>
    </Flex>
    <Card className="task-auto-flow-card">
      <Flex wrap align="center" justify="space-between" gap="middle" className="task-auto-flow-period">
        <div><strong>巡检周期</strong><br/><Typography.Text type="secondary">运行、排队、审批及未知送达的任务保持原状；外部阻塞跳过，累计三轮验收失败后暂停自动修复。</Typography.Text></div>
        <WandSelect ariaLabel="巡检周期" value={String(draft.intervalMinutes)} options={PERIODS}
          onValueChange={value => { setDraft({ ...draft, intervalMinutes: Number(value) }); setNotice(""); }}/>
      </Flex>
      <div className="task-auto-flow-stage-grid task-auto-flow-stage-heading" aria-hidden="true"><span>阶段</span><span>员工</span><span>CLI 工具</span><span>模型</span><span>思考深度</span><span>单独巡检</span></div>
      {STAGES.map(stage => {
        const choice = draft.stages[stage.id];
        const agent = choice.agent;
        const models = agent ? [...issueAgentModelOptions(catalog, agent.provider)] : [];
        if (agent?.model && !models.some(item => item.value === agent.model)) models.push({ value: agent.model, label: `${agent.model}（已保存）` });
        return <div className="task-auto-flow-stage-grid" key={stage.id}>
          <div className="task-auto-flow-stage-name"><strong>{stage.label}</strong><small>{stage.detail}</small></div>
          <div className="task-auto-flow-field"><span className="task-auto-flow-field-label">员工</span><WandSelect ariaLabel={`${stage.label}员工`} value={choice.employeeId} options={employeeOptions}
            searchable searchPlaceholder="搜索员工" onValueChange={employeeId => {
              const selected = available.find(item => item.id === employeeId);
              updateStage(stage.id, { employeeId, agent: selected?.agents[0] ?? null });
            }}/></div>
          <div className="task-auto-flow-field"><span className="task-auto-flow-field-label">CLI 工具</span><WandSelect ariaLabel={`${stage.label} CLI 工具`} value={agent ? agent.provider : ""} options={TOOL_OPTIONS}
            disabled={!agent} onValueChange={tool => updateStage(stage.id, { agent: { ...withIssueAgentTarget(agent!, tool, catalog), kind: "structured" } })}/></div>
          <div className="task-auto-flow-field"><span className="task-auto-flow-field-label">模型</span><WandSelect ariaLabel={`${stage.label}模型`} value={agent?.model ?? ""} options={models}
            searchable searchPlaceholder="搜索模型" disabled={!agent} onValueChange={model => updateStage(stage.id, { agent: { ...agent!, model } })}/></div>
          <div className="task-auto-flow-field"><span className="task-auto-flow-field-label">思考深度</span><WandSelect ariaLabel={`${stage.label}思考深度`} value={agent?.thinkingEffort ?? ""}
            options={agent ? issueAgentEffortOptions(agent.provider, catalog, agent.model, agent.thinkingEffort) : []}
            disabled={!agent} onValueChange={thinkingEffort => updateStage(stage.id, { agent: { ...agent!, thinkingEffort: thinkingEffort as WandTaskAgent["thinkingEffort"] } })}/></div>
          <WandButton size="small" disabled={dirty || invalid || running || saving} onClick={() => { setRunCount(1); setRunError(""); setRunStage(stage.id); }}>巡检{stage.label}</WandButton>
        </div>;
      })}
      <div className="task-auto-flow-status" role="status">{saved?.lastScan
        ? <>上次巡检 {new Date(saved.lastScan.at).toLocaleString()} · {saved.lastScan.stage ? `${STAGES.find(item => item.id === saved.lastScan?.stage)?.label} · ` : ""}{scanResultLabel(saved.lastScan.result)}{saved.lastScan.taskId ? <> · <WandButton kind="ghost" size="small" onClick={() => onOpenTask(saved.lastScan!.taskId!)}>{tasks.find(item => item.id === saved.lastScan?.taskId)?.identifier ?? "查看任务"}</WandButton></> : null}</>
        : "尚未运行巡检"}</div>
    </Card>
    {invalid && <Alert type="warning" showIcon title="有阶段缺少员工或执行候选，请选择可用配置后保存。"/>}
    {error && <Alert type="error" showIcon title={error}/>}
    {notice && <Alert type="success" showIcon title={notice}/>}
    <Flex wrap justify="end" gap="small"><WandButton disabled={dirty || invalid || saving || running} onClick={() => void runOnce()}>{running ? "巡检中…" : "按优先级巡检 1 项"}</WandButton>
      <WandButton disabled={!dirty || saving || running} onClick={() => { setDraft(saved!.settings); setError(""); setNotice(""); }}>取消修改</WandButton>
      <WandButton kind="primary" disabled={!dirty || invalid || saving || running} onClick={() => void save()}>{saving ? "保存中…" : "保存巡检设置"}</WandButton></Flex>
    <Card title="最近手动巡检" extra={<WandButton size="small" disabled={running} onClick={() => void refresh()}>刷新日志</WandButton>} className="task-auto-flow-log">
      {!saved?.history?.length ? <Typography.Text type="secondary">还没有手动巡检记录。</Typography.Text> : saved.history.map(log => <div className="task-auto-flow-log-entry" key={log.at}>
        <Flex wrap justify="space-between" gap="small"><strong>{log.stage ? STAGES.find(item => item.id === log.stage)?.label : "按优先级"} · {new Date(log.at).toLocaleString()}</strong>
          <span>实际派发 {log.dispatchedTaskIds?.length ?? 0} / 最多 {log.requestedCount ?? 1} 项</span></Flex>
        {!log.dispatches.length ? <Typography.Text type="secondary">{scanResultLabel(log.result)}</Typography.Text> : log.dispatches.map(item => <Flex wrap align="center" justify="space-between" gap="small" className="task-auto-flow-log-task" key={item.commentId}>
          <WandButton kind="ghost" size="small" onClick={() => onOpenTask(item.taskId)}>{item.taskIdentifier}</WandButton>
          <span>{scanResultLabel(item.state)}</span>
          {item.sessionId ? <WandButton size="small" onClick={() => onOpenSession?.(item.sessionId!)} disabled={!onOpenSession}>进入会话</WandButton>
            : <Typography.Text type="secondary">{item.state === "queued" ? "排队中，暂无会话" : "会话尚未建立"}</Typography.Text>}
        </Flex>)}
      </div>)}
    </Card>
    <WandDialogSurface open={runStage !== null} title={`巡检${STAGES.find(item => item.id === runStage)?.label ?? "阶段"}`}
      description="只处理本阶段符合条件的任务；运行、排队、阻塞、未知送达和活动父子任务会跳过。实际派发数可能少于上限。"
      onOpenChange={open => { if (!open && !running) setRunStage(null); }}>
      <Flex vertical gap="middle">
        <Flex align="center" gap="small"><span>本次最多派发</span><InputNumber aria-label="本次最多派发任务数" min={1} max={20} precision={0} value={runCount}
          onChange={value => setRunCount(typeof value === "number" ? value : 1)}/><span>项</span></Flex>
        {runError && <Alert type="error" showIcon title={runError}/>}
        <Flex justify="end" gap="small"><WandButton disabled={running} onClick={() => setRunStage(null)}>取消</WandButton>
          <WandButton kind="primary" disabled={running || runCount < 1 || runCount > 20} onClick={() => { if (runStage) void runOnce(runStage, runCount); }}>{running ? "巡检中…" : "确认巡检"}</WandButton></Flex>
      </Flex>
    </WandDialogSurface>
  </section>;
}
