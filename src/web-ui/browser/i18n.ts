import { state } from "./state";

// ── 前端 i18n（最小化）──
// 后端 config.language 是给 Claude 用的"回答语言"偏好（"中文" / "English" / 任意字符串），
// 之前 frontend 完全没收 → UI label 一直 hardcoded 中文 + 个别英文（"SUBAGENT" 那个 tag）。
// 用户设的是中文时，"SUBAGENT" 这类英文残留就和"配置语言不一致"。
//
// 设计取舍：
//   - 只维护两套：中文（默认） + 英文。其它取值（"日本語"、"Français"等）回退到英文，
//     因为 Claude 会按用户语言回答，UI 至少不卡在中文上让英语圈用户看不懂。
//   - 不引入 i18n 库，几十个 key 用平铺对象，t(key, params) 是个十行 helper。
//   - params 支持 "{name}" 占位符替换，避免在调用点拼字符串。
//   - 缺 key 时回退到中文表，再没有就返回 key 本身（debug 友好）。
export var I18N_DEFAULT_LANG = "中文";
var I18N: Record<string, Record<string, string>> = {
  "中文": {
    "subagent.tag": "子代理",
    "subagent.handoff": "{parent} 让 {sub} 帮忙",
    "subagent.handoff.with_desc": "{parent} 让 {sub} 帮忙：",
    "subagent.continued": "继续输出",
    "subagent.task.done": "任务完成",
    "subagent.task.failed": "任务失败",
    "subagent.running": "运行中",
    "subagent.no_output": "（无输出）",
    "subagent.helper_fallback_prefix": "协作猫·",
    "subagent.title_aria": "点击展开 / 收起子代理输出",
    "subagent.tag_title": "子代理 / subagent",
    "ui.expand": "展开",
    "ui.collapse": "收起",
    "ui.expand_panel_aria": "展开子代理输出",
    "ui.collapse_panel_aria": "收起子代理输出",
    "history.expand": "展开历史对话",
    "history.collapse": "收起历史对话",
    "history.rounds": "{n} 轮对话",
    "history.tools": "{n} 次工具调用",
    "history.agents": "{n} 个子代理",
    "history.errors": "{n} 个失败",
    "stop.confirm.title": "停止任务",
    "stop.confirm.message": "确定要停止当前正在运行的任务吗？",
    "stop.confirm.ok": "停止",
    "stop.confirm.cancel": "取消"
  },
  "English": {
    "subagent.tag": "Subagent",
    "subagent.handoff": "{parent} asked {sub} for help",
    "subagent.handoff.with_desc": "{parent} asked {sub} for help with: ",
    "subagent.continued": "continued",
    "subagent.task.done": "Task complete",
    "subagent.task.failed": "Task failed",
    "subagent.running": "Running",
    "subagent.no_output": "(no output)",
    "subagent.helper_fallback_prefix": "Helper·",
    "subagent.title_aria": "Click to expand / collapse subagent output",
    "subagent.tag_title": "Subagent",
    "ui.expand": "Expand",
    "ui.collapse": "Collapse",
    "ui.expand_panel_aria": "Expand subagent output",
    "ui.collapse_panel_aria": "Collapse subagent output",
    "history.expand": "Show earlier conversation",
    "history.collapse": "Hide earlier conversation",
    "history.rounds": "{n} rounds",
    "history.tools": "{n} tool calls",
    "history.agents": "{n} subagents",
    "history.errors": "{n} failed",
    "stop.confirm.title": "Stop task",
    "stop.confirm.message": "Stop the task that's currently running?",
    "stop.confirm.ok": "Stop",
    "stop.confirm.cancel": "Cancel"
  }
};
export function getActiveLang() {
  var raw = state.config && typeof state.config.language === "string" ? state.config.language.trim() : "";
  if (!raw) return I18N_DEFAULT_LANG;
  if (I18N[raw]) return raw;
  // 模糊匹配：用户可能写 "english" / "en" / "ENG"
  var lower = raw.toLowerCase();
  if (lower === "english" || lower === "en" || lower.indexOf("english") === 0 || lower.indexOf("英") === 0) return "English";
  if (lower === "中文" || lower === "zh" || lower.indexOf("zh") === 0 || lower.indexOf("中") === 0 || lower.indexOf("chinese") === 0) return "中文";
  return "English"; // 其它语言走英文 fallback（Claude 会按 raw 回答，UI 至少英文不卡）
}
export function t(key: string, params?: Record<string, string>): string {
  var lang = getActiveLang();
  var table = I18N[lang] || I18N[I18N_DEFAULT_LANG];
  var template: string = table && key in table ? table[key] : null as any;
  if (template == null) {
    var def = I18N[I18N_DEFAULT_LANG];
    template = def && key in def ? def[key] : key;
  }
  if (params && typeof template === "string") {
    for (var k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      template = template.split("{" + k + "}").join(params[k]);
    }
  }
  return template;
}

// ── 统一线性图标库 ──
// 替代页面里散落的 emoji（🛡 / ⌨ / 📁 / 🔔 …）。这些 emoji 在系统字体里渲染成
// 彩色卡通形态，与项目温暖米色 + 棕橙的复古主题视觉冲突明显。这里集中维护
// currentColor 线性 SVG，让图标跟随父级文字颜色变化，hover / active 状态自然继承。
var ICON_PATHS: Record<string, string> = {
  // shape sets — 24x24 viewbox, currentColor stroke
  shield:    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
  cpu:       '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 1v3"/><path d="M15 1v3"/><path d="M9 20v3"/><path d="M15 20v3"/><path d="M20 9h3"/><path d="M20 15h3"/><path d="M1 9h3"/><path d="M1 15h3"/><rect x="10" y="10" width="4" height="4" rx="1"/>',
  brain:     '<path d="M9.5 4.5a3 3 0 0 0-4.7 3.1 3.3 3.3 0 0 0 .3 6.1A3 3 0 0 0 8 19h1.5V4.5z"/><path d="M14.5 4.5a3 3 0 0 1 4.7 3.1 3.3 3.3 0 0 1-.3 6.1A3 3 0 0 1 16 19h-1.5V4.5z"/><path d="M9.5 8H7.8"/><path d="M14.5 8h1.7"/><path d="M9.5 13H7.6"/><path d="M14.5 13h1.9"/>',
  keyboard:  '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/>',
  terminal:  '<polyline points="4 7 9 12 4 17"/><line x1="12" y1="17" x2="20" y2="17"/>',
  chat:      '<path d="M21 12a8 8 0 0 1-12.9 6.3L3 20l1.7-5.1A8 8 0 1 1 21 12z"/>',
  folder:    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  chevronRight: '<polyline points="9 6 15 12 9 18"/>',
  wrench:    '<path d="M14.7 6.3a4 4 0 1 1 4 4l-9 9-3.5 1 1-3.5 7.5-7.5z"/>',
  sliders:   '<path d="M4 7h10M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2M10 17h10"/><circle cx="8" cy="17" r="2"/>',
  sparkle:   '<path d="M12 3l1.3 3.8L17 8.1l-3.7 1.3L12 13l-1.3-3.6L7 8.1l3.7-1.3L12 3z"/><path d="M18 13l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z"/>',
  spark:     '<path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/><circle cx="12" cy="12" r="3"/>',
  info:      '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  warning:   '<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18h.01"/>',
  question:  '<circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.5 2.5 0 1 1 3.5 2.3c-.9.4-1.3 1-1.3 2.2M12 17h.01"/>',
  check:     '<path d="M20 6 9 17l-5-5"/>',
  circle:    '<circle cx="12" cy="12" r="7"/>',
  close:     '<path d="M18 6 6 18"/><path d="M6 6l12 12"/>',
  paw:       '<circle cx="7.5" cy="9" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="6.8" r="2" fill="currentColor" stroke="none"/><circle cx="16.5" cy="9" r="2" fill="currentColor" stroke="none"/><circle cx="18" cy="13.3" r="1.8" fill="currentColor" stroke="none"/><path d="M7.2 16.3c.5-2.9 2.3-4.8 4.8-4.8s4.3 1.9 4.8 4.8c.3 1.8-.9 3.2-2.6 2.6-.8-.3-1.4-.6-2.2-.6s-1.4.3-2.2.6c-1.7.6-2.9-.8-2.6-2.6z" fill="currentColor" stroke="none"/>',
  edit:      '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  refresh:   '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  signal:    '<path d="M2 12a15 15 0 0 1 20 0"/><path d="M5 16a10 10 0 0 1 14 0"/><path d="M9 20a4 4 0 0 1 6 0"/><circle cx="12" cy="20" r="0.5" fill="currentColor"/>',
  file:      '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/>',
  sigma:     '<polyline points="18 4 6 4 13 12 6 20 18 20"/>',
  x:         '<path d="M18 6 6 18"/><path d="M6 6l12 12"/>',
  // 「+」：附件入口（替代旧曲别针图标），更直观、与微信/iMessage 习惯一致。
  plus:      '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  // 麦克风：语音输入入口。stroke 线性风格与项目其他图标统一。
  mic:       '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="21"/><line x1="9" y1="21" x2="15" y2="21"/>',
  // 曲别针：加号 popover 内"上传附件"项的图标（+ 入口已被外层占用，这里就用回曲别针）。
  paperclip: '<path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l8.84-8.84a4 4 0 1 1 5.66 5.66L9.41 17.41a2 2 0 1 1-2.83-2.83l8.84-8.83"/>'
};
// 渲染 SVG 字符串。size 默认 14，strokeWidth 默认 1.8（与现有 send/stop 按钮线宽接近）。
// cls 用于添加额外 class（如 .composer-pill-icon），便于 CSS 微调。
export function iconSvg(name: string, opts?: { size?: number; strokeWidth?: number; cls?: string; fill?: string }): string {
  var path = ICON_PATHS[name];
  if (!path) return "";
  opts = opts || {};
  var size = opts.size || 14;
  var stroke = opts.strokeWidth || 1.8;
  var cls = opts.cls ? ' class="' + opts.cls + '"' : "";
  var fill = opts.fill || "none";
  return '<svg' + cls + ' width="' + size + '" height="' + size + '" viewBox="0 0 24 24"' +
    ' fill="' + fill + '" stroke="currentColor" stroke-width="' + stroke + '"' +
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
}
