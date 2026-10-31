import * as React from "react";
import { GROUP_CHAT_VISIBLE } from "../../group-chat-visibility.js";
import { usePageRouteState, routeEnum } from "../use-page-route";
import { CopyPageLink } from "../ui/copy-page-link";
import { Alert, Flex, Typography } from "antd";
import { newSessionController } from "../new-session/controller";
import { employeeProfile } from "../agents/employee-profile-state";
import { EmployeeAvatar } from "../agents/employee-avatar";
import { employeeCliLabel } from "../agents/employee-identity.js";
import { useSiliconEmployees } from "../agents/employee-repository";
import { useUserProfile } from "../user-profile-repository";
import { settingsController } from "../settings/controller.js";
import { useAiTeamListState } from "../ai-teams/repository";
import { taskBoardController } from "../issues/task-board-controller";
import { WandBadge, WandButton, WandIconButton, WandSearchField, WandStretchTabs } from "../ui";
import { ConversationMorphIcon, ConversationPanel } from "./controls";
import { GroupEditor, PresetDetails } from "./group-editor";
import { conversationUi } from "./state";
import { installDirectoryStyles } from "./directory-styles.js";

export function ConversationDirectory({ active = true, onSelect }: { active?: boolean; onSelect(id: string, focusComposer?: boolean): void }): React.ReactElement {
  React.useEffect(() => { installDirectoryStyles(); }, []);
  // 隐藏时不读：团队名单与归档员工都是重列表，只在通讯录真的打开时拉。
  const { employees, error, loading, reload } = useSiliconEmployees({ includeArchived: true, enabled: active });
  const self = useUserProfile();
  const teamSource = useAiTeamListState(active);
  const { teams } = teamSource;
  const [tab, setTab] = usePageRouteState<"employees" | "presets">("directoryTab", "employees", routeEnum(["employees", "presets"], "employees"), String, "push");
  const [query, setQuery] = usePageRouteState("directoryQuery", "", undefined, undefined, "replace", 250);
  const [expanded, setExpanded] = React.useState<string[]>([]);
  const [create, setCreate] = React.useState(false);
  const [presetId, setPresetId] = React.useState("");
  const anchor = React.useRef<HTMLDivElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const toggle = (id: string): void => setExpanded(values => values.includes(id) ? values.filter(v => v !== id) : [...values, id]);
  const match = (text: string): boolean => text.toLowerCase().includes(query.trim().toLowerCase());
  const visibleEmployees = employees.filter(e => match(`${e.name} ${e.duty} ${e.id}`));
  const selfVisible = match(`${self.name || "我"} 我 我的资料`);
  const visibleTeams = teams.filter(t => match(`${t.name} ${t.description}`));
  return <Flex vertical className="conversation-directory" style={{ height: "100%", minHeight: 0 }}>
    <Flex ref={anchor} align="center" justify="space-between" gap={8} className="conversation-directory-header" style={{ position: "relative", flexShrink: 0 }}>
      <Flex align="center" gap={8}><WandButton kind="ghost" size="small" onClick={() => { setCreate(false); conversationUi.directory(false); }}>返回对话</WandButton><Typography.Title level={2}>通讯录</Typography.Title></Flex>
      <CopyPageLink/>
      {GROUP_CHAT_VISIBLE ? <WandButton ref={trigger} kind="primary" size="small" aria-label={create ? "关闭建群" : "发起群聊"} aria-expanded={create}
        onClick={() => { setPresetId(""); setCreate(!create); }}><ConversationMorphIcon from="plus" to="close" active={create}/>{create ? "关闭建群" : "发起群聊"}</WandButton>
        : null}
      {GROUP_CHAT_VISIBLE ? <ConversationPanel open={create} owner="directory-group-panel" anchorRef={anchor} triggerRef={trigger} onClose={() => setCreate(false)}>
        <GroupEditor open={create} owner="directory-group-panel" presetId={presetId || undefined} onCancel={() => setCreate(false)}
          onCreated={id => { setCreate(false); onSelect(id, true); }}/>
      </ConversationPanel> : null}
    </Flex>
    <Flex gap={8} align="center" wrap className="conversation-directory-toolbar">
      <WandStretchTabs value={tab} onValueChange={value => { setCreate(false); setTab(value as "employees" | "presets"); }} ariaLabel="通讯录分类"
        tabs={[{ value: "employees", label: "员工" }, { value: "presets", label: "团队模板" }]}/>
      <div className="conversation-directory-search"><WandSearchField label="搜索通讯录" placeholder="搜索员工或团队模板" value={query} onValueChange={setQuery}/></div>
      <WandButton kind="ghost" size="small" className="conversation-directory-manage" onClick={() => taskBoardController.open("", "", "teams")}>管理员工与团队模板</WandButton>
    </Flex>
    <div className="conversation-directory-body" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
      {tab === "employees" ? <>
        {error ? <Alert type="error" showIcon role="alert" title="员工加载失败" description={error}
          action={<WandButton size="small" disabled={loading} onClick={reload}>重新加载员工</WandButton>}/> : null}
        {loading ? <Typography.Paragraph type="secondary" role="status">正在读取员工…</Typography.Paragraph> : null}
        {selfVisible ? <Flex key="user" align="center" gap={12} className="conversation-contact-row conversation-self-row">
          <WandIconButton className="conversation-avatar-button" aria-label="查看我的资料" onClick={() => settingsController.open("profile")}><EmployeeAvatar employee={{ id: "user", name: self.name || "我", avatar: self.avatar }} provider="" size="md"/></WandIconButton>
          <WandButton kind="ghost" className="conversation-contact-copy" onClick={() => settingsController.open("profile")}>
            <span><strong className="conversation-contact-name"><span className="conversation-contact-label" title={self.name || "我"}>{self.name || "我"}</span><WandBadge className="wand-self-tag" tone="accent">我</WandBadge></strong><span className="conversation-contact-duty">我的资料 · 消息署名与头像</span></span>
          </WandButton><WandButton kind="ghost" size="small" onClick={() => settingsController.open("profile")}>资料</WandButton>
        </Flex> : null}
        {visibleEmployees.map(e => <Flex key={e.id} align="center" gap={12} className="conversation-contact-row">
          <WandIconButton className="conversation-avatar-button" aria-label={`查看${e.name}的资料`} onClick={event => employeeProfile.open(e, event.currentTarget)}><EmployeeAvatar employee={e} size="md"/></WandIconButton>
          <WandButton kind="ghost" className="conversation-contact-copy" onClick={() => newSessionController.open({ initialEmployeeId: e.id })}>
            <span><strong className="conversation-contact-name" title={e.name}>{e.name}</strong><span className="conversation-contact-duty" title={e.duty || "暂无职责说明"}>{e.duty || "暂无职责说明"}{e.archivedAt ? " · 已归档" : ""}</span>{e.agents[0] ? <span className="conversation-contact-engine">{employeeCliLabel(e.agents[0].provider, e.agents[0].engine)}{e.agents.length > 1 ? ` · ${e.agents.length - 1} 个备用` : ""}</span> : null}</span>
          </WandButton><WandButton kind="ghost" size="small" onClick={event => employeeProfile.open(e, event.currentTarget)}>资料</WandButton>
        </Flex>)}
        {!loading && !error && employees.length > 0 && !visibleEmployees.length ? <Typography.Paragraph type="secondary" role="status">没有匹配的员工，试试其他名称或清空搜索。</Typography.Paragraph> : null}
        {!loading && !error && !employees.length ? <Typography.Paragraph type="secondary">还没有员工，可以通过管理入口创建。</Typography.Paragraph> : null}
      </> : <>
        {teamSource.error ? <Alert type="error" showIcon role="alert" title="团队模板加载失败" description={teamSource.error}
          action={<WandButton size="small" disabled={teamSource.loading} onClick={teamSource.reload}>重新加载团队模板</WandButton>}/> : null}
        {teamSource.loading ? <Typography.Paragraph type="secondary" role="status">正在读取团队模板…</Typography.Paragraph> : null}
        {visibleTeams.map(t => <div key={t.id}>
          <WandButton kind="ghost" className="conversation-preset-row" aria-expanded={expanded.includes(t.id)} onClick={() => toggle(t.id)}>
            <Flex vertical><Typography.Text strong>{t.name} · 团队模板</Typography.Text><Typography.Text type="secondary">{t.members.length} 位员工 · 负责人 {t.members.find(m => m.isLeader)?.name || "未设置"}</Typography.Text></Flex>
          </WandButton>
          <div className="conversation-inline-detail" data-open={expanded.includes(t.id)} inert={!expanded.includes(t.id)}><div>
            <PresetDetails team={t}/>{GROUP_CHAT_VISIBLE ? <WandButton onClick={() => { setPresetId(t.id); setCreate(true); trigger.current?.focus({ preventScroll: true }); }}>用此模板发起群聊</WandButton> : null}
          </div></div>
        </div>)}
        {!teamSource.loading && !teamSource.error && teams.length > 0 && !visibleTeams.length ? <Typography.Paragraph type="secondary" role="status">没有匹配的团队模板，试试其他名称或清空搜索。</Typography.Paragraph> : null}
        {!teamSource.loading && !teamSource.error && !teams.length ? <Typography.Paragraph type="secondary">{GROUP_CHAT_VISIBLE ? "还没有团队模板，可以直接选择员工发起群聊。" : "还没有团队模板，可以通过管理入口创建。"}</Typography.Paragraph> : null}
      </>}
    </div>
  </Flex>;
}
