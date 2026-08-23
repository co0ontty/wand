export type ToolIconKind =
  | "agent"
  | "edit"
  | "exit"
  | "generic"
  | "git"
  | "image"
  | "question"
  | "read"
  | "search"
  | "terminal"
  | "thinking"
  | "todo"
  | "wait"
  | "web";

const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  multiedit: "多处编辑",
  apply_patch: "应用补丁",
  bash: "执行命令",
  exec_command: "执行命令",
  write_stdin: "终端输入",
  grep: "搜索内容",
  glob: "查找文件",
  webfetch: "获取网页",
  websearch: "搜索网页",
  task: "任务",
  todowrite: "更新待办",
  todoread: "读取待办",
  update_plan: "更新计划",
  notebookedit: "编辑笔记本",
  agent: "子代理",
  spawn_agent: "启动子代理",
  askuserquestion: "提问",
  request_user_input: "请求输入",
  exit: "退出",
};

export function getToolDisplayName(toolName: unknown): string {
  const raw = typeof toolName === "string" ? toolName.trim() : "";
  if (!raw) return "工具";
  const normalized = raw.toLowerCase();
  const segments = normalized.split(/__|\/|:/).filter(Boolean);
  const leaf = segments[segments.length - 1] ?? normalized;
  return TOOL_DISPLAY_NAMES[normalized] ?? TOOL_DISPLAY_NAMES[leaf] ?? raw;
}

/**
 * Provider adapters emit exact Claude names, namespaced MCP names, and
 * provider-prefixed names. Classify by semantic keywords so every variant gets
 * a meaningful icon while genuinely unknown tools still receive a tool glyph.
 */
export function getToolIconKind(toolName: unknown): ToolIconKind {
  const raw = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
  const segments = raw.split(/__|\/|:/).filter(Boolean);
  const name = segments[segments.length - 1] ?? raw;
  if (/ask|question|request_user_input|prompt_user/.test(name)) return "question";
  if (/todo|checklist|update_plan/.test(name)) return "todo";
  if (/image|screenshot|photo|vision|camera/.test(name)) return "image";
  if (/github|(^|[_/])git|commit|pull_request|merge_request|branch/.test(name)) return "git";
  if (/browser|(^|[_/])web|fetch|http|url|navigate|page_|click_link/.test(name)) return "web";
  if (/grep|glob|search|find|query|lookup/.test(name)) return "search";
  if (/bash|exec|command|terminal|shell|stdin|repl|run_code/.test(name) || /repl/.test(raw)) return "terminal";
  if (/apply_patch|patch|edit|(^|_)write($|_)|write_file|create_file|save_file|replace|format_file/.test(name)) return "edit";
  if (/agent|task|subagent|spawn|collaborat|followup|interrupt|delegate|send_input/.test(name)) return "agent";
  if (/read|open|load|list|inspect|view|get_file/.test(name)) return "read";
  if (/think|reason/.test(name)) return "thinking";
  if (/(^|_)(wait|sleep|poll|monitor)($|_)/.test(name) || name === "wait") return "wait";
  if (/exit|stop|kill|cancel|terminate/.test(name)) return "exit";
  return "generic";
}

const ICON_BODIES: Readonly<Record<ToolIconKind, string>> = {
  agent: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.6-3.2 2.4-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17" cy="9" r="2"/><path d="M15.5 14.5c2.8-.7 4.7.6 5 3.5"/>',
  edit: '<path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4M4 20l4-1"/>',
  exit: '<path d="M15 7l5 5-5 5M20 12H9"/><path d="M11 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6"/>',
  generic: '<path d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.4 2.4-3-3 2.4-2.4Z"/>',
  git: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 7c4 0 4 0 8 0M8 17c4 0 4-8 8-8"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m4 17 5-5 4 4 2-2 5 5"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.5 2.5 0 1 1 3.5 2.3c-.9.4-1.3 1-1.3 2.2M12 17h.01"/>',
  read: '<path d="M5 3h10l4 4v14H5V3Z"/><path d="M15 3v5h4M8 12h8M8 16h6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12 16h5"/>',
  thinking: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3"/>',
  todo: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7.5 12 3 3 6-7"/>',
  wait: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.5 3.7 5.5 3.7 9s-1.3 6.5-3.7 9c-2.4-2.5-3.7-5.5-3.7-9S9.6 5.5 12 3Z"/>',
};

export function getToolIcon(toolName: unknown): string {
  const kind = getToolIconKind(toolName);
  return '<svg class="tool-use-icon-svg" data-tool-icon="' + kind + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    ICON_BODIES[kind] +
    "</svg>";
}
