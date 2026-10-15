import type { ScheduledTaskRunView, ScheduledTaskSummary, TaskSchedule } from "../../../src/scheduled-task-types.js";
import { nextScheduledTime } from "../../../src/scheduled-task-time.js";

/** Explicitly fictional, fixed-clock data. Never read or write the installed service. */
export const PREVIEW_NOW = new Date("2026-10-14T10:30:00+08:00");
export const DISPLAY_ZONE = "Asia/Shanghai";
export const employees = [
  { value: "preview-ops", label: "勤劳的初二", id: "preview-ops", name: "勤劳的初二", avatar: "plush-cat:v1:orange" },
  { value: "preview-partner", label: "赛博虎妞", id: "preview-partner", name: "赛博虎妞", avatar: "plush-cat:v1:silver" },
  { value: "preview-reviewer", label: "代码审查员", id: "preview-reviewer", name: "代码审查员", avatar: "plush:v1:triangle:sage:ink:none" },
];
export const workspaces = [
  { value: "preview-wand", label: "Wand", cwd: "/projects/wand" },
  { value: "preview-diplay", label: "DiPlay", cwd: "/projects/diplay" },
  { value: "preview-notes", label: "个人笔记", cwd: "/projects/notes" },
];

function run(taskId: string, at: string, executionStatus: ScheduledTaskRunView["executionStatus"], error: string | null = null): ScheduledTaskRunView {
  const noSession = executionStatus === "skipped";
  return { id: `${taskId}-${at}`, taskId, requestId: `preview-${taskId}-${at}`, scheduledAt: at, claimedAt: at,
    executionFinishedAt: executionStatus === "running" ? null : at, employeeId: "preview-ops", workspaceId: "preview-wand", cwd: "/projects/wand",
    prompt: "设计预览中的示例执行，未触发真实会话。", state: noSession ? "skipped" : "accepted", receipt: null,
    executionStatus, sessionId: noSession ? null : `preview-session-${taskId}-${Date.parse(at)}`, error };
}

// Fifty explicitly fictional returned records, not an assertion of complete coverage.
// Gaps mean "not provided". Same-day entries model a plan edited/re-arranged earlier.
function sampleChangelogHistory(): ScheduledTaskRunView[] {
  const result = [run("changelog", "2026-10-14T09:00:00+08:00", "completed"), run("changelog", "2026-10-13T09:00:00+08:00", "completed"), run("changelog", "2026-10-12T09:00:00+08:00", "skipped", "上一轮尚未结束，本次触发已跳过。"), run("changelog", "2026-10-11T09:00:00+08:00", "completed")];
  for (let week = 0; week < 11; week++) for (const day of [0, 1, 3, 4]) {
    const date = new Date(Date.UTC(2026, 6, 27 + week * 7 + day)).toISOString().slice(0, 10);
    const status = week === 2 && day === 3 || week === 8 && day === 0 ? "failed" : week === 6 && day === 1 ? "unknown" : week === 9 && day === 4 ? "skipped" : "completed";
    result.push(run("changelog", `${date}T09:00:00+08:00`, status, status === "failed" ? "示例执行失败，请检查关联会话。" : status === "unknown" ? "接收状态待确认，不会自动重发。" : status === "skipped" ? "上一轮未结束，本次已跳过。" : null));
  }
  result.push(run("changelog", "2026-10-09T13:40:00+08:00", "failed", "同日重新安排的示例执行失败。"), run("changelog", "2026-10-08T09:30:00+08:00", "completed"));
  return result.sort((a, b) => Date.parse(b.claimedAt) - Date.parse(a.claimedAt));
}

export const histories: Record<string, ScheduledTaskRunView[]> = {
  changelog: sampleChangelogHistory(),
  review: [run("review", "2026-10-12T10:00:00+08:00", "failed", "项目目录不可用，本次未开始执行。请检查工作区目录。"), run("review", "2026-10-05T10:00:00+08:00", "completed")],
  docs: [run("docs", "2026-10-14T10:00:00+08:00", "running")],
  digest: [run("digest", "2026-10-10T18:30:00+08:00", "completed")],
  archive: [run("archive", "2026-10-13T16:00:00+08:00", "unknown", "接收状态尚未确认，不会自动重发。请到关联会话核对。")],
  completed: [run("completed", "2026-10-13T15:00:00+08:00", "completed")],
};

function task(id: string, title: string, prompt: string, schedule: TaskSchedule, patch: Partial<ScheduledTaskSummary> = {}): ScheduledTaskSummary {
  return { id, title, prompt, creationFingerprint: "preview-only", employeeId: "preview-ops", employeeName: "勤劳的初二",
    workspaceId: "preview-wand", workspaceName: "Wand", workspaceCwd: "/projects/wand", workspaceUnavailableReason: null, employeeUnavailableReason: null,
    schedule, enabled: true, nextRunAt: nextScheduledTime(schedule, PREVIEW_NOW), revision: 1,
    createdAt: "2026-10-01T09:00:00+08:00", updatedAt: "2026-10-14T09:00:00+08:00", cancelledAt: null, lastRun: histories[id]?.[0] ?? null, ...patch };
}

export function initialTasks(): ScheduledTaskSummary[] {
  return [
    task("changelog", "整理每日项目变更", "阅读过去 24 小时的已提交变更，整理新增能力、修复与需要关注的风险。输出一份简明日报，不修改代码或提交记录。", { kind: "daily", time: "09:00", timeZone: DISPLAY_ZONE }, { revision: 3, createdAt: "2026-07-20T09:00:00+08:00" }),
    task("docs", "核对 Web 与 Mac 的交互说明", "对照现有实现核对 Web 与 macOS 的交互说明。列出不一致项，标注源码入口和验证方式；不要部署或重启服务。", { kind: "once", runAt: "2026-10-14T15:00:00+08:00" }, { revision: 2, employeeId: "preview-partner", employeeName: "赛博虎妞" }),
    task("review", "每周依赖与构建检查", "检查依赖清单和构建脚本，汇总潜在风险与需要人工决定的升级。保留未提交的工作，不自动修改依赖。", { kind: "weekly", weekday: 1, time: "10:00", timeZone: DISPLAY_ZONE }, { employeeId: "preview-reviewer", employeeName: "代码审查员", workspaceId: "preview-diplay", workspaceName: "DiPlay", workspaceCwd: "/projects/diplay" }),
    task("digest", "整理阅读笔记", "汇总个人笔记中当天新增的条目，提取重点与待办，保留原文和来源。", { kind: "daily", time: "18:30", timeZone: DISPLAY_ZONE }, { enabled: false, employeeId: "preview-partner", employeeName: "赛博虎妞", workspaceId: "preview-notes", workspaceName: "个人笔记", workspaceCwd: "/projects/notes" }),
    task("archive", "检查归档目录", "只读核对项目归档中的重复文件，列出路径、大小与判断依据。不要删除任何文件。", { kind: "weekly", weekday: 5, time: "17:00", timeZone: DISPLAY_ZONE }, { revision: 2, workspaceId: "preview-missing", workspaceName: "项目归档", workspaceCwd: null, workspaceUnavailableReason: "工作区已删除，请重新选择执行位置。" }),
    task("completed", "整理阶段交付说明", "整理本阶段实际修改、验证结果和未解决事项，保留证据与复现入口。", { kind: "once", runAt: "2026-10-13T15:00:00+08:00" }),
  ];
}
