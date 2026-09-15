/**
 * POSIX shell 引用工具。
 *
 * 单引号是唯一在所有 POSIX shell 里都没有展开语义的引用形式；字符串里已有的
 * 单引号用 `'\''` 收尾再续上，保证结果仍然是一个字面量。
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 把一组值拼成 `'a' 'b'` 形式的参数列表（用于生成 shell 脚本里的数组字面量）。 */
export function shellQuoteAll(values: readonly string[]): string {
  return values.map(shellQuote).join(" ");
}
