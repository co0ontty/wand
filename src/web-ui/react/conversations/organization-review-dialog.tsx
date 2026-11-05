import * as React from "react";
import { Alert, Checkbox, Flex, Progress, Skeleton, Typography } from "antd";
import type { ConversationOrganizationJob, ConversationOrganizationPreview, OrganizationChoice } from "../../../conversation-organize-contract";
import { requestJson } from "../http-adapter";
import { WandButton, WandIcon, WandInput, WandSelect } from "../ui";
import { WandDialogSurface } from "../ui/dialog";
import { OrganizationSessionPreview } from "./organization-session-preview";
import { conversationUi } from "./state";
import { issueStatusLabel } from "../issues/task-board-agent";
import type { WandTaskStatus } from "../../../task-types";

const base = "/api/sessions/auto-organize";
const post = <T,>(url: string, body: unknown) => requestJson<T>(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const organizationStatus = (status: string) => issueStatusLabel(status as WandTaskStatus);

export default function OrganizationReviewDialog({ directory, sessionIds, onClose, onChanged }: {
  directory: string; sessionIds: string[]; onClose(): void; onChanged(): void;
}) {
  const key = `wand.organization.review:${directory}`;
  const [source, setSource] = React.useState<string | null>(null);
  const [job, setJob] = React.useState<ConversationOrganizationJob | null>(null);
  const [preview, setPreview] = React.useState<ConversationOrganizationPreview | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [choices, setChoices] = React.useState<Record<string, OrganizationChoice>>({});
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const lock = React.useRef(false);
  const mounted = React.useRef(true);
  const submitted = React.useRef<string | null>(null);
  const read = (value: ConversationOrganizationJob) => {
    setJob(value);
    try { sessionStorage.setItem(key, value.id); } catch { /* optional recovery */ }
  };
  const prepare = async () => {
    setLoading(true); setError("");
    try {
      const result = await post<{ preview: ConversationOrganizationPreview }>(base, { action: "preview", review: true, mode: "all", sessionIds });
      if (mounted.current) {
        if (result.preview.activeJobId) { const active = await requestJson<{ job: ConversationOrganizationJob }>(`${base}/${result.preview.activeJobId}`); if (mounted.current) read(active.job); }
        else setPreview(result.preview);
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "无法读取会话。"); }
    finally { if (mounted.current) setLoading(false); }
  };
  React.useEffect(() => {
    mounted.current = true;
    let saved: string | null = null;
    try { saved = sessionStorage.getItem(key); } catch { /* optional recovery */ }
    if (saved) void requestJson<{ job: ConversationOrganizationJob }>(`${base}/${encodeURIComponent(saved)}`).then(result => {
      if (mounted.current) { read(result.job); setLoading(false); }
    }).catch(() => { if (mounted.current) void prepare(); });
    else void prepare();
    return () => { mounted.current = false; };
  }, []);
  React.useEffect(() => {
    if (job?.status !== "running") return;
    const abort = new AbortController();
    const timer = window.setInterval(() => {
      void requestJson<{ job: ConversationOrganizationJob }>(`${base}/${job.id}`, { signal: abort.signal }).then(result => { if (!abort.signal.aborted) { read(result.job); setError(""); } })
        .catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "查询失败，将继续查询原作业。"); });
    }, 1800);
    return () => { abort.abort(); clearInterval(timer); };
  }, [job?.id, job?.status]);
  React.useEffect(() => {
    if (job?.review?.state !== "prepared") return;
    const next: Record<string, OrganizationChoice> = {}, checked = new Set<string>();
    const historical = job.review.targets.find(target => target.title === "历史零散会话");
    for (const item of job.review.suggestions) {
      next[item.id] = { id: item.id, sessionIds: item.sessionIds, existingTaskId: item.action === "archive" ? historical?.id ?? null : item.existingTaskId,
        title: item.action === "archive" ? "历史零散会话" : item.title };
      if (item.action !== "keep") for (const id of item.sessionIds) checked.add(id);
    }
    setChoices(next); setSelected(checked);
  }, [job?.id, job?.review?.state]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await action(); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "操作未确认，请查询原结果。"); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const start = () => run(async () => {
    if (!preview || submitted.current) return;
    submitted.current = preview.token;
    try {
      const result = await post<{ job: ConversationOrganizationJob }>(base, { action: "start", token: preview.token });
      if (mounted.current) { read(result.job); setPreview(null); }
    } catch (cause) {
      // Query the same accepted token, never replay an unknown model request.
      const result = await requestJson<{ job: ConversationOrganizationJob }>(`${base}/by-token/${preview.token}`);
      if (mounted.current) read(result.job);
    }
  });
  const review = job?.review;
  const change = (id: string, patch: Partial<OrganizationChoice>) => setChoices(current => ({ ...current, [id]: { ...current[id], ...patch } }));
  const select = (ids: string[], checked: boolean) => setSelected(current => { const next = new Set(current); for (const id of ids) checked ? next.add(id) : next.delete(id); return next; });
  const selectedChoices = Object.values(choices).map(choice => ({ ...choice, sessionIds: choice.sessionIds.filter(id => selected.has(id)) })).filter(choice => choice.sessionIds.length);
  const selectedCount = selectedChoices.reduce((count, item) => count + item.sessionIds.length, 0);
  const applied = review?.state === "applied", undone = review?.state === "undone";
  const archiveCount = review?.receipt?.filter(item => item.archived).length ?? 0;
  const groupedCount = (review?.receipt?.length ?? 0) - archiveCount;
  const openOriginal = setSource;
  return <><WandDialogSurface open title="自动归类" description={`仅整理当前目录 · ${directory}`} width={780} popupOwner="organization-review" dismissable={!busy} onOpenChange={open => { if (!open) onClose(); }}>
    <div className="organization-review">
      {loading ? <Skeleton active paragraph={{ rows: 4 }}/> : null}
      {error ? <Alert type="error" showIcon title={error} role="alert"/> : null}
      {preview && !job ? <Flex vertical gap={16}>
        <Typography.Title level={5}>清理历史积压，先确认建议</Typography.Title>
        <Typography.Paragraph>读取 {preview.sessionCount} 个未分组会话，建议归入已有任务、新建任务或收纳归档。不确定的保留在未分组。</Typography.Paragraph>
        <Typography.Text type="secondary">分析使用初二当前配置，预计 {preview.estimatedModelRequests} 个模型请求。跳过 {preview.skippedSessionCount} 个不适合整理的会话。生成建议不会移动会话。</Typography.Text>
        <Flex justify="flex-end" gap={8}><WandButton onClick={onClose}>取消</WandButton><WandButton kind="primary" disabled={busy || !preview.sessionCount || !!submitted.current} onClick={() => void start()}>{busy ? "正在开始…" : "分析并生成建议"}</WandButton></Flex>
        {submitted.current && error ? <WandButton onClick={() => void run(async () => { const result = await requestJson<{ job: ConversationOrganizationJob }>(`${base}/by-token/${submitted.current}`); read(result.job); })}>查询原分析请求</WandButton> : null}
      </Flex> : null}
      {job?.status === "running" ? <Flex vertical gap={16} role="status"><Typography.Text strong>{job.stage}</Typography.Text><Progress percent={Math.round(job.processedSessions / Math.max(1, job.totalSessions) * 100)}/><Typography.Text type="secondary">可以关闭窗口，稍后从未分组卡片继续查看。</Typography.Text><WandButton disabled={busy} onClick={() => void run(async () => { const result = await post<{ job: ConversationOrganizationJob }>(`${base}/${job.id}/cancel`, {}); read(result.job); })}>取消分析</WandButton></Flex> : null}
      {job && job.status !== "running" && job.status !== "completed" ? <Alert type="warning" showIcon title="本次分析未完成" description={job.error || job.stage}/> : null}
      {review?.state === "prepared" ? <>
        <Typography.Text>已分析 {review.sessions.length} 个会话，请确认整理建议。</Typography.Text>
        <div className="organization-sections">
          {(["group", "archive", "keep"] as const).map(action => {
            const items = review.suggestions.filter(item => item.action === action), count = items.reduce((sum, item) => sum + item.sessionIds.length, 0);
            if (!count) return null;
            return <details key={action} open={action !== "keep"} className={`organization-section organization-section-${action}`}>
              <summary><WandIcon name="chevronDown" size={12}/>{action === "group" ? "归入任务" : action === "archive" ? "建议归档" : "待确认"}<span>{count}</span><small>{action === "keep" ? "归属不明确，默认保留" : action === "archive" ? "收纳历史，不代表工作完成" : "优先复用已有任务"}</small></summary>
              {items.map(item => {
                const choice = choices[item.id]; if (!choice) return null;
                const checked = item.sessionIds.filter(id => selected.has(id)).length;
                const target = review.targets.find(value => value.id === choice.existingTaskId);
                return <div className="organization-suggestion" key={item.id}>
                  <div className="organization-suggestion-title"><Checkbox aria-label={`选择${item.title}`} disabled={busy || item.action === "keep" && !choice.existingTaskId} checked={checked === item.sessionIds.length} indeterminate={checked > 0 && checked < item.sessionIds.length} onChange={event => select(item.sessionIds, event.target.checked)}/><strong>{item.action === "archive" ? "归入历史任务并归档" : item.title}</strong><span>{target ? organizationStatus(target.status) : item.action === "keep" ? "待确认" : item.action === "archive" ? "已归档 · 历史收纳" : "等待认领 · 需复核"}</span></div>
                  <p>{item.reason}</p>
                  <div className="organization-target"><WandSelect ariaLabel={`${item.title}的归属任务`} value={choice.existingTaskId ?? "new"} searchable disabled={busy}
                    options={[{ value: "new", label: item.action === "keep" ? "保留未分组" : "新建任务…" }, ...review.targets.filter(target => item.action === "archive" || target.status !== "archived").map(target => ({ value: target.id, label: `${target.title} · ${organizationStatus(target.status)}` }))]}
                    onValueChange={value => { change(item.id, { existingTaskId: value === "new" ? null : value }); if (item.action === "keep") select(item.sessionIds, value !== "new"); }}/>
                    {!choice.existingTaskId && item.action !== "keep" ? <WandInput aria-label={`${item.title}的新任务名称`} value={choice.title} maxLength={40} disabled={busy} onChange={event => change(item.id, { title: event.target.value })}/> : null}</div>
                  <details className="organization-members"><summary>查看 {item.sessionIds.length} 个会话</summary>{item.sessionIds.map(id => <div key={id}><Checkbox disabled={busy || item.action === "keep" && !choice.existingTaskId} checked={selected.has(id)} onChange={event => select([id], event.target.checked)}>{review.sessions.find(session => session.id === id)?.title || "未命名会话"}</Checkbox><WandButton kind="ghost" size="small" onClick={() => openOriginal(id)}><WandIcon name="eye" size={14}/>查看原会话</WandButton></div>)}</details>
                </div>;
              })}
            </details>;
          })}
        </div>
        <div className="organization-footer"><Typography.Text type="secondary">归档保留 Wand 历史，不代表完成或验收通过。已有任务状态保持不变。</Typography.Text><Flex gap={8}><WandButton disabled={busy} onClick={onClose}>取消</WandButton><WandButton kind="primary" disabled={busy || !selectedCount || selectedChoices.some(item => !item.title.trim())} onClick={() => void run(async () => {
          const result = await post<{ job: ConversationOrganizationJob }>(`${base}/${job!.id}/apply`, { choices: selectedChoices }); read(result.job); onChanged();
        })}>{busy ? "正在保存…" : `确认整理（${selectedCount}）`}</WandButton></Flex></div>
      </> : null}
      {applied || undone ? <Flex vertical gap={16}><Alert type="success" showIcon title={undone ? "已撤销本次整理" : `已归类 ${groupedCount} 个，已归档 ${archiveCount} 个`} description={undone ? job?.stage : `${(review?.sessions.length ?? 0) - (review?.receipt?.length ?? 0)} 个保留未分组。没有派发新的执行任务。`}/><Flex justify="flex-end" gap={8}>{applied && archiveCount ? <WandButton onClick={() => { conversationUi.listFacets({ runtime: "archived", archive: "all", activityOnly: false, taskStage: "all", workspace: conversationUi.getSnapshot().listWorkspace, employee: "all" }); onClose(); }}>查看已归档</WandButton> : null}{applied ? <WandButton disabled={busy} onClick={() => void run(async () => { const result = await post<{ job: ConversationOrganizationJob }>(`${base}/${job!.id}/undo`, {}); read(result.job); onChanged(); })}>撤销本次整理</WandButton> : null}<WandButton kind="primary" onClick={onClose}>完成</WandButton></Flex></Flex> : null}
      {job && job.status !== "running" ? <WandButton kind="ghost" disabled={busy} onClick={() => { try { sessionStorage.removeItem(key); } catch { /* optional recovery */ } setJob(null); submitted.current = null; void prepare(); }}>重新分析当前未分组会话</WandButton> : null}
      {!loading && !job && !preview && error ? <WandButton onClick={() => void prepare()}>重新读取</WandButton> : null}
    </div>
  </WandDialogSurface>{source ? <OrganizationSessionPreview id={source} title={review?.sessions.find(item => item.id === source)?.title || "原会话"} onClose={() => setSource(null)}/> : null}</>;
}
