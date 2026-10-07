import * as React from "react";
import { WandButton, WandDialogSurface } from "../ui";
import { Alert, Tag } from "antd";
import { loadPiExecution } from "./repository";
import { piExecutionController, type PiExecutionWindow } from "./controller";
import type { PiExecutionNode, PiExecutionResponse, PiExecutionState } from "../../../pi-execution-types.js";

const LABELS: Record<PiExecutionState, string> = {
  pending: "待执行", running: "执行中", background: "已派发后台", completed: "已完成", failed: "失败",
  paused: "已暂停", stopped: "已停止", detached: "已脱离", rejected: "未通过", skipped: "已跳过", partial: "部分完成", unknown: "状态未知",
};
const ACTIVE = new Set(["pending", "running", "background"]);
function StateLabel({ state }: { state: PiExecutionState }) {
  return <Tag className={`pi-execution-state is-${state}`} color={state === "completed" ? "success" : state === "failed" || state === "rejected" ? "error" : ACTIVE.has(state) ? "processing" : undefined}>{LABELS[state]}</Tag>;
}
function time(ms: number): string { return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`; }

function NodeDetails({ node }: { node: PiExecutionNode | undefined }) {
  if (!node) return <p className="pi-execution-empty">执行器尚未提供子任务清单。</p>;
  const fields = [["员工", node.agent], ["模型", node.model], ["阶段", node.phase], ["运行 ID", node.runId],
    ["当前工具", node.currentTool], ["耗时", node.durationMs === undefined ? undefined : time(node.durationMs)],
    ["Tokens", node.tokens], ["工具调用", node.toolCount]];
  return <section className="pi-execution-detail" aria-label="子任务详情">
    <h3>{node.label}</h3><StateLabel state={node.state}/>
    <dl>{fields.filter(([, value]) => value !== undefined).map(([label, value]) => <React.Fragment key={String(label)}>
      <dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>
    {node.task && <><h4>任务</h4><pre>{node.task}</pre></>}
    {node.error && <><h4>错误</h4><pre className="pi-execution-error">{node.error}</pre></>}
    {node.output && <><h4>最近输出</h4><pre>{node.output}</pre></>}
  </section>;
}

function ExecutionContent({ target }: { target: PiExecutionWindow }) {
  const [data, setData] = React.useState<PiExecutionResponse | null>(null);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [revision, setRevision] = React.useState(0);
  const [selected, setSelected] = React.useState("");
  React.useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let generation = 0;
    async function load(): Promise<void> {
      const current = ++generation;
      request?.abort();
      request = new AbortController();
      setLoading(true);
      try {
        const result = await loadPiExecution(target.sessionId, target.toolId, request.signal);
        if (disposed || current !== generation) return;
        setData(result); setError("");
        if (result.snapshot && !result.notice && (ACTIVE.has(result.snapshot.state) || result.snapshot.nodes.some(n => ACTIVE.has(n.state)))) {
          timer = setTimeout(() => { if (!document.hidden) void load(); }, 2000);
        }
      } catch (e) {
        if (!disposed && current === generation) setError(e instanceof Error ? e.message : "读取执行结构失败");
      } finally { if (!disposed && current === generation) setLoading(false); }
    }
    const visible = (): void => { if (!document.hidden) { clearTimeout(timer); request?.abort(); void load(); } };
    void load();
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; clearTimeout(timer); request?.abort(); document.removeEventListener("visibilitychange", visible); };
  }, [target.sessionId, target.toolId, revision]);
  const execution = data?.snapshot;
  const nodes = execution?.nodes ?? [];
  const node = nodes.find(n => n.id === selected) ?? nodes.find(n => n.state === "running") ?? nodes[0];
  // Parent links come only from the executor's graph; phases are display groups, not dependencies.
  const phases = [...new Set(nodes.map(n => n.phase ?? "子任务"))];
  return <div className="pi-execution-window-body">
    <div className="pi-execution-toolbar">
      <span>{execution ? `${execution.source === "status-file" ? "后台运行快照" : execution.source === "tool-progress" ? "工具进度快照" : "工具结果快照"} · ${execution.mode}` : "读取真实执行数据"}</span>
      <WandButton size="small" disabled={loading} onClick={() => setRevision(v => v + 1)}>{loading ? "读取中…" : "刷新"}</WandButton>
    </div>
    {error && <Alert role="alert" type="error" title={`${error}${data ? "（保留上次快照）" : ""}`}/>}
    {data?.notice && <Alert role="status" type="info" title={data.notice}/>}
    {execution && <div className="pi-execution-root">
      <strong>{execution.name ?? (execution.mode === "workflow" ? "工作流" : "子 Agent 执行")}</strong>
      <StateLabel state={execution.state}/>
      {execution.runId && <code>{execution.runId}</code>}
      <span>{nodes.filter(n => n.kind !== "parallel-group" && n.kind !== "dynamic-parallel-group").length} 个节点 · {execution.inventoryComplete ? "清单已结束" : "清单仍可能增加"}</span>
    </div>}
    <div className="pi-execution-layout">
      <nav className="pi-execution-tree" aria-label="执行结构">
        {phases.map(phase => <section key={phase}><h3>{phase}</h3>
          {nodes.filter(n => (n.phase ?? "子任务") === phase).map(n => <WandButton kind={n.id === node?.id ? "soft" : "ghost"} key={n.id}
            className={`pi-execution-node${n.id === node?.id ? " is-selected" : ""}`}
            aria-pressed={n.id === node?.id} onClick={() => setSelected(n.id)}>
            {n.parentId && <small>↳ {nodes.find(p => p.id === n.parentId)?.label ?? n.parentId}</small>}
            <strong>{n.label}</strong><StateLabel state={n.state}/>
            {n.agent && n.agent !== n.label && <small>{n.agent}</small>}
          </WandButton>)}
        </section>)}
        {!nodes.length && <p className="pi-execution-empty">{loading ? "正在读取子任务…" : "暂无可确认的子任务"}</p>}
        {!!execution?.omittedNodes && <p>另有 {execution.omittedNodes} 个节点未显示</p>}
      </nav>
      <NodeDetails node={node}/>
    </div>
    {!!execution?.trace.length && <section className="pi-execution-evidence"><h3>调用轨迹</h3>
      <p>按执行器记录的事件顺序展示；顺序不代表任务依赖。</p>
      <ol>{execution.trace.map((t, i) => <li key={i}><code>{t.operation} {t.key}</code> <span>{t.state}</span>
        {t.durationMs !== undefined && <small>{time(t.durationMs)}</small>}{t.error && <pre>{t.error}</pre>}</li>)}</ol>
      {!!execution.omittedTrace && <p>另有 {execution.omittedTrace} 条较早事件未显示</p>}
    </section>}
    {data && <section className="pi-execution-evidence"><h3>{data.script ? "编排脚本" : "派发参数"}</h3>
      {!data.script && Boolean(data.input.workflow) && <p>脚本来源：{String(data.input.workflow)}。本次数据未包含脚本正文。</p>}
      <pre>{data.script ?? JSON.stringify(data.input, null, 2)}</pre>
    </section>}
  </div>;
}

export function PiExecutionHost() {
  const target = React.useSyncExternalStore(piExecutionController.subscribe, piExecutionController.getSnapshot, piExecutionController.getSnapshot);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  if (target) returnFocus.current = target.trigger;
  return <WandDialogSurface open={!!target} title="执行结构" description="查看 Pi 实际派发的子任务、阶段、运行状态与编排依据。"
    onAfterClose={() => {
      if (!piExecutionController.isOpen() && returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
    }}
    className="wand-pi-execution-content" closeLabel="关闭执行结构" onOpenChange={open => { if (!open) piExecutionController.close(); }}>
    {target && <ExecutionContent key={`${target.sessionId}:${target.toolId}`} target={target}/>}
  </WandDialogSurface>;
}
