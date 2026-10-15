import * as React from "react";
import { Alert, Checkbox, Collapse, Form, Input, Skeleton, theme } from "antd";
import { EMPLOYEE_IM_EVENTS, EMPLOYEE_IM_PRIMARY_EVENTS, EMPLOYEE_IM_MORE_EVENT_GROUPS, type EmployeeImChannelInput, type EmployeeImConfig, type EmployeeImConfigInput, type EmployeeImEvent, type EmployeeImProvider } from "../../../employee-im-types.js";
import { jsonBody, requestJson } from "../http-adapter.js";
import { SettingsActionButton, SettingsField, SettingsGrid } from "../settings/fields.js";
import { WandButton, WandSwitch } from "../ui";
import { installEmployeeImStyles } from "./employee-im-styles.js";

function draftOf(config: EmployeeImConfig): EmployeeImConfigInput {
  return { events: [...config.events], telegram: { enabled: config.telegram.enabled, chatId: config.telegram.chatId ?? "" },
    dingtalk: { enabled: config.dingtalk.enabled } };
}
function configResponse(value: EmployeeImConfig): EmployeeImConfig {
  if (!value?.telegram || !value.dingtalk || !Array.isArray(value.events)) throw new Error("服务端暂不支持员工 IM 配置，请更新后重试。");
  return value;
}
/** One task flow: enabled destinations → shared notification events. Credentials never enter employee caches/localStorage. */
export function EmployeeImEditor({ employeeId, disabled, onDirtyChange, onBusyChange }: {
  employeeId: string; disabled?: boolean; onDirtyChange?(value: boolean): void; onBusyChange?(value: boolean): void;
}): React.ReactElement {
  const { token } = theme.useToken();
  const [config, setConfig] = React.useState<EmployeeImConfig | null>(null);
  const [draft, setDraft] = React.useState<EmployeeImConfigInput | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<"save" | EmployeeImProvider | null>(null);
  const [error, setError] = React.useState("");
  const [result, setResult] = React.useState<{ action: "save" | EmployeeImProvider; ok: boolean } | null>(null);
  const [expanded, setExpanded] = React.useState<string[]>([]);
  const root = React.useRef<HTMLElement>(null);
  const alive = React.useRef(true);
  const lock = React.useRef(false);
  const dirty = !!draft && !!config && JSON.stringify(draft) !== JSON.stringify(draftOf(config));
  const path = `/api/silicon-employees/${encodeURIComponent(employeeId)}/im`;
  React.useEffect(() => { installEmployeeImStyles(); alive.current = true; return () => { alive.current = false; }; }, []);
  React.useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  React.useEffect(() => { onBusyChange?.(!!busy); }, [busy, onBusyChange]);
  const load = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try {
      const value = configResponse(await requestJson<EmployeeImConfig>(path, { cache: "no-store", signal }));
      if (!alive.current || signal?.aborted) return;
      setConfig(value); setDraft(draftOf(value));
    } catch (cause) { if (alive.current && !signal?.aborted) setError(cause instanceof Error ? cause.message : "读取 IM 配置失败。"); }
    finally { if (alive.current && !signal?.aborted) setLoading(false); }
  }, [path]);
  React.useEffect(() => { const abort = new AbortController(); void load(abort.signal); return () => abort.abort(); }, [load]);
  const patch = (provider: EmployeeImProvider, value: Partial<EmployeeImChannelInput>) => {
    setDraft(current => current ? { ...current, [provider]: { ...current[provider], ...value } } : current); setResult(null); setError("");
  };
  const openChannel = (provider: EmployeeImProvider) => {
    setExpanded(current => current.includes(provider) ? current : [...current, provider]);
    requestAnimationFrame(() => root.current?.querySelector<HTMLInputElement>(`[data-im-channel="${provider}"] input:not([disabled])`)?.focus({ preventScroll: true }));
  };
  const credentialsReady = (provider: EmployeeImProvider): boolean => {
    if (!draft || !config) return false;
    return provider === "telegram" ? !!draft.telegram.chatId?.trim()
      && (draft.telegram.botToken !== null && (!!draft.telegram.botToken || !!config.telegram.botTokenConfigured))
      : draft.dingtalk.webhook !== null && (!!draft.dingtalk.webhook || !!config.dingtalk.webhookConfigured);
  };
  const execute = async (action: "save" | EmployeeImProvider) => {
    if (lock.current || !draft || !config || disabled || (action !== "save" && dirty)) return;
    if (action === "save") {
      const incomplete = (["telegram", "dingtalk"] as const).find(provider => draft[provider].enabled && !credentialsReady(provider));
      if (incomplete) { openChannel(incomplete); setError(incomplete === "telegram" ? "启用 Telegram 前，请补齐 Bot Token 和 Chat ID。" : "启用钉钉前，请填写机器人 Webhook。"); return false; }
    }
    lock.current = true; setBusy(action); setError(""); setResult(null);
    try {
      if (action === "save") {
        const value = configResponse(await requestJson<EmployeeImConfig>(path, jsonBody(draft, "PUT")));
        if (!alive.current) return;
        setConfig(value); setDraft(draftOf(value));
      } else {
        await requestJson(`${path}/test`, jsonBody({ provider: action }));
        if (!alive.current) return;
      }
      setResult({ action, ok: true });
    } catch (cause) {
      if (alive.current) { setResult({ action, ok: false }); setError(cause instanceof Error ? cause.message : "IM 操作失败，请重试。"); }
    } finally { lock.current = false; if (alive.current) setBusy(null); }
  };
  const blocked = disabled || !!busy || loading;
  const secret = (provider: EmployeeImProvider, key: "botToken" | "webhook" | "secret", label: string, configured?: boolean) => {
    const value = draft?.[provider][key], id = `employee-im-${employeeId}-${provider}-${key}`;
    return <SettingsField label={label} htmlFor={id}>
      <Input.Password id={id} autoComplete="new-password" value={value ?? ""} disabled={blocked || value === null} maxLength={key === "webhook" ? 1024 : 512} placeholder={configured ? "已配置，留空保持不变" : label} onChange={event => patch(provider, { [key]: event.target.value })}/>
      {configured && <Checkbox checked={value === null} disabled={blocked} onChange={event => patch(provider, { [key]: event.target.checked ? null : undefined })}>清除已保存的{label}</Checkbox>}
    </SettingsField>;
  };
  const selectedCount = draft?.events.length ?? 0;
  const moreSelected = draft?.events.filter(value => !EMPLOYEE_IM_PRIMARY_EVENTS.includes(value)).length ?? 0;
  const eventChoice = (value: EmployeeImEvent) => <Checkbox key={value} disabled={blocked} checked={draft?.events.includes(value)} onChange={change => {
    setDraft(current => current ? { ...current, events: change.target.checked ? [...current.events, value] : current.events.filter(event => event !== value) } : current);
    setResult(null); setError("");
  }}>{EMPLOYEE_IM_EVENTS.find(event => event.value === value)!.label}</Checkbox>;
  return <section ref={root} className="form-section employee-im" aria-label="员工 IM 通知" data-employee-im-editor onKeyDown={event => {
    if (event.key !== "Escape" || !expanded.length || blocked || event.nativeEvent.isComposing) return;
    event.preventDefault(); event.stopPropagation();
    const target = event.target as HTMLElement;
    const provider = target.closest("[data-im-channel]")?.getAttribute("data-im-channel")
      ?? (target.closest(".employee-im-more") ? "events" : expanded.at(-1)!);
    setExpanded(current => current.filter(key => key !== provider));
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(provider === "events" ? '.employee-im-more [role="button"]' : `.employee-im-channel-${provider} [role="button"]`)?.focus());
  }}>
    <div className="employee-im-heading"><h3>IM 通知</h3><div className="employee-im-actions">
      <WandButton size="small" kind="ghost" disabled={blocked || !dirty} onClick={() => { if (config) setDraft(draftOf(config)); setError(""); setResult(null); setExpanded([]); }}>撤销</WandButton>
      <SettingsActionButton aria-label="保存通知设置" size="small" kind="primary" disabled={blocked || !dirty} pending={busy === "save"} settled={result?.action === "save" ? result.ok ? "success" : "error" : null} pendingLabel="保存中…" successLabel="已保存" errorLabel="保存失败" onClick={() => execute("save")}>保存</SettingsActionButton>
    </div></div>
    <p className="employee-im-intro">所选节点会发送到所有已开启的渠道。</p>
    {error && <Alert type="error" title={error} action={!config ? <WandButton disabled={loading} onClick={() => void load()}>重新读取</WandButton> : undefined}/>}
    {loading && <Skeleton active title={false} paragraph={{ rows: 3 }}/>} 
    {config && draft && <Form component={false} layout="vertical">

      <div className="employee-im-channels">
        {(["telegram", "dingtalk"] as const).map(provider => {
          const channel = draft[provider], name = provider === "telegram" ? "Telegram" : "钉钉";
          const ready = credentialsReady(provider);
          const savedReady = provider === "telegram" ? config.telegram.botTokenConfigured && config.telegram.chatId : config.dingtalk.webhookConfigured;
          const summary = provider === "telegram" ? ready ? `接收目标 ${channel.chatId}` : "未配置" : channel.webhook === null ? "保存后清除机器人" : channel.webhook ? "新机器人待保存" : config.dingtalk.webhookConfigured ? "群机器人已配置" : "未配置";
          return <Collapse key={provider} ghost className={`employee-im-channel-${provider}`} activeKey={expanded.includes(provider) ? [provider] : []} onChange={keys => {
            if (keys.includes(provider)) openChannel(provider); else setExpanded(current => current.filter(key => key !== provider));
          }} expandIconPlacement="start" styles={{ header: { paddingInline: 0, paddingBlock: token.paddingSM }, body: { paddingInline: 0, paddingBlock: token.paddingSM } }} items={[{
            key: provider, collapsible: blocked ? "disabled" : undefined,
            label: <div className="employee-im-channel-label"><strong>{name}</strong><small title={summary}>{summary}</small></div>,
            extra: <span onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === " " || event.key === "Enter") event.stopPropagation(); }}><WandSwitch ariaLabel={`启用 ${name} 通知`} checked={channel.enabled} disabled={blocked} onCheckedChange={enabled => { patch(provider, { enabled }); if (enabled && !ready) openChannel(provider); }}/></span>,
            children: <div className="employee-im-channel-body" data-im-channel={provider}>
              <SettingsGrid>{provider === "telegram" ? <>
                {secret(provider, "botToken", "Bot Token", config.telegram.botTokenConfigured)}
                <SettingsField label="Chat ID" htmlFor={`employee-im-${employeeId}-chat-id`}><Input id={`employee-im-${employeeId}-chat-id`} value={channel.chatId ?? ""} disabled={blocked} maxLength={33} placeholder="用户、群聊 ID 或 @频道名" onChange={event => patch(provider, { chatId: event.target.value })}/></SettingsField>
              </> : <>
                {secret(provider, "webhook", "Webhook", config.dingtalk.webhookConfigured)}
                {secret(provider, "secret", "签名 Secret（可选）", config.dingtalk.secretConfigured)}
              </>}</SettingsGrid>
              <p className="employee-im-credential-hint">{provider === "telegram" ? "私聊请先向机器人发送 /start。" : "使用自定义机器人 Webhook；开启加签时填写 Secret。"}</p>
              <div className="employee-im-test-row"><SettingsActionButton size="small" aria-label={`发送${name}测试消息`} pending={busy === provider} disabled={blocked || dirty || !savedReady} settled={result?.action === provider ? result.ok ? "success" : "error" : null} pendingLabel="发送中…" successLabel="已发送" errorLabel="发送未确认" onClick={() => execute(provider)}>发送测试消息</SettingsActionButton>{(dirty || !savedReady) && <span>{dirty ? "先保存，再测试" : "配置后可测试"}</span>}</div>
            </div>,
          }]}/>;
        })}
      </div>
      <div className="employee-im-subheading"><h4>通知节点</h4><span className="employee-im-summary">{selectedCount ? `已选 ${selectedCount} 项` : "未选择"}</span></div>
      <div className="employee-im-events" aria-label="共用通知节点">
        <SettingsGrid>{EMPLOYEE_IM_PRIMARY_EVENTS.map(eventChoice)}</SettingsGrid>
        <Collapse ghost className="employee-im-more" activeKey={expanded.includes("events") ? ["events"] : []} onChange={keys => setExpanded(current => keys.includes("events") ? [...current.filter(key => key !== "events"), "events"] : current.filter(key => key !== "events"))}
          styles={{ header: { paddingInline: 0, paddingBlock: token.paddingXS }, body: { paddingInline: 0, paddingBlock: token.paddingSM } }}
          items={[{ key: "events", label: "更多节点", extra: moreSelected ? <span className="employee-im-summary">{moreSelected} 项已选</span> : undefined, collapsible: blocked ? "disabled" : undefined,
            children: <div className="employee-im-event-groups">{EMPLOYEE_IM_MORE_EVENT_GROUPS.map(group => <fieldset key={group.label}><legend>{group.label}</legend><SettingsGrid>{group.events.map(eventChoice)}</SettingsGrid></fieldset>)}</div>,
          }]}/>
      </div>
      <p className="employee-im-footnote">仅发送状态摘要，不包含对话正文。</p>
    </Form>}
  </section>;
}
