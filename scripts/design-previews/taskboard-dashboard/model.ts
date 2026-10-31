import { columns, transition, type Stage, type Action, type DemoTask } from "../task-review-flow/model.ts";
export { columns };
export type { Stage, Action };
export const TODAY = "2026-10-28";
export type View = "dashboard" | "board" | "list" | "gantt" | "archive";
export interface Task extends DemoTask {
  owner: string;
  priority: "高" | "中" | "低";
  tags: string[];
  parentId: string | null;
  runtime: "running" | "queued" | "idle";
  start: string | null;
  due: string | null;
  acceptedOn: string | null;
  description: string;
}
export const stageNames: Record<Stage, string> = { backlog: "待立项", todo: "等待认领", doing: "执行中", review: "待验收", ready: "待归档", archived: "已归档" };
const entries: [string, Stage, string, Task["priority"], string[]][] = [
  ["任务全局搜索与快捷定位", "backlog", "未指派", "中", ["体验"]],
  ["移动端离线查看任务报告", "backlog", "未指派", "低", ["移动端"]],
  ["任务依赖关系可视化", "backlog", "未指派", "低", ["规划"]],
  ["完善验收报告的证据模板", "todo", "瑞辰", "高", ["验收"]],
  ["统一桌面端任务筛选入口", "todo", "赛博虎妞", "中", ["Web", "Mac"]],
  ["补齐任务操作的键盘路径", "todo", "瑞辰", "中", ["体验"]],
  ["任务面板状态与验收链路重构", "doing", "赛博虎妞", "高", ["任务面板"]],
  ["验收结果安全回填与版本校验", "doing", "赛博虎妞", "高", ["服务端"]],
  ["修复窄屏任务操作区遮挡", "doing", "瑞辰", "高", ["验收退回", "Web"]],
  ["移动端任务详情信息对齐", "doing", "赛博虎妞", "中", ["移动端"]],
  ["任务看板子任务就地展开", "review", "瑞辰", "高", ["任务面板"]],
  ["多会话交付汇总与来源定位", "review", "瑞辰", "中", ["验收"]],
  ["归档历史查询与只读查看", "review", "赛博虎妞", "中", ["历史"]],
  ["待发送队列草稿保护", "ready", "赛博虎妞", "高", ["输入体验"]],
  ["新建任务默认配置的作用范围", "ready", "瑞辰", "中", ["任务面板"]],
  ["长任务名称显示与完整值查看", "ready", "赛博虎妞", "低", ["体验"]],
  ["任务详情返回时保留阅读位置", "archived", "赛博虎妞", "中", ["体验"]],
  ["移除任务目录的重复图标", "archived", "赛博虎妞", "低", ["精简"]],
  ["统一归档目录与恢复提示", "archived", "瑞辰", "中", ["历史"]],
  ["评论与执行记录分区", "archived", "瑞辰", "中", ["任务面板"]],
];
export const fixtures: Task[] = entries.map(([title, stage, owner, priority, tags], index) => ({
  id: `DEMO-${String(index + 1).padStart(2, "0")}`, title, stage, owner, priority, tags, parentId: null,
  evidence: ["review", "ready", "archived"].includes(stage) ? "【示例证据】交付范围已核对；桌面与窄屏交互记录、回归结果及产物版本已汇总。本页演示资料，不代表线上任务通过。" : "",
  gap: index === 8 ? "320px 下操作按钮被裁切，需要修复后重新提交。" : "",
  aiPassed: stage === "ready" || stage === "archived", humanAccepted: stage === "archived",
  runtime: index === 6 || index === 7 || index === 10 ? "running" : index === 9 ? "queued" : "idle",
  start: index > 2 ? `2026-10-${20 + index % 6}` : null,
  due: index > 2 && index % 3 !== 0 ? `2026-10-${27 + index % 5}` : null,
  acceptedOn: stage === "archived" ? `2026-10-${23 + index % 5}` : null,
  description: `示例目标：${title}。保持已有输入、历史和执行上下文；按任务范围验证交互，报告列出版本、证据与未验证项。\n验收标准：关键动作可达；桌面与窄屏行为一致；错误不丢草稿；AI 验收与人工确认分开记录。`,
  history: [stage === "archived" ? "用户明确确认交付，任务已归档。" : stage === "ready" ? "AI 验收通过，等待用户检查交付并确认。" : stage === "review" ? "执行者已提交交付，正在等待 AI 验收结论。" : "示例任务已创建；运行状态与业务阶段分别表达。"],
}));
fixtures.push(...["Web 五阶段看板", "Mac 状态语义对齐", "AI 验收回填测试"].map((title, index): Task => ({
  ...fixtures[index === 2 ? 18 : 10], id: `DEMO-07.${index + 1}`, title, parentId: "DEMO-07", stage: index === 2 ? "archived" : index === 1 ? "review" : "doing", aiPassed: index === 2, humanAccepted: index === 2, runtime: "idle", acceptedOn: index === 2 ? "2026-10-27" : null,
})));
export interface Filters { query: string; stages: Stage[]; owner: string; onlyGaps: boolean; }
export const emptyFilters: Filters = { query: "", stages: [], owner: "all", onlyGaps: false };
export function matches(task: Task, filters: Filters): boolean {
  return (!filters.query.trim() || `${task.id} ${task.title} ${task.tags.join(" ")}`.toLowerCase().includes(filters.query.trim().toLowerCase()))
    && (!filters.stages.length || filters.stages.includes(task.stage)) && (filters.owner === "all" || filters.owner === task.owner) && (!filters.onlyGaps || Boolean(task.gap));
}
export function projectGoals(tasks: Task[], filters: Filters, archived = false): Task[] {
  return tasks.filter(task => !task.parentId && (archived ? task.stage === "archived" : task.stage !== "archived")
    && (matches(task, filters) || tasks.some(child => child.parentId === task.id && matches(child, filters))));
}
export function summary(goals: Task[]) {
  const active = goals.filter(task => task.stage !== "archived");
  const accepted = goals.filter(task => task.humanAccepted).length;
  return { total: goals.length, accepted, percent: goals.length ? Math.round(accepted / goals.length * 100) : 0, active: active.length,
    counts: { ...Object.fromEntries(columns.map(column => [column.stage, active.filter(task => task.stage === column.stage).length])), archived: goals.filter(task => task.stage === "archived").length } as Record<Stage, number>,
    aiPassed: goals.filter(task => task.aiPassed).length, gaps: active.filter(task => task.gap).length, running: active.filter(task => task.runtime === "running").length,
    overdue: active.filter(task => task.due && task.due < TODAY).length };
}
export function advance(tasks: Task[], id: string, action: Action, evidence: string, gap: string): Task[] {
  const task = tasks.find(item => item.id === id);
  if (!task) throw new Error("示例任务不存在。");
  const children = tasks.filter(child => child.parentId === id);
  if (action === "pass" && children.some(child => !child.aiPassed)) throw new Error("子任务尚未完成 AI 验收，主目标不能通过。");
  if (action === "archive" && children.some(child => !child.humanAccepted)) throw new Error("请先确认子任务，再确认主目标交付。");
  if (task.runtime !== "idle") throw new Error("仍有运行或排队执行；请先在演示中结束执行，再操作验收。");
  const next = transition(task, action, evidence, gap);
  return tasks.map(item => item.id === id ? { ...task, ...next, acceptedOn: next.humanAccepted ? TODAY : null } : item);
}
