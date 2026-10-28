import * as React from "react";
import { Alert, Card, Flex, Typography } from "antd";
import { knowledgeRepository, subscribeKnowledgeChanges, type KnowledgeLibrary } from "../knowledge/repository";
import { knowledgeController } from "../knowledge/controller";
import { settingsController } from "../settings/controller";
import { WandButton } from "../ui/button";

/** Employee settings are an entry into the same library, not a second document editor. */
export function EmployeeKnowledge({ employeeId, active, disabled = false, onOpenLibrary }: { employeeId: string; active: boolean; disabled?: boolean; onOpenLibrary?(navigate: () => void): void }): React.ReactElement {
  const [view, setView] = React.useState<KnowledgeLibrary | null>(null);
  const [refresh, setRefresh] = React.useState(0);
  const [pending, setPending] = React.useState(false);
  const [armed, setArmed] = React.useState(false);
  const [error, setError] = React.useState("");
  const epoch = React.useRef(0);
  const owner = React.useRef(employeeId);
  owner.current = employeeId;
  React.useEffect(() => subscribeKnowledgeChanges(namespace => {
    if (namespace.scope === "personal" && namespace.ownerId === employeeId) setRefresh(value => value + 1);
  }), [employeeId]);
  React.useEffect(() => {
    const token = ++epoch.current;
    setArmed(false); setView(null); setError("");
    if (!active) return;
    void knowledgeRepository.list({ scope: "personal", ownerId: employeeId }).then(next => {
      if (token === epoch.current) setView(next);
    }, cause => { if (token === epoch.current) setError(cause instanceof Error ? cause.message : "读取知识库失败。"); });
    return () => { epoch.current++; };
  }, [active, employeeId, refresh]);
  React.useEffect(() => { setPending(false); }, [employeeId, active]);
  const clear = async (): Promise<void> => {
    if (!view || pending) return;
    if (!armed) { setArmed(true); return; }
    setPending(true); setError("");
    try { await knowledgeRepository.clearPersonal(employeeId); }
    catch (cause) { if (owner.current === employeeId) setError(cause instanceof Error ? cause.message : "清空失败，请重试。"); }
    finally { if (owner.current === employeeId) { setPending(false); setArmed(false); } }
  };
  return <Card size="small" title="自己的知识库" className="wand-employee-memory" aria-label="员工独立知识库">
    <Flex vertical gap={10}>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>对这位员工说「记一下：…」即可保存。知识只属于这位员工，改名、换会话仍保留，不随短期习惯过期；每篇最多 12,000 字符。</Typography.Paragraph>
      <Typography.Text type="secondary" role="status">{view ? `${view.total} / ${view.limit} 篇文档` : error ? "暂时无法读取" : "正在读取…"}</Typography.Text>
      <Flex wrap gap={8} className="wand-employee-knowledge-actions">
        <WandButton size="small" disabled={disabled} onClick={() => {
          const navigate = () => { settingsController.close(); knowledgeController.open("personal", employeeId); };
          if (onOpenLibrary) onOpenLibrary(navigate); else navigate();
        }}>打开个人知识库</WandButton>
        <WandButton size="small" kind="ghost" disabled={pending} onClick={() => setRefresh(value => value + 1)}>刷新知识</WandButton>
        <WandButton size="small" kind="ghost" disabled={!view?.total || pending} onClick={() => void clear()}>{pending ? "处理中…" : armed ? "确认清空" : "清空知识库"}</WandButton>
      </Flex>
      {armed && <Typography.Text type="secondary">再次点击确认，只清空此员工的知识库。</Typography.Text>}
      {error && <Alert type="error" showIcon role="alert" title={error}/>}
    </Flex>
  </Card>;
}
