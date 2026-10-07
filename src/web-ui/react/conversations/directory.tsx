import * as React from "react";
import { Flex, Typography } from "antd";
import { employeeConversationId } from "../../../conversation-types.js";
import { employeeProfile } from "../agents/employee-profile";
import { EmployeeAvatar } from "../agents/employee-avatar";
import { useSiliconEmployees } from "../agents/employee-repository";
import { useAiTeamList } from "../ai-teams/repository";
import { taskBoardController } from "../issues/task-board-controller";
import { WandButton, WandIconButton, WandInput, WandStretchTabs } from "../ui";
import { ConversationMorphIcon, ConversationPanel } from "./controls";
import { GroupEditor, PresetDetails } from "./group-editor";
import { conversationUi } from "./state";

export function ConversationDirectory({ onSelect }: { onSelect(id: string, focusComposer?: boolean): void }): React.ReactElement {
  const { employees, error, loading } = useSiliconEmployees({ includeArchived: true });
  const teams = useAiTeamList(true);
  const [tab, setTab] = React.useState("employees");
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState<string[]>([]);
  const [create, setCreate] = React.useState(false);
  const [presetId, setPresetId] = React.useState("");
  const anchor = React.useRef<HTMLDivElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const toggle = (id: string): void => setExpanded(values => values.includes(id) ? values.filter(v => v !== id) : [...values, id]);
  const match = (text: string): boolean => text.toLowerCase().includes(query.trim().toLowerCase());
  return <Flex vertical className="conversation-directory" style={{ height: "100%", minHeight: 0 }}>
    <Flex ref={anchor} align="center" justify="space-between" gap={8} className="conversation-directory-header" style={{ position: "relative", flexShrink: 0, padding: 16 }}>
      <WandButton onClick={() => { setCreate(false); conversationUi.directory(false); }}>返回对话</WandButton><Typography.Text strong>通讯录</Typography.Text>
      <WandIconButton ref={trigger} aria-label={create ? "关闭建群" : "发起群聊"} aria-expanded={create} style={{ width: 44, height: 44 }}
        onClick={() => { setPresetId(""); setCreate(!create); }}><ConversationMorphIcon from="plus" to="close" active={create}/></WandIconButton>
      <ConversationPanel open={create} owner="directory-group-panel" anchorRef={anchor} triggerRef={trigger} onClose={() => setCreate(false)}>
        <GroupEditor open={create} owner="directory-group-panel" presetId={presetId || undefined} onCancel={() => setCreate(false)}
          onCreated={id => { setCreate(false); onSelect(id, true); }}/>
      </ConversationPanel>
    </Flex>
    <Flex gap={8} align="center" wrap style={{ padding: "0 16px 8px" }}>
      <WandStretchTabs value={tab} onValueChange={value => { setCreate(false); setTab(value); }} ariaLabel="通讯录分类"
        tabs={[{ value: "employees", label: "员工" }, { value: "presets", label: "预设小组" }]}/>
      <WandInput aria-label="搜索通讯录" placeholder="搜索员工或预设" value={query} onChange={e => setQuery(e.currentTarget.value)}/>
      <WandButton onClick={() => taskBoardController.open("", "", "teams")}>管理员工 / 预设</WandButton>
    </Flex>
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16 }}>
      {tab === "employees" ? <>
        {employees.filter(e => match(`${e.name} ${e.duty} ${e.id}`)).map(e => <Flex key={e.id} align="center" gap={12} className="conversation-contact-row">
          <WandIconButton className="conversation-avatar-button" aria-label={`查看${e.name}的资料`} onClick={event => employeeProfile.open(e, event.currentTarget)}><EmployeeAvatar employee={e} size="chat"/></WandIconButton>
          <WandButton kind="ghost" className="conversation-contact-copy" onClick={() => onSelect(employeeConversationId(e.id))}>
            <span><strong>{e.name}</strong><span className="conversation-contact-duty">{e.duty || "暂无职责说明"}{e.archivedAt ? " · 已归档" : ""}</span></span>
          </WandButton><WandButton kind="ghost" onClick={event => employeeProfile.open(e, event.currentTarget)}>资料</WandButton>
        </Flex>)}
        {!!employees.length && !employees.some(e => match(`${e.name} ${e.duty} ${e.id}`)) ? <Typography.Paragraph type="secondary">没有匹配的员工</Typography.Paragraph> : null}
        {!employees.length ? <Typography.Paragraph type="secondary">{loading ? "正在读取联系人" : error || "还没有员工，可以通过管理入口创建。"}</Typography.Paragraph> : null}
      </> : <>
        {(teams ?? []).filter(t => match(`${t.name} ${t.description}`)).map(t => <div key={t.id}>
          <WandButton kind="ghost" className="conversation-preset-row" aria-expanded={expanded.includes(t.id)} onClick={() => toggle(t.id)}>
            <Flex vertical><Typography.Text strong>{t.name} · 预设</Typography.Text><Typography.Text type="secondary">{t.members.length} 位员工 · 负责人 {t.members.find(m => m.isLeader)?.name}</Typography.Text></Flex>
          </WandButton>
          <div className="conversation-inline-detail" data-open={expanded.includes(t.id)} inert={!expanded.includes(t.id)}><div>
            <PresetDetails team={t}/><WandButton onClick={() => { setPresetId(t.id); setCreate(true); trigger.current?.focus({ preventScroll: true }); }}>用此预设建群</WandButton>
          </div></div>
        </div>)}
        {teams?.length === 0 ? <Typography.Paragraph type="secondary">还没有预设小组，可以直接选择员工建群。</Typography.Paragraph> : null}
      </>}
    </div>
  </Flex>;
}
