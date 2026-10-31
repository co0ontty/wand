/** Business hierarchy only. Sessions and execution attempts never add a level. */
export interface TaskHierarchyNode { id: string; parentTaskId: string | null; workspaceId: string | null; status?: string }

export function assertTaskHierarchy(
  tasks: readonly TaskHierarchyNode[], childId: string | null, parentId: string | null,
  workspaceId: string | null, existing?: TaskHierarchyNode,
): void {
  // Unchanged legacy links remain editable; never silently repair historical data.
  if (existing && existing.parentTaskId === parentId && existing.workspaceId === workspaceId) return;
  if (!parentId) {
    if (childId && tasks.some(t => t.parentTaskId === childId && t.workspaceId !== workspaceId)) {
      throw new Error("请先调整子任务归属，再移动主任务的工作区。");
    }
    return;
  }
  const byId = new Map(tasks.map(t => [t.id, t]));
  const parent = byId.get(parentId);
  if (!parent) throw new Error("父任务不存在。");
  if (parent.status === "archived") throw new Error("归档任务不能作为新的父任务，请先取消归档。");
  const seen = new Set<string>();
  let cursor: string | null = parentId;
  while (cursor) {
    if (cursor === childId || seen.has(cursor)) throw new Error("父任务不能自引用或形成循环。");
    seen.add(cursor); cursor = byId.get(cursor)?.parentTaskId ?? null;
  }
  if (parent.workspaceId !== workspaceId) throw new Error("父任务必须与子任务属于同一项目目录。");
  if (parent.parentTaskId) throw new Error("业务任务最多两层，子任务不能再有子任务。");
  if (childId && tasks.some(t => t.parentTaskId === childId)) throw new Error("带子任务的主任务不能直接降为子任务。");
}

/** Keep roots when any descendant matches; legacy depth remains reachable without rewriting it. */
export function taskGoalProjection<T extends { id: string; parentTaskId: string | null }>(all: readonly T[], matched: readonly T[]): T[] {
  const byId = new Map(all.map(t => [t.id, t]));
  const roots = new Set<string>();
  for (const task of matched) {
    let root = task; const seen = new Set([root.id]);
    while (root.parentTaskId && byId.has(root.parentTaskId) && !seen.has(root.parentTaskId)) {
      root = byId.get(root.parentTaskId)!; seen.add(root.id);
    }
    roots.add(root.id);
  }
  return all.filter(t => roots.has(t.id));
}

/** A filtered parent remains context for unfinished descendants, including legacy depth. */
export function taskHasOpenDescendant(tasks: readonly Pick<TaskHierarchyNode, "id" | "parentTaskId" | "status">[], id: string): boolean {
  const children = new Map<string, typeof tasks[number][]>();
  for (const task of tasks) if (task.parentTaskId) { const bucket = children.get(task.parentTaskId) ?? []; bucket.push(task); children.set(task.parentTaskId, bucket); }
  const pending = [...(children.get(id) ?? [])], seen = new Set([id]);
  while (pending.length) {
    const child = pending.pop()!;
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    if (child.status !== "archived") return true;
    pending.push(...(children.get(child.id) ?? []));
  }
  return false;
}
