/**
 * 语义化版本工具：单一真源，供 server / tui / path-repair / models 共用，
 * 避免各处各写一份比较/提取逻辑导致 debug.MMDDHHMM 后缀排序不一致。
 */
/** 从任意文本中提取 X.Y.Z[-/+后缀] 形式的版本号（带捕获组）。 */
export declare const SEMVER_PATTERN: RegExp;
/** 提取文本中的第一个语义化版本号，没有则返回 null。 */
export declare function extractSemver(text: string): string | null;
/**
 * 比较两个语义化版本号，返回正数 = a > b，负数 = a < b，0 = 相等。
 * - 容忍前导 `v`（如 nvm/fnm 的 v18.0.0 目录名）。
 * - 主版本逐段数值比较；相等时按 semver 规则：无 prerelease > 有 prerelease。
 * - 两者都有 prerelease 时按 `.` 分段比较（数字段数值比、非数字段字典序），
 *   贴近标准 semver，避免 debug.MMDDHHMM 后缀因纯字典序而跨月/跨年排反。
 */
export declare function compareSemver(a: string, b: string): number;
