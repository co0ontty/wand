import * as React from "react";
import { Alert, Card, Empty, Flex, List, Typography } from "antd";
import { DEFAULT_EMPLOYEE_ID } from "../../../ai-team-types.js";
import type { UserMemoryView } from "../../../user-memory-types.js";
import { jsonBody, requestJson } from "../http-adapter.js";
import { WandButton } from "../ui";
import { notifySiliconEmployeeDefinitionChanged } from "./employee-repository.js";

type Action = "toggle" | "refresh" | "clear";
const LABELS = { communication: "沟通", workflow: "工作方式", focus: "近期关注" };

/** Lives inside the existing in-place employee disclosure; never preloads raw prompt history. */
export function EmployeeMemory({ active }: { active: boolean }): React.ReactElement {
  const [view, setView] = React.useState<UserMemoryView | null>(null);
  const [pending, setPending] = React.useState<Action | null>(null);
  const [results, setResults] = React.useState<Partial<Record<Action, string>>>({});
  const [error, setError] = React.useState("");
  const epoch = React.useRef(0);
  React.useEffect(() => {
    const revision = ++epoch.current;
    setPending(null);
    if (!active) return;
    setView(null);
    requestJson<UserMemoryView>("/api/user-memory").then((next) => {
      if (epoch.current === revision) { setView(next); setError(""); }
    }).catch((cause) => {
      if (epoch.current === revision) setError(cause instanceof Error ? cause.message : "读取记忆失败。");
    });
    return () => { epoch.current++; };
  }, [active]);

  const act = async (action: Action): Promise<void> => {
    if (!view || pending) return;
    const revision = ++epoch.current;
    setPending(action);
    setResults((current) => ({ ...current, [action]: "" }));
    setError("");
    try {
      const next = await requestJson<UserMemoryView & { updated?: boolean }>(
        action === "refresh" ? "/api/user-memory/refresh" : "/api/user-memory",
        action === "toggle" ? jsonBody({ enabled: !view.enabled }, "PATCH")
          : { method: action === "clear" ? "DELETE" : "POST" },
      );
      if (epoch.current !== revision) return;
      setView(next);
      setResults((current) => ({ ...current, [action]: action === "toggle"
        ? next.enabled ? "已开启" : "已暂停"
        : action === "clear" ? "已清空" : next.updated ? "已更新" : "暂无新记忆" }));
      notifySiliconEmployeeDefinitionChanged(DEFAULT_EMPLOYEE_ID);
    } catch (cause) {
      if (epoch.current !== revision) return;
      setResults((current) => ({ ...current, [action]: "操作失败" }));
      setError(cause instanceof Error ? cause.message : "记忆操作失败。");
    } finally {
      if (epoch.current === revision) setPending(null);
    }
  };

  return <Card size="small" title="用户短期记忆" className="wand-employee-memory" aria-label="用户短期记忆">
    <Flex vertical gap={10}>
    <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
      只参考最近 30 天的有效提示词与成功的关键操作，每天整理一次。内容会经敏感信息过滤，整理仍由系统运维员工的 CLI 候选执行；请勿提交凭据。不会修改已有会话、其他员工或工具权限。
    </Typography.Paragraph>
    <Flex wrap gap={8} className="wand-employee-memory-actions">
      {(["toggle", "refresh", "clear"] as const).map((action) => <WandButton
        key={action} size="small" kind="ghost" disabled={!view || !!pending || (action === "refresh" && !view.enabled)}
        aria-busy={pending === action} onClick={() => void act(action)}
      >{pending === action ? "处理中…" : results[action]
        || (action === "toggle" ? view?.enabled ? "暂停记忆" : "恢复记忆"
          : action === "refresh" ? "整理记忆" : "清空记忆")}</WandButton>)}
    </Flex>
    <Typography.Text type="secondary" aria-live="polite">
      {view
        ? `${view.enabled ? "已开启" : "已暂停"} · ${view.eventCount} 条近期记录${view.profile ? ` · 最近整理 ${new Date(view.profile.generatedAt).toLocaleString()}` : " · 尚未形成偏好"}`
        : "正在读取记忆…"}
    </Typography.Text>
    <List
      size="small"
      dataSource={view?.profile?.preferences ?? []}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未形成偏好。" /> }}
      renderItem={(entry, index) => <List.Item key={`${entry.category}-${index}`}>
        <span>{LABELS[entry.category]}：</span>{entry.text}
      </List.Item>}
    />
    {error || view?.lastError
      ? <Alert className="wand-team-candidate-error" type="error" showIcon role="alert" title={error || view?.lastError} />
      : null}
    </Flex>
  </Card>;
}
