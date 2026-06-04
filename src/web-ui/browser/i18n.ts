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
export var I18N: Record<string, Record<string, string>> = {
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
    "ui.collapse_panel_aria": "收起子代理输出"
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
    "ui.collapse_panel_aria": "Collapse subagent output"
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
export var ICON_PATHS: Record<string, string> = {
  // shape sets — 24x24 viewbox, currentColor stroke
  shield:    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
  keyboard:  '<rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6" y2="10"/><line x1="10" y1="10" x2="10" y2="10"/><line x1="14" y1="10" x2="14" y2="10"/><line x1="18" y1="10" x2="18" y2="10"/><line x1="6" y1="14" x2="6" y2="14"/><line x1="18" y1="14" x2="18" y2="14"/><line x1="9" y1="14" x2="15" y2="14"/>',
  cloud:     '<path d="M17.5 19a4.5 4.5 0 1 0-1-8.9 6 6 0 0 0-11.5 1.7A4 4 0 0 0 6 19h11.5z"/>',
  terminal:  '<polyline points="4 7 9 12 4 17"/><line x1="12" y1="17" x2="20" y2="17"/>',
  chat:      '<path d="M21 12a8 8 0 0 1-12.9 6.3L3 20l1.7-5.1A8 8 0 1 1 21 12z"/>',
  folder:    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderOpen:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2"/><path d="M3 9h18l-2 8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  trash:     '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  slash:     '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  chevronUp:   '<polyline points="6 15 12 9 18 15"/>',
  chevronRight:'<polyline points="9 6 15 12 9 18"/>',
  bell:      '<path d="M18 16v-5a6 6 0 1 0-12 0v5l-2 2h16z"/><path d="M10 21a2 2 0 0 0 4 0"/>',
  music:     '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  vibrate:   '<rect x="9" y="4" width="6" height="16" rx="1"/><path d="M5 8v8"/><path d="M3 10v4"/><path d="M19 8v8"/><path d="M21 10v4"/>',
  globe:     '<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>',
  smartphone:'<rect x="6" y="2" width="12" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/>',
  desktop:   '<rect x="3" y="4" width="18" height="12" rx="2"/><line x1="8" y1="20" x2="16" y2="20"/><line x1="12" y1="16" x2="12" y2="20"/>',
  link:      '<path d="M10 14a4.5 4.5 0 0 0 6.36 0l3-3a4.5 4.5 0 1 0-6.36-6.36l-1.42 1.41"/><path d="M14 10a4.5 4.5 0 0 0-6.36 0l-3 3a4.5 4.5 0 1 0 6.36 6.36l1.42-1.41"/>',
  palette:   '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 3a9 9 0 1 0 0 18 1.5 1.5 0 0 0 1.1-2.5 1.5 1.5 0 0 1 1.1-2.5h2.3A4.5 4.5 0 0 0 21 11.5C21 6.8 16.97 3 12 3z"/>',
  play:      '<polygon points="6 4 20 12 6 20 6 4"/>',
  inbox:     '<polyline points="22 13 16 13 14 16 10 16 8 13 2 13"/><path d="M5 5h14l3 8v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  zap:       '<polygon points="13 2 4 14 11 14 10 22 20 9 13 9 13 2"/>',
  wrench:    '<path d="M14.7 6.3a4 4 0 1 1 4 4l-9 9-3.5 1 1-3.5 7.5-7.5z"/>',
  paw:       '<circle cx="7.5" cy="9" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="6.8" r="2" fill="currentColor" stroke="none"/><circle cx="16.5" cy="9" r="2" fill="currentColor" stroke="none"/><circle cx="18" cy="13.3" r="1.8" fill="currentColor" stroke="none"/><path d="M7.2 16.3c.5-2.9 2.3-4.8 4.8-4.8s4.3 1.9 4.8 4.8c.3 1.8-.9 3.2-2.6 2.6-.8-.3-1.4-.6-2.2-.6s-1.4.3-2.2.6c-1.7.6-2.9-.8-2.6-2.6z" fill="currentColor" stroke="none"/>',
  edit:      '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  check:     '<polyline points="5 12 10 17 19 7"/>',
  signal:    '<path d="M2 12a15 15 0 0 1 20 0"/><path d="M5 16a10 10 0 0 1 14 0"/><path d="M9 20a4 4 0 0 1 6 0"/><circle cx="12" cy="20" r="0.5" fill="currentColor"/>',
  file:      '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/>',
  image:     '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><polyline points="3 18 9 12 14 17 21 12"/>',
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
