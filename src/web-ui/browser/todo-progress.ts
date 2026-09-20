// 待办进度条的纯渲染逻辑。
//
// 这里只产出字符串和统计值，不碰 DOM，好处是能在 Node 单测里直接跑（chat-render.ts
// 里的 updateTodoProgress 依赖 state / 真实节点，测不到）。进度条的 DOM 契约（元素 id、
// 状态 class）在 render.ts + chat-render.ts + styles.css 之间共享，所以状态到 class
// 的映射只留这一份，三处都从这里取。
import { iconSvg } from "./i18n";
import { escapeHtml } from "./text-escape";

export interface TodoEntry {
  content?: string;
  activeForm?: string;
  status?: string;
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoProgressSummary {
  total: number;
  completed: number;
  inProgress: number;
  /** 收起态右侧那个任务文案；无进行中项时回退到下一条 pending。 */
  activeTask: string;
  ratio: number;
  allDone: boolean;
}

/** status 缺失或拼错一律按 pending 处理，别让脏数据把进度条算歪。 */
export function normalizeTodoStatus(status?: string): TodoStatus {
  return status === "completed" || status === "in_progress" ? status : "pending";
}

export function summarizeTodoProgress(todos: readonly TodoEntry[]): TodoProgressSummary {
  let completed = 0;
  let inProgress = 0;
  let activeTask = "";
  for (const todo of todos) {
    const status = normalizeTodoStatus(todo.status);
    if (status === "completed") completed += 1;
    if (status !== "in_progress") continue;
    inProgress += 1;
    if (!activeTask) activeTask = todo.activeForm || todo.content || "";
  }
  // 首条全 pending 的 TodoWrite（模型还没标 in_progress）或模型漏发 activeForm 时，
  // 回退到下一条待办文案——总比一片空白强。
  if (!activeTask) {
    const next = todos.find((todo) =>
      normalizeTodoStatus(todo.status) === "pending" && !!(todo.activeForm || todo.content));
    activeTask = next ? (next.activeForm || next.content || "") : "";
  }
  const total = todos.length;
  return {
    total,
    completed,
    inProgress,
    activeTask,
    ratio: total > 0 ? completed / total : 0,
    allDone: total > 0 && completed === total,
  };
}

/**
 * 三态统一的 class 名（done / active / pending）。
 * 列表行、行内图标、分段进度条都认这一套，pending 也显式带类名——
 * 少了它 DOM 里就看不出这一项到底是「待办」还是状态没解析出来。
 */
export function todoStateClass(status?: string): "pending" | "active" | "done" {
  const normalized = normalizeTodoStatus(status);
  return normalized === "completed" ? "done" : normalized === "in_progress" ? "active" : "pending";
}

/**
 * 分段进度条：一段一项，一眼看出「做完几项、当前卡在第几项」。
 * 段宽靠 CSS 的 flex:1 平分，项数再多也不会溢出。
 */
export function buildTodoSegmentsHtml(todos: readonly TodoEntry[]): string {
  return todos.map((todo) =>
    '<span class="todo-progress-seg ' + todoStateClass(todo.status) + '"></span>',
  ).join("");
}

/**
 * 展开面板的清单。
 *
 * 每行只画一层图标：形状由 iconSvg 给、颜色由 .todo-item-icon.<status> 给。
 * 旧实现同时在 CSS 里用 ::after 画了第二个勾/圆点，与 SVG 叠在一起，18px 的
 * 框里糊成一团——别再把装饰性内容加回 CSS。
 */
export function buildTodoItemsHtml(todos: readonly TodoEntry[]): string {
  return todos.map((todo) => {
    const status = normalizeTodoStatus(todo.status);
    const iconName = status === "completed" ? "check" : "circle";
    const iconStroke = status === "completed" ? 2.4 : status === "in_progress" ? 3 : 1.8;
    return '<li class="todo-progress-item ' + todoStateClass(todo.status) + '"' +
        (status === "in_progress" ? ' aria-current="step"' : "") + '>' +
      '<span class="todo-item-icon ' + todoStateClass(todo.status) + '">' +
        iconSvg(iconName, { size: 13, strokeWidth: iconStroke }) +
      '</span>' +
      '<span>' + escapeHtml(todo.content || "") + '</span>' +
    '</li>';
  }).join("");
}
