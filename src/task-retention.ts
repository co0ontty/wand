/** 看板任务的自动归档 / 自动删除。会话保留期不走这里。 */
export const TASK_RETENTION_MIN_DAYS = 1;
export const TASK_RETENTION_MAX_DAYS = 365;
export const DEFAULT_TASK_AUTO_ARCHIVE_DAYS = 7;
export const DEFAULT_TASK_AUTO_DELETE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TaskRetentionSettings {
  /** 空闲达到天数后自动归档。关闭后只停止自动归档，手动归档不受影响。 */
  autoArchiveEnabled: boolean;
  autoArchiveDays: number;
  /** 归档后达到天数仍未恢复则删除。关闭后已归档任务会一直保留。 */
  autoDeleteEnabled: boolean;
  autoDeleteDays: number;
}

export function defaultTaskRetention(): TaskRetentionSettings {
  return {
    autoArchiveEnabled: true,
    autoArchiveDays: DEFAULT_TASK_AUTO_ARCHIVE_DAYS,
    autoDeleteEnabled: true,
    autoDeleteDays: DEFAULT_TASK_AUTO_DELETE_DAYS,
  };
}

/** 读路径：缺字段或坏值回落到默认，避免旧库或脏数据把保留期清掉。 */
export function normalizeTaskRetention(input: unknown): TaskRetentionSettings {
  const defaults = defaultTaskRetention();
  if (!input || typeof input !== "object" || Array.isArray(input)) return defaults;
  const raw = input as Record<string, unknown>;
  return {
    autoArchiveEnabled: typeof raw.autoArchiveEnabled === "boolean" ? raw.autoArchiveEnabled : defaults.autoArchiveEnabled,
    autoArchiveDays: retentionDays(raw.autoArchiveDays, defaults.autoArchiveDays),
    autoDeleteEnabled: typeof raw.autoDeleteEnabled === "boolean" ? raw.autoDeleteEnabled : defaults.autoDeleteEnabled,
    autoDeleteDays: retentionDays(raw.autoDeleteDays, defaults.autoDeleteDays),
  };
}

/** 写路径：缺字段或越界直接拒绝，不能把半份设置存成「看起来保存成功」。 */
export function parseTaskRetention(input: unknown): TaskRetentionSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("任务保留设置必须是对象。");
  }
  const raw = input as Record<string, unknown>;
  return {
    autoArchiveEnabled: retentionFlag(raw.autoArchiveEnabled, "自动归档"),
    autoArchiveDays: requireRetentionDays(raw.autoArchiveDays, "空闲天数"),
    autoDeleteEnabled: retentionFlag(raw.autoDeleteEnabled, "自动删除"),
    autoDeleteDays: requireRetentionDays(raw.autoDeleteDays, "归档后天数"),
  };
}

/** `null` 表示该动作关闭。调用方每次扫描都要重新读，不能缓存启动时的窗口。 */
export function taskRetentionWindows(input: unknown): { idleMs: number | null; archivedMs: number | null } {
  const policy = normalizeTaskRetention(input);
  return {
    idleMs: policy.autoArchiveEnabled ? policy.autoArchiveDays * DAY_MS : null,
    archivedMs: policy.autoDeleteEnabled ? policy.autoDeleteDays * DAY_MS : null,
  };
}

function retentionDays(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  if (value < TASK_RETENTION_MIN_DAYS || value > TASK_RETENTION_MAX_DAYS) return fallback;
  return value;
}

function retentionFlag(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label}开关必须是布尔值。`);
  return value;
}

function requireRetentionDays(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < TASK_RETENTION_MIN_DAYS
    || value > TASK_RETENTION_MAX_DAYS
  ) {
    throw new Error(`${label}必须是 ${TASK_RETENTION_MIN_DAYS}–${TASK_RETENTION_MAX_DAYS} 的整数。`);
  }
  return value;
}
