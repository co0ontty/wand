import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { FEEDBACK_FEATURE_LABELS, validateFeedbackReport, type FeedbackEnvelope, type FeedbackReport } from "../feedback.js";
import type { WandStorage } from "../storage.js";

/** Central collection projection. Ciphertext, dedup receipt and task/comment commit together. */
export class FeedbackRepository {
  constructor(private readonly db: DatabaseSync, private readonly s: WandStorage) {}

  ingestFeedback(report: FeedbackReport, envelope: FeedbackEnvelope): "stored" | "duplicate" | "full" {
    validateFeedbackReport(report);
    return this.s.transaction(() => {
      if (this.db.prepare("SELECT report_id FROM feedback_reports WHERE report_id = ?").get(report.id)) return "duplicate";
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM feedback_reports").get() as { count: number };
      if (count.count >= 2000) return "full";
      const group = this.db.prepare("SELECT task_id FROM feedback_task_features WHERE feature = ?").get(report.feature) as { task_id: string | null } | undefined;
      let task = group?.task_id ? this.s.getWandTask(group.task_id) : null;
      const receivedAt = new Date().toISOString();
      if (!task) {
        task = this.s.createWandTask({
          title: `【${report.username}】-【${FEEDBACK_FEATURE_LABELS[report.feature]}】`, titleSource: "user",
          description: [
            `自动收集的系统错误反馈。`, `错误功能：${FEEDBACK_FEATURE_LABELS[report.feature]}`,
            `上报用户：${report.username}`, `来源：${report.source}`, `服务端版本：${report.version}`,
            ...(report.clientVersion ? [`客户端版本：${report.clientVersion}`] : []),
            `发生时间：${report.occurredAt}`, `报告 ID：${report.id}`,
            "", "原始错误消息及堆栈以密文保存，可由管理员通过反馈日志接口读取；此任务不会自动启动执行。",
          ].join("\n"),
          labels: ["系统反馈", FEEDBACK_FEATURE_LABELS[report.feature]], status: "todo", priority: "high",
        });
        this.db.prepare(`INSERT INTO feedback_task_features (feature, task_id) VALUES (?, ?)
          ON CONFLICT(feature) DO UPDATE SET task_id = excluded.task_id`).run(report.feature, task.id);
      } else {
        this.db.prepare(`INSERT INTO wand_task_comments (id, task_id, author_name, body, created_at)
          VALUES (?, ?, ?, ?, ?)`).run(crypto.randomUUID(), task.id, report.username,
            `【${report.username}】也遇到了相同的问题。`, receivedAt);
        // Comments are activity, not permission to reopen/archive/dispatch the task.
        this.db.prepare("UPDATE wand_tasks SET updated_at = ? WHERE id = ?").run(receivedAt, task.id);
      }
      this.db.prepare(`INSERT INTO feedback_reports
        (report_id, feature, task_id, occurred_at, received_at, envelope_json) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(report.id, report.feature, task.id, report.occurredAt, receivedAt, JSON.stringify(envelope));
      this.s.notifyTaskTitleChange();
      return "stored";
    });
  }

  latestFeedbackEnvelopes(taskId?: string): Array<{ receivedAt: string; envelope: FeedbackEnvelope }> {
    const rows = (taskId
      ? this.db.prepare("SELECT received_at, envelope_json FROM feedback_reports WHERE task_id = ? ORDER BY rowid DESC LIMIT 50").all(taskId)
      : this.db.prepare("SELECT received_at, envelope_json FROM feedback_reports ORDER BY rowid DESC LIMIT 50").all()) as Array<{ received_at: string; envelope_json: string }>;
    return rows.map(row => ({ receivedAt: row.received_at, envelope: JSON.parse(row.envelope_json) as FeedbackEnvelope }));
  }
}
