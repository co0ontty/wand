import * as React from "react";

import { Collapse, Alert, Flex, Input } from "antd";
import type { IssueWorkspace } from "../issues/task-board-agent";
import { WandButton, WandIcon, WandSelect } from "../ui";
import { SettingsField } from "../settings/fields";
import type { AiTeamDispatchRun } from "./repository";
import { defaultTeamStartProject, teamStartProjects } from "./team-start-projects";

/**
 * 派工流程与建议名单区住在主包里（`react/team-dispatch/roster.tsx`）：
 * 通讯录面板、看板新建任务、任务详情指派三处共用同一份；按需脚本通过宿主注册表借用。
 * 这里只保留团队页专属的入口按钮与面板外壳。
 */
type DispatchPhase = "idle" | "planning" | "planned" | "starting" | "started" | "failed";

interface TeamDispatchFlowLike {
  phase: DispatchPhase;
  plan: unknown;
  selection: { members: Array<{ employeeId: string }>; leaderId: string };
  message: string;
  maxMembers: number;
  busy: boolean;
  hasPlan: boolean;
  updateMaxMembers(value: number): void;
  resetResults(): void;
  planNow(note: string): Promise<void>;
  startNow(workspaceId: string, note: string): Promise<AiTeamDispatchRun | null>;
}

interface DispatchHost {
  useTeamDispatchFlow(initialMaxMembers?: number): TeamDispatchFlowLike;
  TeamDispatchRoster(props: {
    flow: TeamDispatchFlowLike;
    blockedReason?: string;
    showMaxMembers?: boolean;
  }): React.ReactElement;
  TeamDispatchActionButton(props: {
    flow: TeamDispatchFlowLike;
    blockedReason: string;
    canPlan: boolean;
    onClick(): void;
  }): React.ReactElement;
  dispatchStartBlockedReason(input: {
    selection: TeamDispatchFlowLike["selection"];
    workspaceId: string;
    note: string;
    busy: boolean;
  }): string;
}

const dispatchHost = (): DispatchHost => {
  const host = (globalThis as { __wandAiTeamsHost?: (key: string) => unknown }).__wandAiTeamsHost?.("team-dispatch/roster");
  if (!host) throw new Error("主包未提供派工共享模块。");
  return host as DispatchHost;
};

/**
 * 临时派工的入口按钮：留在页头（与「新建团队」同行）不动。
 * 面板本体由 `TeamDispatchPanel` 渲染在页头下方，所以展开不会拉宽页头、也不会把按钮挤走。
 */
export function TeamDispatchTrigger({ open, onToggle, busy }: {
  open: boolean;
  onToggle(): void;
  busy: boolean;
}): React.ReactElement {
  return <WandButton
    className="task-board-create-button wand-dispatch-trigger"
    kind="ghost"
    size="small"
    aria-pressed={open}
    aria-expanded={open}
    disabled={busy}
    onClick={onToggle}
  >
    <WandIcon name="brain" slot="start" className="wand-teams-create-icon"/>
    <span>临时派工</span>
  </WandButton>;
}

/**
 * 无指派派工：不选员工，直接写开工说明，由本机决策模型给出建议名单，确认后才开工。
 * 触发按钮在页头不动（`TeamDispatchTrigger`），面板在页头下方原位长出，收起是同一段动画倒放；
 * 三条关闭路径：再点触发点 / Esc / 点到面板外；提交结果留在原位，不用 Toast。
 */
export function TeamDispatchPanel({
  open,
  onOpenChange,
  onBusyChange,
  projects,
  projectsLoaded,
  onStarted,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** 让页头的触发按钮跟着变禁用，但不用把整个面板状态提到页面。 */
  onBusyChange?(busy: boolean): void;
  projects: readonly IssueWorkspace[];
  projectsLoaded: boolean;
  onStarted(started: AiTeamDispatchRun): void;
}): React.ReactElement {
  const host = dispatchHost();
  const flow = host.useTeamDispatchFlow();
  const startable = teamStartProjects(projects);
  const [settled, setSettled] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [workspaceId, setWorkspaceId] = React.useState("");
  const panelRef = React.useRef<HTMLDivElement>(null);
  const noteRef = React.useRef<React.ComponentRef<typeof Input.TextArea>>(null);
  const innerRef = React.useRef<HTMLDivElement>(null);
  const projectMenuClass = "wand-dispatch-project-menu-" + React.useId();
  const pickedProject = workspaceId || defaultTeamStartProject(projects);
  const busy = flow.busy;
  const blockedReason = host.dispatchStartBlockedReason({
    selection: flow.selection,
    workspaceId: pickedProject,
    note,
    busy,
  });

  React.useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  React.useLayoutEffect(() => {
    if (!open || settled) return undefined;
    // 双帧：先画一帧收起态，下一帧放开并聚焦，过渡才有起点（与团队卡「直接开工」同法）。
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        setSettled(true);
        // preventScroll 是必须的：展开中的容器是 overflow:hidden（可编程滚动），
        // 不让浏览器为了“把焦点滚入视野”把面板内容顶出可视区。
        noteRef.current?.focus({ preventScroll: true });
        if (innerRef.current) innerRef.current.scrollTop = 0;
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [open, settled]);

  React.useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (panelRef.current?.contains(event.target as Node)) return;
      // 自绘 select 的弹层在 portal 里：只认本面板那个弹层，其它外点照旧收起。
      if (event.target instanceof Element
        && event.target.closest(".wand-ui-select-content")?.classList.contains(projectMenuClass)) return;
      collapse();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Esc 要在 window 捕获阶段拦：焦点经常在页头的触发按钮上（不在本组件子树里），
      // 而且页头自己也有 Esc 返回的快捷键——面板开着时那一下归面板。
      event.preventDefault();
      event.stopPropagation();
      collapse();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, projectMenuClass]);

  function collapse(): void {
    if (busy) return;
    onOpenChange(false);
    setSettled(false);
  }

  return <div ref={panelRef} className="wand-dispatch-root">
    <Collapse ghost bordered={false} className="wand-team-candidate-slot" activeKey={settled ? ["dispatch"] : []}
      styles={{ header: { display: "none" }, body: { padding: 0 } }}
      items={[{ key: "dispatch", label: "团队派工", showArrow: false, forceRender: true, children: <>
      <Flex vertical gap={10} style={{ minWidth: 0, paddingTop: 10 }} className="wand-team-member-inner" ref={innerRef} inert={!open}>
        <Flex vertical gap={12}>
          {startable.length === 0 ? (
            projectsLoaded
              ? <Alert type="error" showIcon role="alert" title="还没有可开工的项目，先在工作区创建一个项目。"/>
              : <Alert type="info" showIcon title="正在加载项目…"/>
          ) : <>
            <Alert
              type="info"
              showIcon
              title="不指派员工：写清要做什么，让本机决策模型按职责与标签给出建议名单，确认后才开工。"
            />
            <SettingsField label="项目">
              <div className="wand-team-select">
              <WandSelect
                ariaLabel="派工项目"
                contentClassName={projectMenuClass}
                value={pickedProject}
                disabled={busy}
                searchable
                searchPlaceholder="搜索项目"
                options={startable.map((project) => ({
                  value: project.id, label: `${project.name} · ${project.cwd}`,
                }))}
                onValueChange={(value) => {
                  setWorkspaceId(value);
                  flow.resetResults();
                }}
              />
              </div>
            </SettingsField>
            <SettingsField
              label="开工说明"
              htmlFor="wand-dispatch-note"
              hint="会建一张任务卡；这段话是决策判断与团队执行的唯一目标。"
            >
              <Input.TextArea
                id="wand-dispatch-note"
                ref={noteRef}
                className="wand-ai-team-duty"
                rows={2}
                value={note}
                placeholder="例如：给后台加一个可搜索的模型下拉，补单测并跑通构建。"
                disabled={busy}
                onChange={(event) => setNote(event.target.value)}
              />
            </SettingsField>
            <Flex gap={8} wrap>
              <host.TeamDispatchActionButton
                flow={flow}
                canPlan={note.trim().length > 0}
                blockedReason={blockedReason}
                onClick={() => {
                  if (!flow.hasPlan) {
                    void flow.planNow(note);
                    return;
                  }
                  // 成功后收起是收起态的倒放；说明清空，名单由共享流程自己清。
                  void flow.startNow(pickedProject, note).then((started) => {
                    if (!started) return;
                    onOpenChange(false);
                    setSettled(false);
                    setNote("");
                    onStarted(started);
                  });
                }}
              />
            </Flex>
            <host.TeamDispatchRoster flow={flow} blockedReason={blockedReason}/>
          </>}
        </Flex>
      </Flex>
          </> }]}/>
  </div>;
}
