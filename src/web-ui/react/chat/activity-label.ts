import type { WandIconName } from "../ui/icons.js";

interface ActivityLabelSource {
  name?: string;
  description?: string;
  preview?: string;
  input?: Record<string, unknown>;
  activity?: { kind?: string; label?: string };
  semantic?: { kind?: string };
}
const PLAN_NAMES = new Set(["Pi/todo", "TodoWrite", "TodoRead", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
function short(value: unknown, length = 140): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > length ? text.slice(0, length - 1) + "…" : text;
}

/** Readable labels project supplied fields, never infer intent or execution state. */
export function activityLabel(block: ActivityLabelSource): { title: string; detail: string; context: string; icon: WandIconName } {
  const name = short(block.name, 48) || "工具";
  const input = block.input ?? {};
  if (PLAN_NAMES.has(name) || block.semantic?.kind === "task_list") {
    const actions: Record<string, string> = { create: "新增待办", update: "更新待办", list: "查看待办", get: "查看待办", delete: "移除待办", clear: "清空待办" };
    const states: Record<string, string> = { in_progress: "开始处理", completed: "完成", pending: "待开始", deleted: "移除" };
    const action = actions[String(input.action)] || (name === "TaskCreate" ? "新增待办" : "更新待办");
    const subject = short(input.subject || input.content);
    const id = short(input.id ?? input.taskId, 32);
    const target = subject || (id ? `待办 #${id}` : short(block.preview));
    const verb = states[String(input.status)] || action;
    return { title: target ? `${verb} · ${target}` : action, detail: "", context: "待办", icon: "task" };
  }
  const kind = block.activity?.kind;
  const icon: WandIconName = kind === "run_command" || /^(Bash|bash|shell|terminal)$/i.test(name) ? "terminal"
    : kind === "read_file" ? "file" : kind === "edit_file" ? "edit" : /search|grep|glob/i.test(name) ? "search" : "wrench";
  const command = short(input.command || input.cmd || input.script || block.preview);
  const target = short(input.file_path || input.path || input.pattern || input.query || input.url);
  const supplied = short(input.description) || short(block.description);
  const label = short(block.activity?.label);
  const generic = (text: string): boolean => !text || text === name || /^(运行命令|执行命令|调用工具|调用)(\s*[·:：]\s*\S+)?$/.test(text);
  const title = (!generic(supplied) ? supplied : "") || (!generic(label) ? label : "") || command || target || name;
  const detail = command && command !== title ? command : target && target !== title ? target : "";
  return { title, detail, context: name, icon };
}
