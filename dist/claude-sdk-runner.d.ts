export type ClaudeRunErrorCode = "CLAUDE_CLI_MISSING" | "CLAUDE_TIMEOUT" | "CLAUDE_CLI_FAILED" | "CLAUDE_EMPTY_RESULT";
export declare class ClaudeRunError extends Error {
    readonly code: ClaudeRunErrorCode;
    constructor(message: string, code: ClaudeRunErrorCode);
}
export interface RunClaudePrintOptions {
    cwd?: string;
    timeoutMs: number;
    /**
     * 用户偏好的回复语言（取自 config.language）。传进来时会以
     * `appendSystemPrompt` 形式灌给 Claude，保证 quick-commit / prompt-optimizer
     * 这种一次性调用也跟用户主会话同语言——之前 wand 的 git commit message 会
     * 莫名其妙变中英混搭，根因就在这。
     */
    language?: string;
}
/**
 * 用 `@anthropic-ai/claude-agent-sdk` 跑一次"prompt → 单段纯文本"调用，
 * 等价以前的 `claude -p --output-format text`。
 *
 * 行为对齐 Claude Code 默认：
 *   - 不指定 model / appendSystemPrompt / agent / mcpServers / hooks 等覆盖项，
 *     完全由 `~/.claude/settings.json`、OAuth 凭据、`CLAUDE_*` 环境变量等
 *     用户侧配置接管，与 Claude Code 自身一致。
 *   - `tools: []` 关掉所有内置工具：这两个调用点（commit message / prompt 优化）
 *     本质就是"纯文本生成"，关掉工具能 (1) 防止 Claude 随手开个工具卡住权限询问；
 *     (2) 避免一次性短调用还顺便加载文件 / 跑 bash 这种副作用。
 *   - `persistSession: false`：这些 ephemeral 调用不应该污染 `~/.claude/projects/`
 *     的会话历史；用户在 wand UI 里也压根看不到这些"虚拟会话"。
 *
 * 选择 SDK 而非以前的 `execFile("claude")`：
 *   - SDK 包内置各平台 native binary，`pathToClaudeCodeExecutable` 直接指到
 *     `node_modules` 里，**零** PATH 依赖。systemd / launchd / 双击图标启动
 *     wand server 时不会再因为 PATH 缺 nvm/npm-global 而报"未找到 claude CLI"。
 *   - 与现有 `structured-session-manager.ts` 的 SDK 调用路径同源，行为/认证/
 *     更新策略统一。
 */
export declare function runClaudePrint(prompt: string, options: RunClaudePrintOptions): Promise<string>;
