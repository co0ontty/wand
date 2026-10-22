/**
 * 任务引用（`#TASK-133`）与员工提及（`@赛博虎妞`）的共享解析契约。
 *
 * 规则（Web / iOS / Android 三端必须一致）：
 * - `#` 紧跟一个任务编号（形如 `TASK-133`）构成一个引用标记；`#` 单独出现不是引用，
 *   也不匹配 Markdown 标题（ATX 标题要求 `#` 后有空格）。
 * - 引用只认本任务下挂的子任务（`parentTaskId === 当前任务`），不跨任务、不跨工作区。
 * - 同一段正文里可以出现多个引用，也可以和任意多个 `@员工` 混排；正文整体是本轮指令。
 * - 解析只做「切词」，不判断任务是否存在；存在性由服务端按任务树校验。
 */

/**
 * 任务编号形如 `TASK-133`；前缀允许大写字母与数字，编号必须是数字。
 *
 * `#` 前面必须是行首、空白或开括号（`(` `（` `【` `「` `《`）。这样
 * `做 #TASK-133` 与 `（#TASK-133）` 是引用，而 `a#TASK-133`、
 * `https://x/page#TASK-5` 里的 URL 片段不是——后者会被误当成引用并让服务端报错。
 */
const TASK_REFERENCE_PATTERN = /(^|[\s(（【「《])#([A-Z][A-Z0-9]*-\d+)(?![\w-])/g;

/** 提取正文里出现的任务引用编号，按首次出现顺序去重。 */
export function parseTaskReferenceIds(body: string): string[] {
  const ids: string[] = [];
  for (const match of body.matchAll(TASK_REFERENCE_PATTERN)) {
    const id = match[2];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 正文里是否引用了某个任务编号。 */
export function hasTaskReference(body: string, identifier: string): boolean {
  if (!identifier) return false;
  return parseTaskReferenceIds(body).includes(identifier);
}

/** 正文中某个引用编号的出现次数；用于判断「引用是否还在正文里」。 */
export function countTaskReference(body: string, identifier: string): number {
  if (!identifier) return 0;
  let count = 0;
  for (const match of body.matchAll(TASK_REFERENCE_PATTERN)) if (match[2] === identifier) count += 1;
  return count;
}

/**
 * 服务端校验用：把正文里的引用编号解析成「本任务可引用的子任务」。
 * 只接受本任务的直接子任务；不认识的编号一律不返回，由调用方决定是否报错。
 */
export function resolveTaskReferences(body: string, children: ReadonlyArray<{ id: string; identifier: string }>): Array<{ id: string; identifier: string }> {
  const wanted = parseTaskReferenceIds(body);
  if (!wanted.length) return [];
  const byIdentifier = new Map(children.map(child => [child.identifier, child]));
  return wanted.flatMap(identifier => {
    const child = byIdentifier.get(identifier);
    return child ? [{ id: child.id, identifier: child.identifier }] : [];
  });
}

/** 正文中引用编号是否全部能在给定子任务集合里找到。 */
export function unknownTaskReferenceIds(body: string, children: ReadonlyArray<{ identifier: string }>): string[] {
  const known = new Set(children.map(child => child.identifier));
  return parseTaskReferenceIds(body).filter(identifier => !known.has(identifier));
}

export interface TaskReferenceQuery { start: number; query: string }

/**
 * `#` 开始一个引用 token。光标必须仍在这个 token 内；前面必须是行首或空白，
 * 避免把 `a#TASK-1` 或 URL 片段当成引用。
 */
export function commentReferenceQuery(body: string, caret: number): TaskReferenceQuery | null {
  const index = Math.max(0, Math.min(caret, body.length));
  if (index === 0) return null;
  const at = body.lastIndexOf("#", index - 1);
  if (at < 0) return null;
  if (at > 0 && !/[\s(（【「《]/.test(body[at - 1] ?? "")) return null;
  const query = body.slice(at + 1, index);
  if (/[\s]/.test(query)) return null;
  if (!/^[A-Z][A-Z0-9-]*$/.test(query) && query !== "") return null;
  return { start: at, query };
}

/** 插入选中的引用编号。稳定编号本身留在正文里，不额外编码。 */
export function insertCommentReference(body: string, caret: number, identifier: string): { body: string; caret: number } {
  const index = Math.max(0, Math.min(caret, body.length));
  const start = commentReferenceQuery(body, index)?.start ?? index;
  // 末尾已经紧跟空白时不再补空格，否则正文里会多出一个空格。
  const token = `#${identifier}${/\s/.test(body[index] ?? "") ? "" : " "}`;
  return { body: body.slice(0, start) + token + body.slice(index), caret: start + token.length };
}

/** 渲染用：把正文切成「引用 token」与「普通文本」两类片段。 */
export function taskReferenceSegments(body: string): Array<{ text: string; identifier: string | null }> {
  const segments: Array<{ text: string; identifier: string | null }> = [];
  let cursor = 0;
  for (const match of body.matchAll(TASK_REFERENCE_PATTERN)) {
    const at = match.index ?? 0;
    const identifier = match[2]!;
    const start = at + match[1]!.length;
    if (start > cursor) segments.push({ text: body.slice(cursor, start), identifier: null });
    segments.push({ text: `#${identifier}`, identifier });
    cursor = start + identifier.length + 1;
  }
  if (cursor < body.length) segments.push({ text: body.slice(cursor), identifier: null });
  return segments.length ? segments : [{ text: body, identifier: null }];
}
