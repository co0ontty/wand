import * as React from "react";
import { Alert, Checkbox, Collapse, Empty, Flex, Pagination, Radio, Skeleton, Tag, Typography } from "antd";
import type { DingTalkBinding, DingTalkDiscoveryGroup, DingTalkJob, DingTalkPlan, DingTalkStatus } from "../../../dingtalk-types.js";
import { jsonBody, requestJson } from "../http-adapter.js";
import { useSiliconEmployees } from "../agents/employee-repository.js";
import { EmployeeAvatar } from "../agents/employee-avatar.js";
import { WandButton, WandSearchField, WandSelect } from "../ui";
import { WandMultiSelect } from "../ui/multi-select.js";
import { SettingsActionButton, SettingsField } from "./fields.js";
import { conversationUi } from "../conversations/state.js";
import { notifyConversationChanges, subscribeConversationChanges } from "../conversations/repository.js";
import { settingsController } from "./controller.js";
import { agentToolDisplayName } from "../../provider-identity.js";

const base = "/api/connectors/dingtalk";
const labels: Record<DingTalkBinding["state"], string> = { creating: "建号中", configuring: "配置中", joining: "入群中", verifying: "待群内 @验证", ready: "已接通", paused: "已暂停", restricted: "配置受限", failed: "失败", unknown: "待核实" };
type AuthAttempt = { id: string; state: "waiting" | "exchanging" | "connected" | "failed" | "cancelled"; url?: string; userCode?: string; error?: string };

/** Production connector UI. All values come from server/DWS or the employee directory; no demonstration data. */
export function DingTalkSettingsPanel({ admin, active = true }: { admin: boolean; active?: boolean }) {
  const root = React.useRef<HTMLElement>(null), alive = React.useRef(true), locked = React.useRef(false), revision = React.useRef(0), statusDirty = React.useRef(false), authEpoch = React.useRef(0);
  const [status, setStatus] = React.useState<DingTalkStatus | null>(null), [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(""), [settled, setSettled] = React.useState<{ key: string; ok: boolean } | null>(null);
  const [attempt, setAttempt] = React.useState<AuthAttempt | null>(null), [account, setAccount] = React.useState("");
  const [groups, setGroups] = React.useState<DingTalkDiscoveryGroup[]>([]), [cursor, setCursor] = React.useState("");
  const [pickedGroups, setPickedGroups] = React.useState<string[]>([]), [pickedEmployees, setPickedEmployees] = React.useState<string[]>([]);
  const [excluded, setExcluded] = React.useState<string[]>([]), [plan, setPlan] = React.useState<DingTalkPlan | null>(null), [setup, setSetup] = React.useState(false);
  const [planDirty, setPlanDirty] = React.useState(false);
  const [submitted, setSubmitted] = React.useState<{ id: string } | null>(null);
  const [usageDraft, setUsageDraft] = React.useState<Record<string, boolean>>({});
  const [initialCandidates, setInitialCandidates] = React.useState<Record<string, string>>({});
  const [installationShown, setInstallationShown] = React.useState(false);
  const [query, setQuery] = React.useState(""), [page, setPage] = React.useState(1), [remove, setRemove] = React.useState("");
  const { employees, loading: employeesLoading } = useSiliconEmployees({ enabled: admin, includeArchived: false });
  const load = React.useCallback(async (signal?: AbortSignal, throwOnError = false) => {
    try {
      const value = await requestJson<DingTalkStatus>(base, { cache: "no-store", signal });
      if (!Array.isArray(value.accounts) || !Array.isArray(value.bindings)) throw new Error("服务端尚不支持钉钉群接入，请先更新服务。");
      if (!alive.current || signal?.aborted) return;
      setStatus(value); if (!value.installed) setInstallationShown(true);
      setAccount(current => current || (value.accounts.length === 1 ? value.accounts[0]!.id : ""));
      return value;
    } catch (cause) { if (alive.current && !signal?.aborted) setError(cause instanceof Error ? cause.message : "读取钉钉连接失败。"); if (throwOnError) throw cause; }
  }, []);
  React.useEffect(() => { alive.current = true; const abort = new AbortController(); if (admin && active) void load(abort.signal); return () => { alive.current = false; abort.abort(); }; }, [admin, active, load]);
  React.useEffect(() => {
    if (!admin || !active) return;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const off = subscribeConversationChanges(() => {
      if (locked.current) { statusDirty.current = true; return; }
      if (scheduled) clearTimeout(scheduled);
      scheduled = setTimeout(() => { scheduled = undefined; if (alive.current) void load(); }, 250);
    });
    return () => { off(); if (scheduled) clearTimeout(scheduled); };
  }, [admin, active, load]);
  React.useEffect(() => {
    if (!admin || !active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden" || root.current?.closest("[hidden]") || locked.current) return;
      const capturedAuth = authEpoch.current;
      if (attempt?.state === "waiting" || attempt?.state === "exchanging") void requestJson<AuthAttempt>(`${base}/auth/${encodeURIComponent(attempt.id)}`).then(value => {
        if (!alive.current || capturedAuth !== authEpoch.current) return; setAttempt(value); if (value.state === "connected") void load();
      }).catch(() => { if (alive.current && capturedAuth === authEpoch.current) setError("授权状态读取失败，原授权不会重复发起。"); });
      else if (status?.jobs.some(j => j.state === "running") || status?.bindings.some(b => ["creating", "configuring", "joining", "verifying"].includes(b.state))) void load();
    }, 3000);
    return () => clearInterval(timer);
  }, [admin, active, attempt, status, load]);
  const perform = async (key: string, operation: () => Promise<unknown>) => {
    if (locked.current) return; locked.current = true; setBusy(key); setError(""); setSettled(null);
    try { await operation(); if (alive.current) setSettled({ key, ok: true }); }
    catch (cause) { if (alive.current) { setError(cause instanceof Error ? cause.message : "钉钉操作未完成。"); setSettled({ key, ok: false }); } }
    finally { locked.current = false; if (alive.current) { setBusy(""); if (statusDirty.current) { statusDirty.current = false; void load(); } } }
  };
  const edit = () => { revision.current++; setPlan(null); setSubmitted(null); setPlanDirty(false); setExcluded([]); setSettled(null); };
  React.useEffect(() => { revision.current++; setGroups([]); setCursor(""); setPickedGroups([]); setPlan(null); }, [account]);
  const readGroups = (more = false) => perform("groups", async () => {
    const selectedAccount = account, r = revision.current;
    const value = await requestJson<{ groups: DingTalkDiscoveryGroup[]; nextCursor: string }>(`${base}/groups?accountId=${encodeURIComponent(account)}${more && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!alive.current || r !== revision.current) return;
    setGroups(previous => [...new Map([...(more ? previous : []), ...value.groups].map(g => [g.id, g])).values()]); setCursor(value.nextCursor);
    if (selectedAccount === account) setSetup(true);
  });
  const submit = () => perform("connect", async () => {
    if (submitted) return;
    if (!plan || planDirty) {
      const captured = revision.current;
      const value = await requestJson<DingTalkPlan>(`${base}/plans`, jsonBody({ accountId: account, groupIds: pickedGroups, employeeIds: pickedEmployees, excluded, candidateIndices: Object.fromEntries(pickedEmployees.map(id => [id, !initialCandidates[id] || initialCandidates[id] === "follow" ? null : Number(initialCandidates[id])])) }));
      if (alive.current && captured === revision.current) { setPlan(value); setPlanDirty(false); }
    } else {
      const job = await requestJson<DingTalkJob>(`${base}/connections`, jsonBody({ planId: plan.id, confirmed: true }));
      if (!alive.current) return; setSubmitted({ id: job.id }); notifyConversationChanges(); await load();
    }
  });
  const bindingAction = (binding: DingTalkBinding, suffix: string, value?: unknown) => perform(`${binding.id}:${suffix}`, async () => {
    await requestJson(`${base}/bindings/${encodeURIComponent(binding.id)}${suffix === "patch" ? "" : `/${suffix}`}`, jsonBody(value ?? {}, suffix === "patch" ? "PATCH" : "POST"));
    if (alive.current) { setRemove(""); await load(); notifyConversationChanges(); }
  });
  const visible = status?.groups.filter(g => g.accountId === account && (!query || `${g.name} ${status.bindings.filter(b => b.groupId === g.id).map(b => employees.find(e => e.id === b.employeeId)?.name ?? "").join(" ")}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) ?? [];
  const installFeedback = busy === "install" || settled?.key === "install";
  const actionState = (key: string) => ({ pending: busy === key, settled: settled?.key === key ? settled.ok ? "success" as const : "error" as const : null });
  return <section ref={root} className="wand-settings-library-panel" aria-label="钉钉群聊接入">
    <div className="wand-settings-library-heading"><h2>钉钉群聊</h2><p>多群、多员工接入；在对话列表同步群消息，员工仅将最终正文发回钉钉。</p></div>
    {!admin ? <Alert type="info" title="仅管理员可配置钉钉账号、机器人和群接入。"/> : <Flex vertical gap={16}>
      {error && !installFeedback && <Alert type="error" title={error} action={<WandButton size="small" disabled={!!busy} onClick={() => void load()}>读取状态</WandButton>}/>}
      {!status && !error && <Skeleton active paragraph={{ rows: 3 }}/>} 
      {status?.installed && status.diagnostic && <Alert type="warning" title={status.diagnostic}/>}
      {status && (!status.installed || installationShown) && <Flex vertical gap={8}>
        <Typography.Text type="secondary">DWS 按需安装，默认不安装。点击后自动下载并校验官方 v1.0.65，仅安装到当前 Wand 服务的私有目录，不修改系统 PATH。</Typography.Text>
        <SettingsActionButton style={{ width: 192 }} {...actionState("install")} pendingLabel="安装中…" successLabel="已安装 DWS" errorLabel="重试安装" disabled={!!busy || status.installed} onClick={() => void perform("install", async () => {
          await requestJson(`${base}/install`, jsonBody({}));
          const verified = await load(undefined, true);
          if (verified && !verified.installed) throw new Error("安装后 DWS 仍不可用，请检查服务的执行路径与权限后重试。");
        })}>{status.installed ? "已安装 DWS" : settled?.key === "install" && !settled.ok ? "重试安装" : "安装 DWS"}</SettingsActionButton>
        {error && installFeedback && <Alert type="error" title={error}/>}
      </Flex>}
      {status?.installed && <Flex gap={8} align="center" wrap><SettingsActionButton {...actionState("auth")} successLabel="已发起授权" disabled={!!busy || attempt?.state === "waiting" || attempt?.state === "exchanging"} onClick={() => void perform("auth", async () => { authEpoch.current++; const value = await requestJson<AuthAttempt>(`${base}/auth`, jsonBody({})); if (alive.current) setAttempt(value); })}>{status.accounts.length ? "授权其他账号" : "授权钉钉"}</SettingsActionButton><Typography.Text type="secondary">一次授权，不需要手工创建机器人或复制密钥。</Typography.Text></Flex>}
      {attempt?.state === "waiting" && <Alert type="info" title="请在钉钉官方页面完成账号授权" description={<Flex vertical gap={8}><a href={attempt.url} target="_blank" rel="noopener noreferrer">打开钉钉授权页面</a><Typography.Text copyable>{attempt.userCode}</Typography.Text><WandButton size="small" disabled={!!busy} onClick={() => void perform("cancel", async () => { authEpoch.current++; const value = await requestJson<AuthAttempt>(`${base}/auth/${attempt.id}/cancel`, jsonBody({})); if (alive.current) { setAttempt(value); if (value.state === "connected") await load(); } })}>取消本次授权</WandButton></Flex>}/>}
      {attempt?.state === "exchanging" && <Alert type="info" title="钉钉已返回授权，正在安全保存。此步骤不能视为撤销授权；如需撤销已完成授权，请使用钉钉账号的授权管理。"/>}
      {attempt?.state === "failed" && <Alert type="error" title={attempt.error || "授权未完成，请重新授权。"}/>}
      {attempt?.state === "connected" && <Alert type="success" title="钉钉账号已授权；选择组织、群和员工后再接入机器人。"/>}
      {!!status?.accounts.length && <SettingsField label="组织与账号"><WandSelect ariaLabel="钉钉授权账号" value={account} options={status.accounts.map(a => ({ value: a.id, label: `${a.corpName} · ${a.name}` }))} disabled={!!busy} onValueChange={v => { edit(); setAccount(v); }}/></SettingsField>}
      {!!account && <Flex align="center" justify="space-between" gap={8} wrap><Typography.Text type="secondary">机器人按组织与员工复用，不按群重复创建。</Typography.Text><WandButton disabled={!!busy} aria-expanded={setup} onClick={() => { if (setup) { edit(); setSetup(false); } else void readGroups(); }}>{setup ? "收起接入配置" : "接入群聊"}</WandButton></Flex>}
      <Collapse ghost activeKey={setup ? ["setup"] : []} styles={{ header: { display: "none" }, body: { padding: 0 } }} items={[{ key: "setup", label: "群接入配置", children: <Flex vertical gap={16}>
        <SettingsField label="接入群聊" hint="仅列出此账号已加入且可以读取的群。"><WandMultiSelect ariaLabel="选择钉钉群" popupOwner="dingtalk-setup" value={pickedGroups} options={groups.map(g => ({ value: g.id, label: `${g.name}${g.memberCount === undefined ? "" : ` · ${g.memberCount}人`}` }))} disabled={!!busy || !!submitted} onChange={v => { edit(); setPickedGroups(v); }}/></SettingsField>
        {cursor && <WandButton disabled={!!busy} onClick={() => void readGroups(true)}>继续读取群</WandButton>}
        {!groups.length && !busy && <Typography.Text type="secondary">未读取到群；请核对授权组织。读取失败不代表没有群。</Typography.Text>}
        <SettingsField label="应答员工" hint="选择的每位员工接入每个所选群；接入前会列出准确组合。"><WandMultiSelect ariaLabel="选择钉钉应答员工" popupOwner="dingtalk-setup" value={pickedEmployees} options={employees.filter(e => !e.archivedAt).map(e => ({ value: e.id, label: e.name }))} disabled={!!busy || !!submitted || employeesLoading} onChange={v => { edit(); setPickedEmployees(v); }}/></SettingsField>
        {pickedEmployees.map(id => { const employee = employees.find(e => e.id === id); return employee && <SettingsField key={id} label={`${employee.name} · 执行 Agent`} hint="本批新绑定使用此选择；已有绑定不改。仅支持已配置且可无人值守的候选，不会临时提升权限。"><WandSelect ariaLabel={`钉钉初始Agent-${id}`} popupOwner="dingtalk-setup" searchable value={initialCandidates[id] ?? "follow"} options={[{ value: "follow", label: "跟随员工配置" }, ...employee.agents.map((a, i) => ({ value: String(i), label: `候选 ${i + 1} · ${agentToolDisplayName(a.provider, a.engine)} · ${a.model} · ${a.mode}` }))]} disabled={!!busy || !!submitted} onValueChange={value => { edit(); setInitialCandidates(previous => ({ ...previous, [id]: value })); }}/></SettingsField>; })}
        <Flex gap={8} wrap><SettingsActionButton style={{ width: 192 }} kind="primary" {...actionState("connect")} disabled={!!busy || !!submitted || !pickedGroups.length || !pickedEmployees.length} pendingLabel="处理中…" successLabel={submitted ? "已提交" : "已核对"} errorLabel="请核对状态" onClick={() => void submit()}>{submitted ? "已提交接入任务" : plan && !planDirty ? "自动创建并接入" : planDirty ? "重新核对接入范围" : "核对接入范围"}</SettingsActionButton>{submitted ? <WandButton disabled={!!busy} onClick={() => { edit(); setPickedGroups([]); setPickedEmployees([]); }}>继续添加</WandButton> : plan && <WandButton disabled={!!busy} onClick={() => { revision.current++; setPlan(null); }}>返回修改</WandButton>}</Flex>
        {submitted && <Alert type="info" title="接入任务已接受，进度见下方群与员工状态；尚未验证不代表已接通。" description={`任务 ${submitted.id}`}/>}
        {plan && <><Alert type="warning" title={plan.warning}/>
          {plan.employees.map(employee => <Typography.Text key={employee.id} type="secondary">{employee.name} → 钉钉机器人「{employee.robotName}」 · 应用 {employee.appName}（仅平台显示名，不修改员工） · {employee.agent ? `${agentToolDisplayName(employee.agent.provider, employee.agent.engine)} / ${employee.agent.model} / ${employee.agent.mode}` : "跟随员工配置"}</Typography.Text>)}
          <Typography.Text>新增 {plan.pairs.filter(p => !p.existing).length} 项绑定 · 已有 {plan.pairs.filter(p => p.existing).length} 项跳过 · 自动创建 {plan.newRobots} 个机器人</Typography.Text>
          {planDirty && <Typography.Text type="warning">组合已修改；重新核对后才能自动接入。</Typography.Text>}
          {plan.groups.flatMap(group => plan.employees.map(employee => { const key = `${group.id}:${employee.id}`; const registered = status?.groups.find(g => g.accountId === account && g.externalId === group.id); const existing = !!registered && !!status?.bindings.some(b => b.groupId === registered.id && b.employeeId === employee.id); return <Flex key={key} gap={8} justify="space-between" wrap><Checkbox disabled={!!busy || !!submitted || existing} checked={existing || !excluded.includes(key)} onChange={event => { revision.current++; setExcluded(previous => event.target.checked ? previous.filter(v => v !== key) : [...previous, key]); setPlanDirty(true); }}>{group.name} · {employee.name}</Checkbox><Tag>{existing ? "已接入 · 跳过" : excluded.includes(key) ? "不接入" : "新增"}</Tag></Flex>; }))}</>}
      </Flex> }]}/>
      {!!account && <WandSearchField label="搜索已接入的钉钉群或员工" placeholder="搜索群名称或员工" value={query} onValueChange={v => { setQuery(v); setPage(1); }}/>} 
      {!!account && !visible.length && !setup && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚无匹配的群接入"/>}
      <Collapse ghost items={visible.slice((page - 1) * 10, page * 10).map(group => {
        const bindings = status!.bindings.filter(b => b.groupId === group.id), ready = bindings.filter(b => b.state === "ready").length;
        return { key: group.id, label: <Flex justify="space-between" gap={12} wrap><Typography.Text strong>{group.name}</Typography.Text><Typography.Text type="secondary">{ready}/{bindings.length} 名员工可用</Typography.Text></Flex>, children: <Flex vertical gap={12}>
          <Typography.Text type="secondary">{group.syncState === "live" ? "群消息通道已连接" : group.syncState === "at_only" ? "仅同步 @消息，非完整群记录" : group.syncState === "disconnected" ? "同步已中断" : "等待消息通道连接"}{group.historyComplete ? "" : " · 历史范围尚未完整读取"}</Typography.Text>
          {group.syncError && <Alert type="warning" title={group.syncError}/>}
          <Flex gap={8} wrap><WandButton size="small" onClick={() => {
            if (/\/settings\/?$/.test(location.pathname)) { const url = new URL(location.href); url.pathname = url.pathname.replace(/settings\/?$/, ""); url.hash = ""; url.search = new URLSearchParams({ view: "chats", conversation: group.conversationId }).toString(); location.assign(url); }
            else { conversationUi.select(group.conversationId, true); settingsController.close(); }
          }}>打开群聊</WandButton><WandButton size="small" disabled={!!busy} onClick={() => { edit(); setPickedGroups([group.externalId]); setSetup(true); if (!groups.some(g => g.id === group.externalId)) setGroups(g => [...g, { id: group.externalId, name: group.name }]); void readGroups(); }}>添加员工</WandButton><SettingsActionButton size="small" {...actionState(`refresh:${group.id}`)} disabled={!!busy} onClick={() => void perform(`refresh:${group.id}`, async () => { await requestJson(`${base}/groups/${group.id}/refresh`, jsonBody({})); await load(); })}>恢复 / 核对同步</SettingsActionButton></Flex>
          {bindings.map(binding => {
            const employee = employees.find(e => e.id === binding.employeeId);
            return <Flex vertical gap={8} key={binding.id} style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 12 }}><Flex align="center" gap={8} wrap>{employee && <EmployeeAvatar employee={employee} provider="" size="sm" renderMode="static"/>}<Typography.Text strong>{employee?.name ?? "员工已不可用"}</Typography.Text><Tag color={binding.state === "ready" ? "success" : ["unknown", "failed", "restricted"].includes(binding.state) ? "warning" : undefined}>{labels[binding.state]}</Tag></Flex>
              {binding.error && <Alert type="warning" title={binding.error}/>}
              <Collapse ghost items={[{ key: "settings", label: binding.fixedAgent ? `本群固定：${agentToolDisplayName(binding.fixedAgent.provider, binding.fixedAgent.engine)}` : "跟随员工配置 · 设置", children: <Flex vertical gap={12}>
                <Typography.Text type="secondary">仅修改此员工在当前群的接入，不修改员工默认。目前{binding.allowedUsers.includes("*") ? "本群同组织成员" : "授权账号本人"}可触发。</Typography.Text>
                <Checkbox disabled={!!busy} checked={usageDraft[binding.id] ?? binding.allowedUsers.includes("*")} onChange={event => setUsageDraft(previous => ({ ...previous, [binding.id]: event.target.checked }))}>允许本群同组织成员 @触发</Checkbox>
                <Typography.Text type="warning">只向可信成员开放：请求会以员工已配置的本机工具、文件权限与模型执行并消耗额度。不会为此自动提升工具权限；跨组织访客不支持。</Typography.Text>
                <WandButton disabled={!!busy || (usageDraft[binding.id] ?? binding.allowedUsers.includes("*")) === binding.allowedUsers.includes("*")} onClick={() => void bindingAction(binding, "patch", { allowGroupMembers: usageDraft[binding.id] ?? binding.allowedUsers.includes("*") })}>应用此群使用范围</WandButton>
                <Radio.Group value={binding.fixedAgent ? "fixed" : "follow"} disabled={!!busy} onChange={e => { if (e.target.value === "follow") void bindingAction(binding, "patch", { candidateIndex: null }); else if (employee?.agents.length) void bindingAction(binding, "patch", { candidateIndex: 0 }); }}><Radio value="follow">跟随员工配置</Radio><Radio value="fixed" disabled={!employee?.agents.length}>固定下方已有候选</Radio></Radio.Group>
                {employee?.agents.map((candidate, index) => <WandButton key={index} style={{ whiteSpace: "normal", height: "auto", textAlign: "start", overflowWrap: "anywhere" }} disabled={!!busy} onClick={() => void bindingAction(binding, "patch", { candidateIndex: index })}>固定候选 {index + 1}：{agentToolDisplayName(candidate.provider, candidate.engine)} · {candidate.model} · {candidate.mode}</WandButton>)}
                {binding.fixedAgent && <Typography.Text type="secondary" style={{ overflowWrap: "anywhere" }}>当前固定：{binding.fixedAgent.model} · {binding.fixedAgent.mode}（工具权限沿用此候选）</Typography.Text>}
                <Flex gap={8} wrap><WandButton disabled={!!busy} onClick={() => void bindingAction(binding, "patch", { paused: binding.state !== "paused" })}>{binding.state === "paused" ? "恢复接入" : "暂停新输入"}</WandButton>{["unknown", "failed", "restricted", "verifying"].includes(binding.state) && <WandButton disabled={!!busy} onClick={() => void bindingAction(binding, "resume")}>核实并继续原接入</WandButton>}<WandButton disabled={!!busy} onClick={() => setRemove(binding.id)}>移除此绑定</WandButton></Flex>
                {remove === binding.id && <Alert type="warning" title="仅解除此群与员工的绑定，不删除共享机器人、不退出或解散钉钉群；尚未回群的结果将保留在 Wand。" action={<Flex gap={8}><WandButton disabled={!!busy} onClick={() => setRemove("")}>取消</WandButton><WandButton disabled={!!busy} onClick={() => void bindingAction(binding, "remove", { confirmed: true })}>确认移除</WandButton></Flex>}/>} 
              </Flex> }]}/>
            </Flex>;
          })}
        </Flex> };
      })}/>
      {visible.length > 10 && <Pagination pageSize={10} current={page} total={visible.length} onChange={setPage}/>}
      <Typography.Text type="secondary">普通群消息只同步展示，不启动员工。钉钉若强制企业审核，会明确显示配置受限，不建立审批或等待队列。</Typography.Text>
    </Flex>}
  </section>;
}
