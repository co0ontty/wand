import * as React from "react";
import { createRoot } from "react-dom/client";
import { WandUiProvider } from "../../../src/web-ui/react/theme";
import { setWandTheme } from "../../../src/web-ui/react/theme-preference";
import { installReactUiStyles } from "../../../src/web-ui/react/styles";
import { PortalContainerProvider, WandButton } from "../../../src/web-ui/react/ui";
import { TaskBoardHost } from "../../../src/web-ui/react/issues/task-board-host";
import { taskBoardController } from "../../../src/web-ui/react/issues/task-board-controller";
import { taskBoardRepository, type WandTaskListed } from "../../../src/web-ui/react/issues/task-board-repository";

const workspace = { id: "preview-workspace", name: "Wand 工作台", cwd: "/示例/Wand" };
const agent = { provider: "pi", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" } as const;
const stamp = "2026-11-02T08:00:00.000Z";
const titles = [
  "整理任务面板的布局与信息层级", "让长标题和多位执行者在窄列中也能读清", "补齐键盘导航和筛选关闭路径",
  "统一桌面端卡片与工具栏", "核对任务状态与实际执行情况", "为评论入口保留独立的点击区域",
  "优化任务面板的原位展开与阅读恢复", "调整归档与交付按钮的布局", "处理有验收缺口的任务",
  "验证四种任务视图的状态一致性", "检查过滤菜单中的搜索与选择", "对齐 Web 与 Mac 的信息顺序",
  "完成多宽度任务看板验收", "核对交付证据与人工确认", "核对主目标的整体验收", "归档已接受的交付",
];
const statuses = ["backlog", "todo", "doing", "review", "ready", "archived"] as const;
const tasks: WandTaskListed[] = titles.map((title, index) => {
  const status = statuses[Math.min(5, Math.floor(index / 3))]!;
  const people = index === 7 || index === 12 ? ["小林", "阿禾", "小夏", "明远"] : index < 3 ? [] : ["小林"];
  const sessions = people.map((name, person) => ({ id: `preview-session-${index}-${person}`, employeeId: `preview-person-${person}`, employeeName: name,
    provider: "pi", title: `${name} · ${title}`, status: index === 6 ? "running" : "idle", sessionKind: "structured", cwd: workspace.cwd, model: "default", thinkingEffort: "off" }));
  return { id: `preview-task-${index}`, identifier: `DEMO-${index + 1}`, title, description: "这是一条示例任务，用于比较任务面板的排版和交互。\n\n展开后可以查看完整说明、负责人、标签和所有关联会话；关闭侧边详情仍保留看板中的阅读位置。",
    titleSource: "user", autoTitleSignature: null, workspaceId: workspace.id, workspaceTaskId: null, parentTaskId: null, workspace, status,
    priority: index % 3 === 0 ? "high" : "medium", labels: index === 1 ? ["界面与交互", "一个很长的标签用于验证换行", "待验证"] : [index % 2 ? "体验" : "界面", "待验证"],
    dueDate: index % 4 === 0 ? "2026-11-06" : null, milestoneId: "preview-milestone", milestone: { id: "preview-milestone", name: index % 3 === 0 ? "默认迭代" : "桌面体验优化" },
    sortOrder: index, agent: people.length ? agent : null, archivedAt: status === "archived" ? stamp : null, createdAt: stamp, updatedAt: stamp,
    assignedExecutor: people.length ? { id: "preview-person-0", name: "小林" } : null, sessions, sessionIds: sessions.map(session => session.id), commentCount: index * 2,
    executionStatus: index === 6 ? "running" : index === 7 ? "queued" : undefined, queuedExecutionCount: index === 7 ? 2 : 0, deliveryRevision: 1,
    acceptance: { evidence: index >= 9 ? "示例交付：已完成布局核对。" : "", blocker: index === 8 ? "仍需核对窄窗口下的操作区域，验收后再提交交付。" : "", acceptedAt: status === "archived" ? stamp : null, confirmedRevision: status === "archived" ? 1 : undefined },
    verification: status === "ready" || status === "archived" ? { verdict: "passed", evidence: "示例 AI 核对记录", blocker: "", revision: 1, reviewedAt: stamp, sourceSessionId: null, reviewerId: null } : null,
  };
});
tasks.push({ ...tasks[6]!, id: "preview-child", identifier: "DEMO-17", title: "核对原位展开与返回路径", parentTaskId: tasks[6]!.id, sessions: [], sessionIds: [] });

// The preview never forwards requests to the installed service or a model.
window.fetch = async (_input, init) => {
  const method = init?.method ?? "GET";
  if (method !== "GET") return Response.json({ error: "交互预览不执行保存或派发。" }, { status: 403 });
  const url = String(_input);
  const body = url.includes("/silicon-employees") ? { employees: [] }
    : url.includes("/comments") ? { comments: [], totalCount: 0, nextCursor: null }
    : url.includes("/ai-teams") || url.includes("/actions") ? []
    : url.includes("/workspaces") ? [workspace] : url.includes("/milestones") ? [tasks[0]!.milestone]
    : url.includes("/models") ? { models: [] } : url.includes("/wand-tasks/") ? tasks.find(task => url.includes(task.id)) ?? {}
    : url.includes("/wand-tasks") ? tasks : {};
  return Response.json(body);
};
Object.assign(taskBoardRepository, { list: async () => tasks, workspaces: async () => [workspace], models: async () => ({ models: [] }), agentDefaults: async () => agent });
(window as unknown as Record<string, unknown>).__wandAiTeamsChunk = { TaskTeamRunPanel: () => null };
installReactUiStyles();
taskBoardController.open();

function App() {
  const [dark, setDark] = React.useState(false);
  return <WandUiProvider><div className="taskboard-preview-banner"><span>交互预览 · 固定示例数据 · 不保存、不派发</span><WandButton size="small" onClick={() => { setDark(!dark); setWandTheme(dark ? "warm" : "graphite"); }}>查看{dark ? "浅色" : "深色"}</WandButton></div>
    <div className="taskboard-preview-stage"><TaskBoardHost onBack={() => {}} onOpenSession={() => {}}/></div>
  </WandUiProvider>;
}
createRoot(document.getElementById("root")!).render(<PortalContainerProvider container={document.getElementById("portals")}><App/></PortalContainerProvider>);
