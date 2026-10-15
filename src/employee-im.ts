import { createHmac } from "node:crypto";
import { dingTalkWebhook } from "./employee-im-config.js";
import { EMPLOYEE_IM_EVENTS, type EmployeeImEvent, type EmployeeImProvider } from "./employee-im-types.js";
import type { WandStorage } from "./storage.js";

interface Notice { employeeId: string; provider: EmployeeImProvider; event: EmployeeImEvent; context: { sessionId?: string; title?: string } }
interface EmployeeImOptions { fetch?: typeof fetch; timeoutMs?: number; now?: () => number; onFailure?: () => void }

/** Best-effort, bounded and non-blocking. No automatic retry after an unknown delivery. */
export class EmployeeImService {
  private readonly queue: Notice[] = [];
  private readonly controllers = new Set<AbortController>();
  private active = 0;
  private disposed = false;
  constructor(private readonly storage: WandStorage, private readonly options: EmployeeImOptions = {}) {}

  notify(employeeId: string, event: EmployeeImEvent, context: Notice["context"] = {}): void {
    if (this.disposed) return;
    try {
      const employee = this.storage.getSiliconEmployeeDefinition(employeeId);
      if (!employee || employee.archivedAt) return;
      const config = this.storage.getEmployeeImConfig(employeeId);
      if (!config.events.includes(event)) return;
      for (const provider of ["telegram", "dingtalk"] as const) {
        if (!config[provider].enabled) continue;
        if (this.queue.length >= 100) { this.failure(); continue; }
        this.queue.push({ employeeId, provider, event, context: { sessionId: context.sessionId, title: context.title?.slice(0, 200) } });
      }
      this.pump();
    } catch { this.failure(); }
  }

  async test(employeeId: string, provider: EmployeeImProvider): Promise<void> {
    if (this.disposed || this.active >= 4) throw new Error("IM 发送繁忙，请稍后重试。");
    this.active += 1;
    try { await this.deliver(employeeId, provider, "Wand · IM 测试通知\n此员工的消息渠道已连通。"); }
    finally { this.active -= 1; this.pump(); }
  }

  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  private failure(): void {
    try { this.options.onFailure?.(); } catch { /* observers cannot affect execution */ }
  }

  private pump(): void {
    while (!this.disposed && this.active < 4 && this.queue.length) {
      const item = this.queue.shift()!;
      this.active += 1;
      void this.sendNotice(item).catch(() => this.failure()).finally(() => { this.active -= 1; this.pump(); });
    }
  }

  private async sendNotice(item: Notice): Promise<void> {
    // Re-read before delivery: queued notices cannot survive disable/archive/delete or a changed selection.
    const employee = this.storage.getSiliconEmployeeDefinition(item.employeeId);
    const config = this.storage.getEmployeeImConfig(item.employeeId);
    if (!employee || employee.archivedAt || !config[item.provider].enabled || !config.events.includes(item.event)) return;
    const label = EMPLOYEE_IM_EVENTS.find(event => event.value === item.event)?.label;
    if (!label) return;
    const lines = [`Wand · ${label}`, `员工：${employee.name.slice(0, 40)}`, `任务：${item.context.title || "员工任务"}`];
    if (item.context.sessionId) lines.push(`会话：${item.context.sessionId.slice(0, 100)}`);
    await this.deliver(item.employeeId, item.provider, lines.join("\n").slice(0, 3000));
  }

  private async deliver(employeeId: string, provider: EmployeeImProvider, text: string): Promise<void> {
    if (!this.storage.getSiliconEmployeeDefinition(employeeId)) throw new Error("员工不存在。");
    const { config, credentials } = this.storage.getEmployeeImSettings(employeeId);
    let url: URL;
    let body: Record<string, unknown>;
    if (provider === "telegram") {
      if (!credentials.botToken || !config.telegram.chatId) throw new Error("请先保存 Telegram Bot Token 和 Chat ID。");
      url = new URL(`https://api.telegram.org/bot${credentials.botToken}/sendMessage`);
      body = { chat_id: config.telegram.chatId, text };
    } else {
      if (!credentials.webhook) throw new Error("请先保存钉钉机器人 Webhook。");
      url = dingTalkWebhook(credentials.webhook);
      if (credentials.secret) {
        const timestamp = String((this.options.now ?? Date.now)());
        const sign = createHmac("sha256", credentials.secret).update(`${timestamp}\n${credentials.secret}`).digest("base64");
        url.searchParams.set("timestamp", timestamp);
        url.searchParams.set("sign", sign);
      }
      body = { msgtype: "text", text: { content: text } };
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 8000);
    timer.unref?.();
    try {
      const response = await (this.options.fetch ?? fetch)(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        redirect: "error", signal: controller.signal,
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error("IM 发送失败，请检查机器人凭据、接收目标及网络。"); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("IM 服务未返回有效回执。");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 16_384) throw new Error("IM 回执过大。");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      if (provider === "telegram" ? payload.ok !== true : payload.errcode !== 0) throw new Error("IM 服务拒绝了消息。");
    } catch {
      // Provider bodies and errors may include the credential-bearing request URL: never echo/log them.
      throw new Error("IM 发送未确认，请检查机器人凭据、接收目标及网络；不会自动重发。");
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
}
