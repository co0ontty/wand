import * as React from "react";
import { Alert, Card, Empty, Flex, List, Typography } from "antd";
import type { UserMemoryView } from "../../../user-memory-types.js";
import { jsonBody, requestJson } from "../http-adapter.js";
import { WandButton, WandSwitch } from "../ui";
import { notifySiliconEmployeeDefinitionChanged } from "./employee-repository.js";

type Action = "toggle" | "refresh" | "clear";
const LABELS = { communication: "沟通", workflow: "工作方式", focus: "近期关注" };

/** Employee-scoped, immediately saved setting; never preloads raw prompt history. */
export function EmployeeMemory({ active, employeeId, disabled = false }: { active: boolean; employeeId: string; disabled?: boolean }): React.ReactElement {
  const [view, setView] = React.useState<UserMemoryView | null>(null);
  const [pending, setPending] = React.useState<Action | null>(null);
  const [results, setResults] = React.useState<Partial<Record<Action, string>>>({});
  const [error, setError] = React.useState("");
  const epoch = React.useRef(0);
  const query = `?employeeId=${encodeURIComponent(employeeId)}`;
  React.useEffect(() => {
    const revision = ++epoch.current;
    setPending(null);
    setResults({});
    setError("");
    if (!active) return;
    setView(null);
    requestJson<UserMemoryView>(`/api/user-memory${query}`).then((next) => {
      if (epoch.current === revision) { setView(next); setError(""); }
    }).catch((cause) => {
      if (epoch.current === revision) setError(cause instanceof Error ? cause.message : "读取记忆失败。");
    });
    return () => { epoch.current++; };
  }, [active, employeeId]);

  const act = async (action: Action): Promise<void> => {
    if (!view || pending || disabled) return;
    const revision = ++epoch.current;
    setPending(action);
    setResults((current) => ({ ...current, [action]: "" }));
    setError("");
    try {
      const next = await requestJson<UserMemoryView & { updated?: boolean }>(
        `${action === "refresh" ? "/api/user-memory/refresh" : "/api/user-memory"}${query}`,
        action === "toggle" ? jsonBody({ enabled: !view.enabled }, "PATCH")
          : { method: action === "clear" ? "DELETE" : "POST" },
      );
      if (epoch.current !== revision) return;
      setView(next);
      setResults((current) => ({ ...current, [action]: action === "toggle"
        ? next.enabled ? "已开启" : "已关闭"
        : action === "clear" ? "已清空" : next.updated ? "已更新" : "暂无新记忆" }));
      notifySiliconEmployeeDefinitionChanged(employeeId);
    } catch (cause) {
      if (epoch.current !== revision) return;
      setResults((current) => ({ ...current, [action]: "操作失败" }));
      setError(cause instanceof Error ? cause.message : "记忆操作失败。");
    } finally {
      if (epoch.current === revision) setPending(null);
    }
  };

  return <Card size="small" title="自动学习偏好" className="wand-employee-memory" aria-label="自动学习偏好">
    <Flex vertical gap={10}>
    <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
      默认关闭。开启后，仅根据此员工最近 30 天的有效提示词与成功操作，每天整理一次偏好，补充到后续新会话的系统提示词。关闭后停止采集、整理和注入；不改写手动角色设定、知识库或已有会话。整理使用系统运维员工的已配置模型，可能产生调用费用。
    </Typography.Paragraph>
    <Flex align="center" gap={8}>
      <WandSwitch ariaLabel="自动学习偏好" checked={view?.enabled ?? false}
        disabled={!view || !!pending || disabled} onCheckedChange={() => void act("toggle")} />
      <Typography.Text aria-live="polite">{pending === "toggle" ? "保存中…" : !view ? error ? "读取失败" : "读取中…" : view.enabled ? "已开启" : "已关闭"} · 更改立即保存</Typography.Text>
    </Flex>
    <Flex wrap gap={8} className="wand-employee-memory-actions">
      {(["refresh", "clear"] as const).map((action) => <WandButton
        key={action} size="small" kind="ghost" disabled={!view || !!pending || disabled || (action === "refresh" && !view.enabled)}
        aria-busy={pending === action} onClick={() => void act(action)}
      >{pending === action ? "处理中…" : results[action]
        || (action === "refresh" ? "整理记忆" : "清空记忆")}</WandButton>)}
    </Flex>
    <Typography.Text type="secondary" aria-live="polite">
      {view
        ? `${view.enabled ? "已开启" : "已关闭"} · ${view.eventCount} 条近期记录${view.profile ? ` · 最近整理 ${new Date(view.profile.generatedAt).toLocaleString()}` : " · 尚未形成偏好"}`
        : error ? "未能读取，请重新打开员工设置。" : "正在读取记忆…"}
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
