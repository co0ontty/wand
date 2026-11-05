import * as React from "react";
import { Alert, Spin } from "antd";
import { WandButton, WandIconButton } from "../ui/button";
import { WandIcon } from "../ui/icons";
import { requestJson } from "../http-adapter";
import type { EmployeeExecutionPrompts } from "../../../execution-prompt-types.js";

/** Keyed by employee: no previous employee's private text survives a switch. */
export function ExecutionPrompts({ employeeId, employeeName }: { employeeId: string; employeeName: string }): React.ReactElement {
  const [data, setData] = React.useState<EmployeeExecutionPrompts | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [selected, setSelected] = React.useState("");
  const [view, setView] = React.useState<"records" | "current">("records");
  const generation = React.useRef(0);
  const load = async (before?: number): Promise<void> => {
    const version = ++generation.current;
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ employeeId, ...(before ? { before: String(before) } : {}) });
      const result = await requestJson<EmployeeExecutionPrompts>(`/api/knowledge/execution-prompts?${query}`, { cache: "no-store" });
      if (result.employeeId !== employeeId || result.records.some(record => record.employeeId !== employeeId)) throw new Error("执行记录归属不一致。");
      if (version === generation.current) setData(previous => ({ ...result, records: before ? [...(previous?.records ?? []), ...result.records] : result.records }));
    } catch (reason) { if (version === generation.current) setError(reason instanceof Error ? reason.message : "无法读取执行记录。"); }
    finally { if (version === generation.current) setLoading(false); }
  };
  React.useEffect(() => { void load(); return () => { generation.current++; }; }, [employeeId]);
  const records = data?.records ?? [];
  const record = records.find(item => item.id === selected) ?? records[0];
  const date = (value: string): string => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return <section className="execution-library" aria-label="员工执行下发记录" aria-busy={loading}>
    <header className="execution-heading"><div><div className="execution-eyebrow">{employeeName}的执行上下文</div><h1>执行下发记录</h1><p>回看每次执行交给 Agent 的提示与规则</p></div>
      <WandIconButton aria-label="刷新执行记录" title="刷新执行记录" disabled={loading} onClick={() => void load()}><WandIcon name="refresh" size={16}/></WandIconButton>
    </header>
    <div className="execution-toolbar" role="group" aria-label="提示词视图">
      <WandButton kind="ghost" aria-pressed={view === "records"} onClick={() => setView("records")}><WandIcon name="history" size={16}/>执行记录<span className="execution-count">{data ? `${records.length}${data.nextCursor !== null ? "+" : ""}` : "—"}</span></WandButton>
      <WandButton kind="ghost" aria-pressed={view === "current"} onClick={() => setView("current")}><WandIcon name="file" size={16}/>当前角色配置</WandButton>
      <span className="execution-readonly"><WandIcon name="lock" size={14}/>只读快照</span>
    </div>
    {error && <Alert className="execution-error" type="error" role="alert" showIcon title={error} action={<WandButton size="small" disabled={loading} onClick={() => void load()}>重新读取</WandButton>}/>}
    {loading && !data ? <div className="execution-empty" role="status"><Spin/><p>正在读取执行记录</p></div> : data && view === "current" ?
      <div className="execution-current"><div className="execution-section-heading"><WandIcon name="file" size={16}/><h2>当前角色配置</h2></div><p className="execution-description">这是员工现在的角色提示，不代表过去执行时下发的内容。</p><pre className="execution-prompt-text">{data.currentPrompt || "这位员工尚未配置角色提示"}</pre></div>
      : data && records.length ? <div className="execution-workspace">
        <nav className="execution-records" aria-label="选择执行记录"><div className="execution-list-caption">执行时间 / 工具</div>{records.map(item => <button type="button" className="execution-record" aria-pressed={record?.id === item.id} key={item.id} onClick={() => setSelected(item.id)}>
          <span className="execution-record-time"><WandIcon name="file" size={16}/><time dateTime={item.executedAt}>{date(item.executedAt)}</time><WandIcon name="chevron" size={14}/></span>
          <span className="execution-record-tool">{item.tool}</span><span className="execution-record-model" title={item.model}>{item.model}</span>
        </button>)}{data.nextCursor !== null && <WandButton className="execution-more" size="small" disabled={loading} onClick={() => void load(data.nextCursor!)}>{loading ? "正在读取…" : "加载更早记录"}</WandButton>}</nav>
        {record && <article className="execution-detail" aria-label="执行提示词详情" key={record.id}><header className="execution-detail-heading"><h2>{record.tool}</h2><time dateTime={record.executedAt}>{new Date(record.executedAt).toLocaleString("zh-CN", { hour12: false })}</time></header>
          <dl className="execution-metadata"><div><dt>模型</dt><dd>{record.model}</dd></div><div><dt>Provider</dt><dd>{record.provider}</dd></div><div><dt>下发通道</dt><dd>{record.channel}</dd></div><div><dt>会话</dt><dd className="execution-session">{record.sessionId}</dd></div></dl>
          <div className="execution-parts-heading">提示词内容<span>{record.parts.length} 个来源</span></div>
          {record.parts.length ? record.parts.map((part, index) => <section className="execution-part" key={index}><header><span className="execution-part-index">{String(index + 1).padStart(2, "0")}</span><h3>{part.source}</h3></header><pre className="execution-prompt-text">{part.text}</pre></section>) : <p className="execution-description">本次没有下发 Wand 系统提示。</p>}
        </article>}
      </div> : data ? <div className="execution-empty"><div className="execution-empty-icon"><WandIcon name="file" size={24}/></div><h2>还没有执行记录</h2><p>{employeeName}开始新的执行后，<br/>这里会保留当次下发的提示词快照。</p><WandButton onClick={() => setView("current")}>查看当前角色配置<WandIcon name="chevron" size={14}/></WandButton><span>不会用当前配置补造历史记录</span></div> : null}
    <details className="execution-scope"><summary><WandIcon name="info" size={14}/>这些记录包含什么</summary><p>仅记录 Wand 在提交边界交给 Agent 的内容，运行凭据已过滤；记录不代表模型已接受或执行成功。Provider 内置提示、CLI 本地规则、Skills/MCP 动态内容和扩展后续改写不在此范围。PTY 仅记录启动下发；上线前的执行没有快照。</p></details>
  </section>;
}
