import WebSocket from "ws";
import { boundedFetch, DingTalkError, object, string } from "./dingtalk-dws.js";

/** Native robot Stream ingress. DWS custom commands omit sender/group/message identity, so never use that escape hatch. */
export class DingTalkRobotStream {
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;
  private epoch = 0;
  private failures = 0;
  private active = 0;
  constructor(private readonly credentials: { clientId: string; clientSecret: string },
    private readonly receive: (payload: Record<string, any>) => Promise<void>,
    private readonly status: (connected: boolean) => void,
    private readonly request = boundedFetch) {}
  get connected() { return !this.closed && this.socket?.readyState === WebSocket.OPEN; }
  start() { void this.connect(); }
  private async connect() {
    const epoch = ++this.epoch;
    try {
      const response = object(JSON.parse((await this.request("https://api.dingtalk.com/v1.0/gateway/connections/open", {
        method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ ...this.credentials, ua: "Wand", subscriptions: [{ type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" }] }),
      })).toString()));
      if (this.closed || epoch !== this.epoch) return;
      const url = new URL(string(response.endpoint));
      // Credential-bearing tickets may only be sent to DingTalk's TLS stream hosts.
      if (url.protocol !== "wss:" || !(url.hostname === "dingtalk.com" || url.hostname.endsWith(".dingtalk.com")) || url.username || url.password || url.port || !string(response.ticket)) throw new Error("invalid stream endpoint");
      url.searchParams.set("ticket", response.ticket);
      const socket = new WebSocket(url, { maxPayload: 512 * 1024, handshakeTimeout: 15_000, followRedirects: false });
      this.socket = socket;
      socket.on("error", () => {}); // WebSocket errors can contain a secret-bearing URL; never log them.
      socket.once("open", () => {
        if (this.closed || epoch !== this.epoch) { socket.close(); return; }
        this.failures = 0; this.status(true);
        let alive = true;
        socket.on("pong", () => { alive = true; });
        this.heartbeat = setInterval(() => { if (!alive) { socket.terminate(); return; } alive = false; if (socket.readyState === WebSocket.OPEN) socket.ping(); }, 30_000);
        this.heartbeat.unref?.();
      });
      socket.on("message", raw => {
        if (this.closed || epoch !== this.epoch || this.active >= 32) return;
        let frame: Record<string, any>;
        try { frame = object(JSON.parse(raw.toString())); } catch { return; }
        if (frame.type === "SYSTEM") {
          if (["ping", "disconnect"].includes(string(frame.headers?.topic))) {
            socket.send(JSON.stringify({ code: 200, headers: frame.headers, message: "OK", data: frame.data }));
            if (frame.headers.topic === "disconnect") socket.close();
          }
          return;
        }
        if (frame.type !== "CALLBACK" || frame.headers?.topic !== "/v1.0/im/bot/messages/get" || !string(frame.headers?.messageId)) return;
        let data: Record<string, any>;
        try { data = object(JSON.parse(string(frame.data))); } catch { return; }
        this.active++;
        // Acknowledge only after durable admission, not after model completion. On failure leave unacknowledged for redelivery.
        void this.receive(data).then(() => {
          if (!this.closed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ code: 200,
            headers: { contentType: "application/json", messageId: frame.headers.messageId }, message: "OK", data: JSON.stringify({ response: {} }) }));
        }).catch(() => {}).finally(() => { this.active--; });
      });
      socket.once("close", () => { if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = undefined; if (!this.closed && epoch === this.epoch) { this.status(false); this.reconnect(epoch); } });
    } catch (error) {
      if (this.closed || epoch !== this.epoch) return;
      this.status(false);
      if (!(error instanceof DingTalkError && [401, 403].includes(error.httpStatus ?? 0))) this.reconnect(epoch);
    }
  }
  private reconnect(epoch: number) {
    if (this.closed || epoch !== this.epoch || this.retry || this.failures >= 6) return;
    this.retry = setTimeout(() => { this.retry = undefined; void this.connect(); }, Math.min(60_000, 1000 * 2 ** Math.min(6, this.failures++)));
    this.retry.unref?.();
  }
  dispose() { this.closed = true; this.epoch++; if (this.retry) clearTimeout(this.retry); if (this.heartbeat) clearInterval(this.heartbeat); this.socket?.close(); }
}
