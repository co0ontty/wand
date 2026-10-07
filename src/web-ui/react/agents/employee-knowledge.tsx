import * as React from "react";
import { Alert, Card, Empty, Flex, List, Typography } from "antd";
import type { EmployeeKnowledgeView } from "../../../employee-knowledge-types.js";
import { requestJson } from "../http-adapter.js";
import { WandButton, WandSearchField } from "../ui";

// Network search debounce, not an animation duration.
const SEARCH_DEBOUNCE_MS = 180;

/** Each expanded employee card loads its own namespace; no global cache or background prefetch. */
export function EmployeeKnowledge({ employeeId, active }: { employeeId: string; active: boolean }): React.ReactElement {
  const [view, setView] = React.useState<EmployeeKnowledgeView | null>(null);
  const [query, setQuery] = React.useState("");
  const [pending, setPending] = React.useState<"refresh" | "clear" | null>(null);
  const [result, setResult] = React.useState({ refresh: "", clear: "" });
  const [armed, setArmed] = React.useState(false);
  const [error, setError] = React.useState("");
  const epoch = React.useRef(0);
  const url = `/api/silicon-employees/${encodeURIComponent(employeeId)}/knowledge`;
  React.useEffect(() => {
    const revision = ++epoch.current;
    setArmed(false);
    setPending(null);
    if (!active) return;
    setView(null);
    const timer = setTimeout(() => {
      requestJson<EmployeeKnowledgeView>(`${url}?q=${encodeURIComponent(query)}`).then((next) => {
        if (epoch.current === revision) { setView(next); setError(""); }
      }).catch((cause) => {
        if (epoch.current === revision) setError(cause instanceof Error ? cause.message : "读取知识库失败。");
      });
    }, query ? SEARCH_DEBOUNCE_MS : 0);
    return () => { clearTimeout(timer); epoch.current++; };
  }, [active, employeeId, query]);

  const act = async (action: "refresh" | "clear"): Promise<void> => {
    if (!view || pending) return;
    if (action === "clear" && !armed) { setArmed(true); return; }
    const revision = ++epoch.current;
    setPending(action);
    setError("");
    setResult((current) => ({ ...current, [action]: "" }));
    try {
      const next = await requestJson<EmployeeKnowledgeView>(
        action === "clear" ? url : `${url}?q=${encodeURIComponent(query)}`,
        { method: action === "clear" ? "DELETE" : "GET" },
      );
      if (epoch.current !== revision) return;
      setView(next);
      setArmed(false);
      setResult((current) => ({ ...current, [action]: action === "clear" ? "已清空" : "已刷新" }));
    } catch (cause) {
      if (epoch.current !== revision) return;
      setResult((current) => ({ ...current, [action]: "操作失败" }));
      setError(cause instanceof Error ? cause.message : "知识库操作失败。");
    } finally { if (epoch.current === revision) setPending(null); }
  };

  return <Card size="small" title="自己的知识库" className="wand-employee-memory" aria-label="员工独立知识库">
    <Flex vertical gap={10}>
    <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
      对这位员工说「记一下：…」即可保存；只属于这位员工，改名、换会话仍保留，不随短期习惯过期。每条最多4000字符，不保存凭据。
    </Typography.Paragraph>
    <Flex wrap gap={8} className="wand-employee-knowledge-actions">
      {(["refresh", "clear"] as const).map((action) => <WandButton key={action} size="small" kind="ghost"
        disabled={!view || !!pending} aria-busy={pending === action} onClick={() => void act(action)}
      >{pending === action ? "处理中…" : action === "clear" && armed ? "确认清空"
        : result[action] || (action === "clear" ? "清空知识库" : "刷新知识")}</WandButton>)}
    </Flex>
    <Typography.Text type="secondary" role="status">
      {armed ? "再次点击确认，只清空此员工。" : "明确知识会保留，直到你删除。"}
    </Typography.Text>
    <WandSearchField value={query} onValueChange={setQuery} label="搜索这位员工的知识" placeholder="搜索自己的知识…" />
    <Typography.Text type="secondary" aria-live="polite">
      {view ? `${view.total} / ${view.maxEntries} 条知识` : "正在读取…"}
    </Typography.Text>
    <List
      size="small"
      className="wand-employee-knowledge-list"
      style={{ maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
      dataSource={view?.entries ?? []}
      locale={{ emptyText: <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={query ? "没有匹配的知识。" : "还没有明确记录的知识。"}
      /> }}
      renderItem={(entry) => <List.Item key={entry.id}>{entry.content}</List.Item>}
    />
    {error ? <Alert className="wand-team-candidate-error" type="error" showIcon role="alert" title={error} /> : null}
    </Flex>
  </Card>;
}
