import { SessionSnapshot } from "../types.js";
export interface SessionRow {
    id: string;
    glyph: string;
    runner: string;
    cwd: string;
    state: string;
    duration: string;
    /** 用于上色的语义级别（blessed tag 由调用方决定）。 */
    tone: "running" | "idle" | "archived" | "exited" | "failed" | "stopped";
}
/** 把绝对路径压缩为友好显示：`~/foo` 或者长路径只保留尾部。 */
export declare function shortenCwd(cwd: string, max?: number): string;
/** 从 SessionSnapshot 推导出一行表格数据。状态规则见 plan。 */
export declare function formatSession(snap: SessionSnapshot, now?: number): SessionRow;
/** 把行集按"活跃优先 → idle → 已结束 → archived"排序，再按开始时间倒序。 */
export declare function sortRows(snaps: SessionSnapshot[]): SessionSnapshot[];
