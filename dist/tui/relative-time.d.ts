/** 把绝对时间字符串（ISO）转为简短的相对时长，例：`2m`、`10m`、`1h`、`3d`。 */
export declare function relativeAge(fromIso: string, nowMs?: number): string;
/** 计算两个时间点之间的相对时长（结束 - 开始）。 */
export declare function durationBetween(startIso: string, endIso: string | null): string;
