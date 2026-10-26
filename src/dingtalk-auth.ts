import { randomUUID } from "node:crypto";
import { array, boundedFetch, DingTalkError, object, string, type DwsTransport } from "./dingtalk-dws.js";
import type { DingTalkAccount } from "./dingtalk-types.js";

type Attempt = { id: string; state: "waiting" | "exchanging" | "connected" | "failed" | "cancelled"; url: string; userCode: string; expiresAt: string; error?: string; account?: DingTalkAccount; abort: AbortController };
/** Structured device OAuth, not scraping localized CLI stderr. Codes stay in memory and are exchanged over stdin. */
export class DingTalkAuth {
  private attempts = new Map<string, Attempt>();
  constructor(private readonly dws: DwsTransport, private readonly request = boundedFetch) {}
  async accounts(): Promise<DingTalkAccount[]> {
    const result = await this.dws.call(["profile", "list"]);
    return array(result.profiles ?? result.items ?? result.data).flatMap(raw => {
      const p = object(raw), id = string(p.profile ?? p.id), parts = id.split(":");
      const corpId = string(p.corpId) || parts[0], userId = string(p.userId) || parts[1];
      if (!corpId || !userId || p.authenticated === false) return [];
      return [{ id: `${corpId}:${userId}`, corpId, userId, name: string(p.userName ?? p.name) || userId, corpName: string(p.corpName) || corpId }];
    });
  }
  private async json(url: string, init: RequestInit) { return object(JSON.parse((await this.request(url, { ...init, redirect: "error" })).toString())); }
  async begin() {
    for (const a of this.attempts.values()) if (a.state === "waiting" || a.state === "exchanging") return this.public(a);
    this.attempts.clear();
    const client = await this.json("https://mcp.dingtalk.com/cli/clientId", {});
    const clientId = string(client.result);
    if (client.success !== true || !clientId) throw new DingTalkError("auth_unavailable", "无法取得钉钉授权应用信息。");
    const raw = await this.json("https://login.dingtalk.com/oauth2/device/code.json", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, scope: "openid corpid" }).toString(),
    });
    const data = object(raw.result);
    const deviceCode = string(data.deviceCode), flowId = string(data.flowId);
    const url = string(data.verificationUriComplete ?? data.verificationUri);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new DingTalkError("auth_url", "钉钉授权链接无效。"); }
    if (parsed.protocol !== "https:" || !["login.dingtalk.com", "open-dev.dingtalk.com"].includes(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw new DingTalkError("auth_url", "钉钉返回了未受信任的授权链接。");
    if (raw.success !== true || !deviceCode || !string(data.userCode)) throw new DingTalkError("auth_invalid", "钉钉设备授权响应无效。");
    const expires = Math.min(600, Math.max(30, Number(data.expiresIn) || 600));
    const attempt: Attempt = { id: randomUUID(), state: "waiting", url, userCode: data.userCode,
      expiresAt: new Date(Date.now() + expires * 1000).toISOString(), abort: new AbortController() };
    this.attempts.set(attempt.id, attempt);
    void this.poll(attempt, clientId, deviceCode, flowId, Math.min(30, Math.max(2, Number(data.interval) || 2)));
    return this.public(attempt);
  }
  get(id: string) { const value = this.attempts.get(id); if (!value) throw new DingTalkError("not_found", "授权会话不存在或已失效，请重新授权。"); return this.public(value); }
  cancel(id: string) {
    const value = this.attempts.get(id); if (!value) throw new DingTalkError("not_found", "授权会话已失效。");
    if (value.state === "waiting") { value.state = "cancelled"; value.url = ""; value.userCode = ""; value.abort.abort(); }
    // A one-time code already handed to DWS cannot be promised revoked. Report the real phase.
    return this.public(value);
  }
  private public(a: Attempt) { return { id: a.id, state: a.state, url: a.state === "waiting" ? a.url : undefined, userCode: a.state === "waiting" ? a.userCode : undefined, expiresAt: a.expiresAt, error: a.error, account: a.account }; }
  private async poll(a: Attempt, clientId: string, deviceCode: string, flowId: string, interval: number) {
    try {
      while (a.state === "waiting" && Date.now() < Date.parse(a.expiresAt)) {
        await new Promise<void>((resolve, reject) => {
          const cancelled = () => { clearTimeout(timer); reject(new Error("cancelled")); };
          const timer = setTimeout(() => { a.abort.signal.removeEventListener("abort", cancelled); resolve(); }, interval * 1000);
          timer.unref?.(); a.abort.signal.addEventListener("abort", cancelled, { once: true });
        });
        if (a.abort.signal.aborted) return;
        const response = flowId
          ? await this.json(`https://mcp.dingtalk.com/cli/oauth/device/poll?flowId=${encodeURIComponent(flowId)}`, { signal: a.abort.signal })
          : await this.json("https://login.dingtalk.com/oauth2/device/token.json", { method: "POST", signal: a.abort.signal,
            headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: clientId }).toString() });
        const data = object(response.data ?? response.result);
        if (["REJECTED", "EXPIRED", "CANCELLED"].includes(data.status)) throw new DingTalkError("auth_rejected", "授权被取消、拒绝或已过期，请重新授权。");
        const code = string(data.authCode);
        if (!code) continue;
        if (a.abort.signal.aborted || a.state !== "waiting") return;
        a.state = "exchanging"; a.url = ""; a.userCode = "";
        const result = await this.dws.call(["auth", "exchange", "--code-stdin", "--client-id", clientId], { input: code });
        const corpId = string(result.corpId), userId = string(result.userId);
        if (!corpId || !userId) throw new DingTalkError("identity", "钉钉未返回可验证的组织和用户身份。");
        if (a.abort.signal.aborted || a.state !== "exchanging") return;
        a.account = { id: `${corpId}:${userId}`, corpId, userId, name: userId, corpName: corpId };
        a.state = "connected"; a.url = ""; a.userCode = ""; return;
      }
      if (a.state === "waiting") throw new DingTalkError("expired", "授权已过期，请重新授权。");
    } catch (error) {
      if (a.state !== "waiting" && a.state !== "exchanging") return;
      a.state = "failed"; a.url = ""; a.userCode = ""; a.error = error instanceof DingTalkError ? error.message : "授权未完成，请重试；不会输出或保存授权码。";
    }
  }
  dispose() { for (const a of this.attempts.values()) { a.state = "cancelled"; a.abort.abort(); } this.attempts.clear(); }
}
