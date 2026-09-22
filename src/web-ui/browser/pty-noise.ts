// PTY 终端界面噪声的**唯一**文案来源。
//
// 背景：这些字符串原本散在 chat-render.ts 的三套过滤器里（聊天流 isNoiseLine、
// system-info 卡片的内联过滤、Codex 行判定 + 两个 Codex 正则），任一家 CLI 改一行
// 状态栏文案都要同时改多处且很难测。现在文案与判定只在本文件维护，调用点只声明
// 自己要用哪一套（见下）。
//
// 本模块刻意不碰 DOM，可以直接在 Node 单测里 import（同 text-escape.ts）。
//
// 三套的适用范围不同，差异是有意保留的：
//   - isPtyNoiseLine            聊天流渲染时丢弃的噪声行（最全的一套）
//   - isPtySystemInfoNoiseLine  抽取 PTY 首屏 system-info 卡片时的过滤。比上面窄：
//                               卡片本身就要展示 banner 内文与用量行的一部分，
//                               例如纯框线行 `╭────╮` 在这里**保留**。
//   - isPtyCodexNoiseLine       Codex 解析的额外判定 = isPtyNoiseLine + Codex 专属模式。

/** Codex 底部状态行：`gpt-5.1-codex · 42% left · /Users/me/repo`。 */
export var codexFooterRe = /\bgpt-\d+(?:\.\d+)?(?:\s+[a-z0-9.-]+)?\s+·\s+\d+%\s+left\s+·\s+(?:\/|~\/).+/i;

/** Codex 活动行开头：`Thinking` / `Running tests` / `Completed` … */
export var codexActivityRe = /^(?:thinking|working|running|planning|applying|reading|searching|inspecting|reviewing|summarizing|editing|updating|writing|completed)\b/i;

/** 聊天流渲染丢弃的 CLI 界面噪声行。 */
export function isPtyNoiseLine(line: unknown): boolean {
  if (!line) return false;
  var trimmed = String(line).trim();
  if (!trimmed) return false;
  if (trimmed.indexOf("────") === 0) return true;
  if (trimmed === "❯" || trimmed === "›") return true;
  if (/^[╭╰│┌└┐┘├┤┬┴┼─═]{2,}$/.test(trimmed)) return true;
  if (/^[▁▂▃▄▅▆▇█▔▕▏▐]+$/.test(trimmed)) return true;
  if (trimmed.indexOf("esc to interrupt") !== -1) return true;
  if (trimmed.indexOf("Claude Code v") !== -1) return true;
  if (/^Sonnet\b/.test(trimmed)) return true;
  if (trimmed.indexOf("Failed to install Anthropic") !== -1) return true;
  if (trimmed.indexOf("Claude Code has switched") !== -1) return true;
  if (trimmed.indexOf("? for shortcuts") !== -1) return true;
  if (trimmed.indexOf("Claude is waiting") !== -1) return true;
  if (trimmed.indexOf("[wand]") !== -1) return true;
  if (trimmed.indexOf("0;") === 0 || trimmed.indexOf("9;") === 0) return true;
  if (trimmed.indexOf("ctrl+g") !== -1) return true;
  if (trimmed.indexOf("/effort") !== -1) return true;
  if (/^Using .* for .* session/.test(trimmed)) return true;
  if (trimmed.indexOf("Press ") === 0 && trimmed.indexOf(" for") !== -1) return true;
  if (trimmed.indexOf("type ") === 0 && trimmed.indexOf(" to ") !== -1) return true;
  if (trimmed.indexOf("auto mode is unavailable") !== -1) return true;
  if (/MCP server.*failed/i.test(trimmed)) return true;
  if (trimmed.indexOf("Germinating") !== -1 || trimmed.indexOf("Doodling") !== -1 || trimmed.indexOf("Brewing") !== -1) return true;
  if (trimmed.indexOf("Permissions") !== -1 && trimmed.indexOf("mode") !== -1) return true;
  if (trimmed.indexOf("●") === 0 && trimmed.indexOf("·") !== -1) return true;
  if (trimmed.indexOf("[>") === 0 || trimmed.indexOf("[<") === 0) return true;
  if (trimmed.indexOf("Captured Claude session ID") !== -1) return true;
  if (/^>_\s*OpenAI Codex\b/.test(trimmed)) return true;
  if (/^OpenAI Codex\b/i.test(trimmed)) return true;
  if (/^(model|directory):\s+/i.test(trimmed)) return true;
  if (/^(tip|context):\s+/i.test(trimmed)) return true;
  if (/^work(tree|space):\s+/i.test(trimmed)) return true;
  if (/^(approvals?|sandbox|provider|session id):\s+/i.test(trimmed)) return true;
  if (/^(thinking|working)(\.\.\.|…)?$/i.test(trimmed)) return true;
  if (/^[•◦·]\s+Working\b/i.test(trimmed)) return true;
  if (/^[•◦·]\s+(Running|Planning|Applying|Reading|Searching)\b/i.test(trimmed)) return true;
  if (/^[•◦·]\s+(Inspecting|Reviewing|Summarizing|Editing|Updating|Writing)\b/i.test(trimmed)) return true;
  if (/^[•◦·]\s+Completed\b/i.test(trimmed)) return true;
  if (/^(ctrl|enter|tab|shift|esc|alt)\+/i.test(trimmed)) return true;
  if (/\b(open|close|toggle) (chat|terminal)\b/i.test(trimmed)) return true;
  if (/\b(approve|deny)\b.*\b(permission|approval)\b/i.test(trimmed)) return true;
  if (/^(use|press) .* (to|for) .*/i.test(trimmed)) return true;
  if (/^(?:token|context window|remaining context|conversation):\s+/i.test(trimmed)) return true;
  if (/^(?:cwd|path):\s+\//i.test(trimmed)) return true;
  if (/^[<>│┆╎].*[<>│┆╎]$/.test(trimmed) && trimmed.length < 8) return true;
  return false;
}

/**
 * PTY 首屏 system-info 卡片的过滤条件。
 * 与 isPtyNoiseLine 的差别：只挡「分隔线/提示符/Claude Code 用量与计费行」，
 * 纯框线行留给卡片展示 banner。
 */
export function isPtySystemInfoNoiseLine(line: unknown): boolean {
  if (!line) return false;
  var trimmed = String(line).trim();
  if (!trimmed) return false;
  if (trimmed.indexOf("────") === 0) return true;
  if (trimmed === "❯" || trimmed === "?") return true;
  if (trimmed.indexOf("Claude Code v") !== -1) return true;
  if (trimmed.indexOf("Opus") !== -1 && trimmed.indexOf("with") !== -1) return true;
  if (trimmed.indexOf("Sonnet") !== -1 && trimmed.indexOf("with") !== -1) return true;
  if (trimmed.indexOf("API Usage") !== -1) return true;
  if (trimmed.indexOf("Billing") !== -1) return true;
  if (trimmed.indexOf("for shortcuts") !== -1) return true;
  if (trimmed.indexOf("/effort") !== -1) return true;
  // 转轮/进度条行：以这些字符开头的行整行都是动画残留（原实现里第二个 {3,}
  // 分支恒被前一个前缀分支覆盖，属于死条件，合并时直接删掉）。
  if (/^[▸▐▝▘▗▖█▌▍▎▏▔▁▂▃▄▅▆▇██]/.test(trimmed)) return true;
  return false;
}

/** Codex 解析判定：聊天流噪声 + Codex 专属模式。 */
export function isPtyCodexNoiseLine(line: unknown): boolean {
  var trimmed = String(line || "").trim();
  if (!trimmed) return true;
  if (isPtyNoiseLine(trimmed)) return true;
  if (codexFooterRe.test(trimmed)) return true;
  if (/^[╭╰│┌└┐┘├┤┬┴┼─═]/.test(trimmed)) return true;
  if (/^\[>[0-9;?]*u$/i.test(trimmed)) return true;
  if (/^M+$/i.test(trimmed)) return true;
  if (/^(?:OpenAI Codex|Codex)\b/i.test(trimmed)) return true;
  if (/^(?:tokens?|context window|remaining context|approvals?|sandbox|provider|session id):\s*/i.test(trimmed)) return true;
  if (/^(?:thinking|working)\s*(?:\.\.\.|…)?$/i.test(trimmed)) return true;
  if (/^[•◦·]\s+(?:thinking|working|running|planning|applying|reading|searching|inspecting|reviewing|summarizing|editing|updating|writing|completed)\b/i.test(trimmed)) return true;
  if (/^(?:model|directory|tip|context|cwd|path):\s+/i.test(trimmed)) return true;
  return false;
}

/**
 * PTY 转写抓取（parseMessages 的 Claude 分支）里丢弃的行。这一套与上面两套都不一样：
 * 它面对的是“已经 strip 过 ANSI、按行 trim 过”的整段输出，除了界面文案还要挡 npm
 * 安装日志、TUI 动画碎片、思考进度行，所以单独一套谓词，不与其他两套合并。
 */
export function isPtyTranscriptNoiseLine(line: string): boolean {
  if (!line) return true;
  if (line.indexOf("────────────────") === 0) return true;
  if (line === "❯") return true;
  if (line.indexOf("esc to interrupt") !== -1) return true;
  if (line.indexOf("Claude Code v") !== -1) return true;
  if (line.indexOf("Sonnet") !== -1) return true;
  if (line.indexOf("~/") === 0) return true;
  if (line.indexOf("● high") !== -1) return true;
  if (line.indexOf("Failed to install Anthropic marketplace") !== -1) return true;
  if (line.indexOf("Claude Code has switched from npm to native installer") !== -1) return true;
  if (line.indexOf("Fluttering") !== -1) return true;
  if (line.indexOf("? for shortcuts") !== -1) return true;
  if (line.indexOf("0;") === 0) return true;
  if (line.indexOf("9;") === 0) return true;
  if (line.indexOf("Claude is waiting") !== -1) return true;
  if (line.indexOf("✢") !== -1 || line.indexOf("✳") !== -1 || line.indexOf("✶") !== -1 || line.indexOf("✻") !== -1 || line.indexOf("✽") !== -1) return true;
  if (line.indexOf("▐") === 0 || line.indexOf("▝") === 0 || line.indexOf("▘") === 0) return true;
  if ((line === "lu" || line === "ue" || line === "tr" || line === "ti" || line === "g" || line === "n" || line === "i…" || line === "…" || line === "uts" || line === "lt" || line === "rg" || line === "·") && line.length < 4) return true;
  if (line.indexOf("✽F") === 0 || line.indexOf("✻F") === 0) return true;
  // npm / 安装器日志
  if (line.indexOf("npm WARN") !== -1) return true;
  if (line.indexOf("npm notice") !== -1) return true;
  if (line.indexOf("added ") !== -1 && line.indexOf(" packages") !== -1) return true;
  if (line.indexOf("audited ") !== -1) return true;
  if (line.indexOf("found ") !== -1 && line.indexOf(" vulnerabilities") !== -1) return true;
  if (line.indexOf("Using ") !== -1 && line.indexOf(" for ") !== -1 && line.indexOf("session") !== -1) return true;
  if (line.indexOf("You can use") !== -1) return true;
  if (line.indexOf("Press ") !== -1 && line.indexOf(" for") !== -1) return true;
  if (line.indexOf("type ") === 0 && line.indexOf(" to ") !== -1) return true;
  if (line.indexOf("[wand]") === 0) return true;
  if (line.indexOf("Captured Claude session ID") !== -1) return true;
  // Claude TUI 噪声
  if (line.indexOf("⏵") !== -1) return true;
  if (line.indexOf("acceptedit") !== -1) return true;
  if (line.indexOf("shift+tab") !== -1) return true;
  if (line.indexOf("tabtocycle") !== -1) return true;
  if (line.indexOf("ctrl+g") !== -1) return true;
  if (line.indexOf("/effort") !== -1) return true;
  if (line.indexOf("Opus") !== -1 && line.indexOf("model") !== -1) return true;
  if (line.indexOf("Haiku") !== -1) return true;
  if (line.indexOf("to cycle") !== -1) return true;
  if (line.indexOf("high ·") !== -1 || line.indexOf("high·") !== -1) return true;
  if (line.indexOf("medium ·") !== -1 || line.indexOf("medium·") !== -1) return true;
  if (line.indexOf("low ·") !== -1 || line.indexOf("low·") !== -1) return true;
  return false;
}
