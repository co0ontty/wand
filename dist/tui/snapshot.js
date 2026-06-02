/**
 * 把主进程当前状态打包成 IPC snapshot。
 *
 * 这里同时被 IPC 服务端（远端 attach 客户端拉数据）调用。本地 TUI 仍然直接读
 * processManager / structuredSessions（避免一次额外的对象拷贝）。
 */
import { formatSession, sortRows } from "./session-formatter.js";
export function buildSnapshotData(inputs) {
    const ptyList = inputs.processManager.listSlim();
    let structuredList = [];
    try {
        structuredList = inputs.structuredSessions.listSlim();
    }
    catch { /* noop */ }
    const seen = new Set();
    const merged = [];
    for (const s of ptyList) {
        seen.add(s.id);
        merged.push(s);
    }
    for (const s of structuredList) {
        if (!seen.has(s.id))
            merged.push(s);
    }
    const sorted = sortRows(merged);
    let active = 0, archived = 0;
    for (const s of sorted) {
        if (s.archived)
            archived += 1;
        else if (s.status === "running")
            active += 1;
    }
    const header = {
        version: inputs.version,
        url: inputs.url,
        scheme: inputs.scheme,
        bindAddr: inputs.bindAddr,
        configPath: inputs.configPath,
        dbPath: inputs.dbPath,
        orphanRecoveredCount: inputs.orphanRecoveredCount,
        sessionCounts: { active, archived, total: sorted.length },
        startedAtMs: inputs.startedAtMs,
        rssBytes: safeRss(),
        pid: inputs.pid,
    };
    return {
        header,
        sessions: sorted.map((s) => formatSession(s)),
    };
}
function safeRss() {
    try {
        return process.memoryUsage().rss;
    }
    catch {
        return 0;
    }
}
