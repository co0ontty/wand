import type { IssueWorkspace } from "../issues/task-board-agent";

/**
 * 可直接开工 / 派工的项目：全局工作区会被服务端 400 掉（§4.2 R2），前端也不给它留口子。
 * 单独成模块是为了让「直接开工」与「临时派工」两个入口共用同一份规则，而不是互相 import
 * （团队页已经 import 派工面板，反向再 import 团队页会成环）。
 */
export function teamStartProjects(projects: readonly IssueWorkspace[]): IssueWorkspace[] {
  return projects.filter((project) => project.kind !== "global");
}

/** 缺省项目 = 列表第一个（服务端按创建时间倒序返回，也就是「最近一个」）；没有则 ""。 */
export function defaultTeamStartProject(projects: readonly IssueWorkspace[]): string {
  return teamStartProjects(projects)[0]?.id ?? "";
}
