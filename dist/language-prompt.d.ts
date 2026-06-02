/**
 * 强语言指令生成器：供 PTY runner、structured-session-manager（CLI + SDK 两个分支）、
 * 一次性 SDK 调用（claude-sdk-runner.ts）共用。
 *
 * 原本各 runner 散落写 "请使用中文回复" 这种软指令，Claude 写技术内容时还是会条件
 * 反射切英文（"Now let me ..."、"OK, ..."），用户设置中文也照样夹英文。
 *
 * 这一版用三招把约束做硬：
 *   1. 明确禁止常见英文起句模式（"Now let me"、"Let me check"、"OK,"、"First,"
 *      …）并给出反例——给 Claude 一组具体可识别可避免的字串
 *   2. 区分"自然语言"（必须目标语言）和"技术标识符"（路径/命令/API 名可保留原文），
 *      避免 Claude 误以为"代码也要翻译"
 *   3. 自检指令：让 Claude 发现自己即将出错时主动重写
 *
 * 英文模式（"English"）下 Claude 默认就用英文，只补一句 subagent 透传。
 */
export declare function buildLanguageDirective(language: string): string;
/**
 * 完全托管自主模式的系统提示：供 PTY runner 与 structured runner（CLI + SDK）共用，
 * 避免两处各抄一份中英双语文案导致改一处漏一处。
 */
export declare function buildManagedAutonomyDirective(isChinese: boolean): string;
