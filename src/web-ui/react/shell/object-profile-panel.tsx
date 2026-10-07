import * as React from "react";
import { Alert, Card, Collapse, Descriptions, Drawer, Flex, List, Spin, Tag, Typography } from "antd";
import { WandUiBoundary } from "../theme";
import { PopupOwnerProvider, usePortalContainer } from "../ui/portal-context";
import { WandIcon, WandButton } from "../ui/index.js";
import { EmployeeAvatar } from "../agents/employee-avatar.js";
import { EmployeeCard } from "../agents/employee-card.js";
import { siliconEmployeesRepository } from "../agents/employee-repository.js";
import { isBuiltinSiliconEmployee, siliconEmployeeTags } from "../../../ai-team-types.js";
import { isWandPopupOwnedBy } from "../ui/popup-lifecycle.js";
import type { SiliconEmployee } from "../../../ai-team-types.js";
import type { UiSessionVm } from "./ui-store.js";
import { issueAgentProviderModelLine, type IssueModelCatalog } from "../issues/task-board-agent.js";
import { taskBoardRepository } from "../issues/task-board-repository.js";
import { ISSUE_AGENT_PROVIDERS, normalizeIssueModelCatalog } from "../issues/task-board-agent.js";
import { subscribeWandModelCatalog } from "../model-catalog.js";

export function ObjectProfilePanel({
  open,
  mobile = false,
  employee,
  employeeSnapshot,
  selectedSession,
  triggerRef,
  onClose, loading = false, error = "", onRetry, onMessage,
}: {
  open: boolean;
  mobile?: boolean;
  employee?: SiliconEmployee | null;
  employeeSnapshot?: { id: string; name: string; avatar?: string } | null;
  selectedSession?: UiSessionVm | null;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose(): void;
  loading?: boolean;
  error?: string;
  onRetry?(): void;
  onMessage?(): void;
}): React.ReactElement {
  const [catalog, setCatalog] = React.useState<IssueModelCatalog | null>(null);
  const [savedEmployee, setSavedEmployee] = React.useState<SiliconEmployee | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [discard, setDiscard] = React.useState<"close" | "view" | null>(null);
  React.useEffect(() => { setSavedEmployee(null); setEditing(false); setDirty(false); setDiscard(null); }, [employee?.id, open]);
  employee = savedEmployee ?? employee;
  const panelRef = React.useRef<HTMLDivElement>(null);
  const returnFocus = React.useRef(false);
  const container = usePortalContainer();
  const closeWithFocus = (): void => {
    if (saving) return;
    if (editing && dirty) { setDiscard("close"); return; }
    returnFocus.current = true;
    onClose();
    if (!mobile) triggerRef.current?.focus({ preventScroll: true });
  };

  React.useEffect(() => {
    if (!open) return;
    let active = true;
    void taskBoardRepository.models()
      .then((payload) => { if (active) setCatalog(normalizeIssueModelCatalog(payload)); })
      .catch(() => { if (active) setCatalog(null); });
    const unsubscribe = subscribeWandModelCatalog(setCatalog);
    return () => { active = false; unsubscribe(); };
  }, [open]);

  // 资料浮层的外点关闭在桌面也生效；遮罩只在窄屏可见。
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing) {
        e.preventDefault();
        closeWithFocus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || isWandPopupOwnedBy(target, "object-profile")) return;
      if (triggerRef.current?.contains(target)) return;
      if (editing) { event.preventDefault(); event.stopPropagation(); }
      closeWithFocus();
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, onClose, triggerRef, mobile, editing, dirty, saving]);

  const identity = employee || employeeSnapshot;
  const isEmployee = Boolean(identity);
  const title = identity ? identity.name : (selectedSession?.title || "会话信息");

  return (
    <WandUiBoundary><PopupOwnerProvider owner="object-profile"><Drawer
      open={open}
      getContainer={container}
      title={editing ? "编辑员工资料" : isEmployee ? "员工资料" : "会话详情"}
      size={mobile ? "100%" : 420}
      mask={mobile || editing}
      keyboard={false}
      focusable={{ focusTriggerAfterClose: false }}
      afterOpenChange={(shown) => {
        if (shown || !returnFocus.current) return;
        returnFocus.current = false;
        // The masked mobile Drawer keeps its focus trap until its exit motion ends.
        // Return only if no subsequent user interaction has claimed focus.
        if (document.activeElement === document.body || document.activeElement?.closest(".wand-object-profile-drawer")) {
          triggerRef.current?.focus({ preventScroll: true });
        }
      }}
      panelRef={panelRef}
      onClose={closeWithFocus}
      closable={{ placement: "end", "aria-label": "关闭资料面板" }}
      rootClassName="wand-object-profile-drawer"
      styles={{ header: { paddingTop: "max(16px, var(--wand-safe-top, 0px))" },
        body: { paddingBottom: "max(24px, var(--wand-safe-bottom, 0px))", overflowX: "hidden", scrollPaddingBlock: 24 } }}
      extra={employee && !loading && !editing ? <WandButton kind="ghost" onClick={() => setEditing(true)}>编辑</WandButton> : undefined}
      drawerRender={(node) => <div style={{ height: "100%" }} id="object-profile-panel" className={open ? "open" : ""}
        data-wand-popup-owner="object-profile">{node}</div>}
    >
        {discard ? <Alert role="alert" type="warning" title="放弃尚未保存的修改？" style={{ marginBottom: 16 }} action={<Flex gap={8}>
          <WandButton onClick={() => setDiscard(null)}>继续编辑</WandButton><WandButton kind="danger" onClick={() => {
            const close = discard === "close"; setDiscard(null); setEditing(false); setDirty(false);
            if (close) { returnFocus.current = true; onClose(); if (!mobile) triggerRef.current?.focus({ preventScroll: true }); }
          }}>放弃修改</WandButton></Flex>}/> : null}
        {editing && employee ? <EmployeeCard key={employee.id} employee={employee} catalog={catalog}
          providerOptions={ISSUE_AGENT_PROVIDERS.map(({ value, label }) => ({ value, label }))}
          editorOnly onDirtyChange={setDirty} onSavingChange={setSaving}
          onCancel={() => dirty ? setDiscard("view") : setEditing(false)} onSave={async patch => {
            const updated = await siliconEmployeesRepository.update(employee!.id, isBuiltinSiliconEmployee(employee!)
              ? { agents: patch.agents ?? employee!.agents }
              : { name: patch.name ?? employee!.name, duty: patch.duty ?? employee!.duty, prompt: patch.prompt ?? employee!.prompt,
                avatar: patch.avatar ?? employee!.avatar, tags: patch.tags ?? employee!.tags ?? [], agents: patch.agents ?? employee!.agents });
            setSavedEmployee(updated); setSaving(false); setDirty(false); setEditing(false);
          }}/> : <Flex vertical gap="large" className="object-profile-body">
          {loading ? <Spin tip="正在读取员工资料"><div style={{ height: 60 }}/></Spin> : null}
          {error ? <Alert role="alert" type="error" title="员工资料暂时无法加载" description={error}
            action={<WandButton onClick={onRetry}>重新加载</WandButton>}/> : null}
          <Flex vertical align="center" gap="small" className="object-profile-card">
            {identity ? <EmployeeAvatar employee={identity} provider={selectedSession?.provider} size="xl" />
              : <WandIcon name="terminal" size={32} />}
            <Typography.Title level={3} className="object-profile-name" style={{ margin: 0 }}>{title}</Typography.Title>
            {employee?.duty ? <Typography.Paragraph type="secondary">{employee.duty}</Typography.Paragraph> : null}
            {!employee && employeeSnapshot && !loading && !error ? <Typography.Paragraph type="secondary">配置已归档或删除，历史对话仍可查看。</Typography.Paragraph> : null}
          </Flex>
          {employee ? <Flex justify="center" gap={8} wrap>{siliconEmployeeTags(employee).map(tag => <Tag key={tag}>{tag}</Tag>)}{employee.archivedAt ? <Tag>已归档</Tag> : null}</Flex> : null}
          {onMessage ? <WandButton kind="primary" onClick={onMessage}><WandIcon name="chat"/>发送消息</WandButton> : null}
          {employee?.prompt ? <Collapse items={[{ key: "prompt", label: "角色设定", children:
            <Typography.Paragraph className="object-profile-prompt-content" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>{employee.prompt}</Typography.Paragraph>
          }]} /> : null}
          {employee?.agents && employee.agents.length > 0 ? <Card size="small" title="候选工具链">
            <List dataSource={employee.agents} renderItem={(agent, index) => <List.Item>
              <Flex align="center" gap="small" style={{ minWidth: 0 }}>
                <Tag color={index === 0 ? "processing" : undefined}>{index === 0 ? "首选" : `备用 ${index + 1}`}</Tag>
                <Typography.Text style={{ overflowWrap: "anywhere" }}>{issueAgentProviderModelLine(agent, catalog)}</Typography.Text>
              </Flex>
            </List.Item>}/>
          </Card> : null}
          {!identity && selectedSession ? <Descriptions title="会话属性" column={1} size="small" items={[
            { key: "cli", label: "CLI", children: selectedSession.provider || "未知" },
            { key: "cwd", label: "目录", children: <Typography.Text code style={{ overflowWrap: "anywhere" }}>{selectedSession.cwd || "当前工作区"}</Typography.Text> },
            { key: "status", label: "状态", children: selectedSession.status || "空闲" },
          ]}/> : null}
          {employee ? <Typography.Text type="secondary" style={{ fontSize: 12, overflowWrap: "anywhere" }}>员工 ID · {employee.id}</Typography.Text> : null}
          <Flex wrap gap="small" className="object-profile-actions">
            {employee ? <WandButton onClick={() => setEditing(true)}>编辑员工配置</WandButton> : null}
            <WandButton kind="ghost" onClick={closeWithFocus}>收起面板</WandButton>
          </Flex>
        </Flex>}
    </Drawer></PopupOwnerProvider></WandUiBoundary>
  );
}
