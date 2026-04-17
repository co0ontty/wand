/**
 * Shared PTY text processing utilities.
 * Used by both claude-pty-bridge.ts and message-parser.ts to ensure
 * consistent ANSI stripping and noise filtering.
 */

/** Strip ANSI escape sequences and control characters from raw PTY output. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[(\d+)C/g, (_match, count) => " ".repeat(Number(count) || 1))
    .replace(/\x1b\[[0-9;?]*[AB]/g, "\n")
    .replace(/\x1b\[[0-9;?]*[su]/g, "")
    .replace(/\x1b\[[0-9;?]*[HfJKr]/g, "\n")
    .replace(/\x1bM/g, "\n")
    .replace(/\x1b\[[0-9;?]*[ST]/g, "\n")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[><=ePX^_]/g, "")
    .replace(/[\u00a0\u200b-\u200d\ufeff]/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Lines considered as UI noise that should be excluded from chat view. */
export function isNoiseLine(line: string): boolean {
  if (!line) return false;

  const trimmed = line.trim();
  if (!trimmed) return false;

  if (trimmed.startsWith("────")) return true;
  if (trimmed === "❯" || trimmed === "›") return true;
  if (/^[╭╰│┌└┐┘├┤┬┴┼─═]{2,}$/.test(trimmed)) return true;
  if (/^[▁▂▃▄▅▆▇█▔▕▏▐]+$/.test(trimmed)) return true;
  if (trimmed.includes("esc to interrupt")) return true;
  if (trimmed.includes("Claude Code v")) return true;
  if (/^Sonnet\b/.test(trimmed)) return true;
  if (trimmed.includes("Failed to install Anthropic")) return true;
  if (trimmed.includes("Claude Code has switched")) return true;
  if (trimmed.includes("? for shortcuts")) return true;
  if (trimmed.includes("Claude is waiting")) return true;
  if (trimmed.includes("[wand]")) return true;
  if (trimmed.startsWith("0;") || trimmed.startsWith("9;")) return true;
  if (trimmed.includes("ctrl+g")) return true;
  if (trimmed.includes("/effort")) return true;
  if (/^Using .* for .* session/.test(trimmed)) return true;
  if (trimmed.startsWith("Press ") && trimmed.includes(" for")) return true;
  if (trimmed.startsWith("type ") && trimmed.includes(" to ")) return true;
  if (trimmed.includes("auto mode is unavailable")) return true;
  if (/MCP server.*failed/i.test(trimmed)) return true;
  if (trimmed.includes("Germinating") || trimmed.includes("Doodling") || trimmed.includes("Brewing")) return true;
  if (trimmed.includes("Permissions") && trimmed.includes("mode")) return true;
  if (trimmed.startsWith("●") && trimmed.includes("·")) return true;
  if (trimmed.startsWith("[>") || trimmed.startsWith("[<")) return true;
  if (trimmed.includes("Captured Claude session ID")) return true;

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

/** Append text to a windowed buffer, trimming from start if over max size. */
export function appendWindow(buffer: string, chunk: string, maxSize: number): string {
  const next = buffer + chunk;
  return next.length > maxSize ? next.slice(-maxSize) : next;
}

const EXPLICIT_CONFIRM_PATTERNS = [
  /(?:^|\b)(?:press\s+)?(?:y|yes)\s*(?:\/|\bor\b)\s*(?:n|no)(?:\b|$)/i,
  /\[(?:y|yes)\s*\/\s*(?:n|no)\]/i,
  /\((?:y|yes)\s*\/\s*(?:n|no)\)/i,
  /\((?:y|yes)\s*\/\s*(?:n|no)\s*\/\s*always\)/i,
  /\byes\b[\s\S]*\bno\b/i,
  /\benter to confirm\b/i,
  // Claude CLI numbered selection menus: "❯ 1. Yes" + "N. No"
  /❯\s*1\.\s*yes\b/i,
];

const PERMISSION_ACTION_PATTERNS = [
  /\bgrant\b.*\bpermission\b/i,
  /\bhaven't granted\b/i,
  /\byes,\s*i\s*trust\s*this\s*folder\b/i,
  /\b(?:write|modify|delete|create|execute|run|bash|command|network|web|fetch|permission|allow)\b/i,
];

export function hasExplicitConfirmSyntax(normalized: string): boolean {
  return EXPLICIT_CONFIRM_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function hasPermissionActionContext(normalized: string): boolean {
  return PERMISSION_ACTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Detect Claude CLI slash-command selection menus (/model, /effort, /output-style, etc.).
 * These share "Enter to confirm" with permission prompts but are user-driven choices
 * that must never be auto-approved. Distinguishing footer: "Esc to exit" (vs permission
 * prompts' "Esc to cancel" / "Tab to amend").
 */
export function isSlashCommandMenu(normalized: string): boolean {
  return /\besc\s+to\s+exit\b/i.test(normalized);
}

// ── Weighted keyword scoring for fallback permission detection ──

interface PermissionScore {
  score: number;
  matched: string[];
}

const PERMISSION_KEYWORD_WEIGHTS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /\bdo you want to proceed\b/i, weight: 5, label: "do you want to proceed" },
  { pattern: /\bwould you like to proceed\b/i, weight: 5, label: "would you like to proceed" },
  { pattern: /\bdo you want to\b/i, weight: 4, label: "do you want to" },
  { pattern: /\bwould you like to\b/i, weight: 4, label: "would you like to" },
  { pattern: /\benter to confirm\b/i, weight: 4, label: "enter to confirm" },
  { pattern: /\bgrant\b[\s\S]*\bpermission\b/i, weight: 4, label: "grant permission" },
  { pattern: /❯\s*1\./i, weight: 3, label: "❯ 1." },
  { pattern: /\b1\.\s*yes\b/i, weight: 3, label: "1. yes" },
  { pattern: /\bdon'?t ask again\b/i, weight: 2, label: "don't ask again" },
  { pattern: /\b(?:bash|shell)\s*command\b/i, weight: 2, label: "bash/shell command" },
  { pattern: /\b(?:run|read|write|edit)\s+(?:file|command|shell)\b/i, weight: 2, label: "run/read/write action" },
  { pattern: /\ballow\b.*\breading\b/i, weight: 2, label: "allow reading" },
];

/** Minimum score threshold for fallback permission detection */
export const FALLBACK_SCORE_THRESHOLD = 8;

/**
 * Score how likely the recent output contains a permission prompt.
 * Evaluates the last few lines of normalized text against weighted keywords.
 */
export function scorePermissionLikelihood(normalized: string): PermissionScore {
  // Take the last ~5 lines
  const lines = normalized.split("\n");
  const tail = lines.slice(-8).join("\n");

  // Slash-command menus are never permission prompts — zero the score so
  // fallback auto-approve and idle-probe both skip them.
  if (isSlashCommandMenu(tail)) {
    return { score: 0, matched: [] };
  }

  let score = 0;
  const matched: string[] = [];

  for (const { pattern, weight, label } of PERMISSION_KEYWORD_WEIGHTS) {
    if (pattern.test(tail)) {
      score += weight;
      matched.push(label);
    }
  }

  return { score, matched };
}

/** Normalize prompt text for permission detection (strip ANSI, collapse whitespace). */
export function normalizePromptText(value: string): string {
  return value
    .replace(/\u001b\[(\d+)C/g, (_match, count) => " ".repeat(Number(count) || 1))
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .trim();
}
