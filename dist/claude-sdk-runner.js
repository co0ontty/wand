import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { query as sdkQuery, } from "@anthropic-ai/claude-agent-sdk";
import { buildLanguageDirective } from "./language-prompt.js";
export class ClaudeRunError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "ClaudeRunError";
    }
}
/**
 * 判断当前 Linux 是否是 musl 系（Alpine 等）。glibc 系跑不动 musl native binary，
 * 反之亦然，SDK 默认的优先级与本机不匹配时会抛 "Claude Code native binary not found"。
 */
function isMuslSystem() {
    try {
        const header = process.report?.getReport()?.header;
        return !header?.glibcVersionRuntime;
    }
    catch {
        return false;
    }
}
/**
 * 把 SDK 应使用的 native claude binary 路径解析出来。逻辑与
 * `structured-session-manager.ts` 的 `resolveSdkClaudeBinary` 保持一致。
 */
function resolveSdkClaudeBinary() {
    if (process.platform !== "linux")
        return undefined;
    const musl = isMuslSystem();
    const arch = process.arch;
    const require = createRequire(import.meta.url);
    const candidates = musl
        ? [
            `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude`,
            `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`,
        ]
        : [
            `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude`,
            `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude`,
        ];
    for (const pkg of candidates) {
        try {
            const resolved = require.resolve(pkg);
            if (existsSync(resolved))
                return resolved;
        }
        catch {
            // 包不存在，尝试下一个
        }
    }
    return undefined;
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
export async function runClaudePrint(prompt, options) {
    const cwd = options.cwd && options.cwd.length > 0 ? options.cwd : undefined;
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), options.timeoutMs);
    const sdkClaudeBinary = resolveSdkClaudeBinary();
    const languageDirective = options.language ? buildLanguageDirective(options.language) : "";
    const sdkOptions = {
        abortController,
        tools: [],
        persistSession: false,
        ...(cwd ? { cwd } : {}),
        ...(sdkClaudeBinary ? { pathToClaudeCodeExecutable: sdkClaudeBinary } : {}),
        ...(languageDirective ? { appendSystemPrompt: languageDirective } : {}),
    };
    // 单条 user message → AsyncGenerator，SDK 的 streaming input 协议要求。
    async function* singleShot() {
        yield {
            type: "user",
            message: {
                role: "user",
                content: [{ type: "text", text: prompt }],
            },
            parent_tool_use_id: null,
        };
    }
    let resultText = "";
    let resultError = null;
    try {
        for await (const msg of sdkQuery({
            prompt: singleShot(),
            options: sdkOptions,
        })) {
            if (msg.type !== "result")
                continue;
            if (msg.subtype === "success" && typeof msg.result === "string") {
                resultText = msg.result.trim();
            }
            else {
                const errs = Array.isArray(msg.errors)
                    ? msg.errors.join("; ")
                    : msg.subtype;
                resultError = new ClaudeRunError(`Claude SDK 失败：${errs}`, "CLAUDE_CLI_FAILED");
            }
            break; // 一次性调用，拿到 result 即退出
        }
    }
    catch (err) {
        if (abortController.signal.aborted) {
            throw new ClaudeRunError("Claude 调用超时。", "CLAUDE_TIMEOUT");
        }
        const message = err instanceof Error ? err.message : String(err);
        // SDK 找不到 native binary 时会抛 "Claude Code native binary not found"。
        // 极少数情况下也可能透出 ENOENT。两种都归到"CLI_MISSING"，文案给用户。
        if (/Claude Code native binary not found|ENOENT/i.test(message)) {
            throw new ClaudeRunError("未找到 claude CLI。", "CLAUDE_CLI_MISSING");
        }
        throw new ClaudeRunError(`Claude SDK 失败：${message}`, "CLAUDE_CLI_FAILED");
    }
    finally {
        clearTimeout(timeoutHandle);
    }
    if (resultError)
        throw resultError;
    if (!resultText) {
        throw new ClaudeRunError("Claude 返回了空结果。", "CLAUDE_EMPTY_RESULT");
    }
    return resultText;
}
