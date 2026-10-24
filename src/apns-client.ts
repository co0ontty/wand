import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { connect, type ClientHttp2Session } from "node:http2";

export type ApnsEnvironment = "production" | "sandbox";
export interface ApnsConfiguration {
  keyId: string;
  teamId: string;
  topic: string;
  environment: ApnsEnvironment;
  key: KeyObject;
}
export interface ApnsMessage {
  id: string;
  token: string;
  payload: string;
  expiresAt: number;
  collapseId: string;
  /** ActivityKit has a distinct token and derived topic; never substitute an ordinary device token. */
  pushType?: "alert" | "liveactivity";
  priority?: 5 | 10;
}
export interface ApnsResult {
  outcome: "accepted" | "invalid-device" | "retry" | "rejected";
  /** Bounded, provider-defined diagnostic only. Never include a token, payload or raw error. */
  reason: string;
}
export interface ApnsTransport {
  send(message: ApnsMessage): Promise<ApnsResult>;
  close(): void;
}

/** Deployment-owned paths/IDs only; the p8 itself never enters config.json, DTOs or logs. */
export function loadApnsConfiguration(env: NodeJS.ProcessEnv = process.env, configDirectory?: string): ApnsConfiguration | null {
  // A deployment-local file is deliberately separate from public/runtime WandConfig projections.
  // Explicit environment configuration wins as a whole; incomplete overrides fail closed.
  const names = ["WAND_APNS_KEY_PATH", "WAND_APNS_KEY_ID", "WAND_APNS_TEAM_ID", "WAND_APNS_TOPIC"] as const;
  const localFile = configDirectory ? path.join(configDirectory, "apns.json") : null;
  if (!names.some(name => env[name]) && !env.WAND_APNS_ENVIRONMENT && localFile && existsSync(localFile)) {
    try {
      const stat = statSync(localFile);
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0) throw new Error();
      const local = JSON.parse(readFileSync(localFile, "utf8")) as Record<string, unknown>;
      if (!local || typeof local !== "object" || Array.isArray(local)) throw new Error();
      const fields = ["keyPath", "keyId", "teamId", "topic", "environment"] as const;
      if (fields.some(field => typeof local[field] !== "string")) throw new Error();
      env = Object.fromEntries([...names, "WAND_APNS_ENVIRONMENT"].map((name, index) => [name, local[fields[index]!] as string]));
    } catch { throw new Error("本机 apns.json 不可用：需要权限0600的有效推送配置文件。"); }
  }
  const values = [env.WAND_APNS_KEY_PATH, env.WAND_APNS_KEY_ID, env.WAND_APNS_TEAM_ID, env.WAND_APNS_TOPIC];
  if (values.every(value => !value)) return null;
  if (values.some(value => !value)) throw new Error("APNs 配置不完整：需要 KEY_PATH、KEY_ID、TEAM_ID 和 TOPIC。");
  const [keyPath, keyId, teamId, topic] = values as string[];
  if (!/^[A-Z0-9]{10}$/.test(keyId!) || !/^[A-Z0-9]{10}$/.test(teamId!)
    || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(topic!) || topic!.length > 255) {
    throw new Error("APNs 的 key/team/topic 配置格式无效。");
  }
  const environment = env.WAND_APNS_ENVIRONMENT ?? "production";
  if (environment !== "production" && environment !== "sandbox") throw new Error("APNs environment 必须是 production 或 sandbox。");
  try {
    if (!path.isAbsolute(keyPath!)) throw new Error();
    const stat = statSync(keyPath!);
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0) throw new Error();
    const key = createPrivateKey(readFileSync(keyPath!));
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
    return { keyId: keyId!, teamId: teamId!, topic: topic!, environment, key };
  } catch {
    throw new Error("APNs 私钥不可用：需要本机可读、权限0600的P-256 p8文件。");
  }
}

export function createApnsJwt(config: ApnsConfiguration, now = Date.now()): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.keyId })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) })).toString("base64url");
  const input = `${header}.${claims}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key: config.key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

export function classifyApnsResponse(status: number, reason: unknown): ApnsResult {
  const safe = typeof reason === "string" && /^[A-Za-z]{1,64}$/.test(reason) ? reason : `HTTP${status}`;
  if (status === 200) return { outcome: "accepted", reason: "AcceptedByAPNs" };
  if (status === 410 || (status === 400 && ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(safe))) {
    return { outcome: "invalid-device", reason: safe };
  }
  return { outcome: status === 0 || status === 429 || status >= 500 || safe === "ExpiredProviderToken" ? "retry" : "rejected", reason: safe };
}

/** Low-volume alerts: bounded HTTP/2 request per delivery, only Apple's fixed TLS endpoints. */
export class ApnsClient implements ApnsTransport {
  private jwt = "";
  private jwtAt = 0;
  private closed = false;
  private readonly connections = new Set<ClientHttp2Session>();
  constructor(private readonly config: ApnsConfiguration, private readonly open: (url: string) => ClientHttp2Session = connect) {}

  send(message: ApnsMessage): Promise<ApnsResult> {
    if (this.closed) return Promise.resolve({ outcome: "retry", reason: "Stopped" });
    const now = Date.now();
    if (!this.jwt || now - this.jwtAt > 50 * 60_000) {
      this.jwt = createApnsJwt(this.config, now);
      this.jwtAt = now;
    }
    return new Promise(resolve => {
      const endpoint = this.config.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
      const connection = this.open(endpoint);
      this.connections.add(connection);
      let settled = false;
      const finish = (result: ApnsResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.connections.delete(connection);
        connection.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => finish({ outcome: "retry", reason: "Timeout" }), 10_000);
      timer.unref();
      connection.on("error", () => finish({ outcome: "retry", reason: "ConnectionError" }));
      connection.on("close", () => finish({ outcome: "retry", reason: "ConnectionClosed" }));
      connection.once("connect", () => {
        if (settled) return;
        try {
          const request = connection.request({
            ":method": "POST", ":path": `/3/device/${message.token}`,
            authorization: `bearer ${this.jwt}`,
            "apns-topic": message.pushType === "liveactivity" ? `${this.config.topic}.push-type.liveactivity` : this.config.topic,
            "apns-push-type": message.pushType ?? "alert", "apns-priority": String(message.priority ?? (message.pushType === "liveactivity" ? 5 : 10)), "apns-id": message.id,
            "apns-expiration": String(Math.floor(message.expiresAt / 1000)), "apns-collapse-id": message.collapseId,
            "content-type": "application/json",
          });
          let status = 0;
          let body = "";
          request.setEncoding("utf8");
          request.on("response", headers => { status = Number(headers[":status"] ?? 0); });
          request.on("data", (chunk: string) => {
            body += chunk;
            if (Buffer.byteLength(body) > 4096) finish({ outcome: "retry", reason: "ResponseTooLarge" });
          });
          request.on("error", () => finish({ outcome: "retry", reason: "StreamError" }));
          request.on("end", () => {
            let reason: unknown;
            try { reason = (JSON.parse(body) as { reason?: unknown }).reason; } catch { /* empty success body */ }
            const result = classifyApnsResponse(status, reason);
            if (result.reason === "ExpiredProviderToken") this.jwt = "";
            finish(result);
          });
          request.end(message.payload);
        } catch { finish({ outcome: "retry", reason: "RequestError" }); }
      });
    });
  }

  close(): void {
    this.closed = true;
    for (const connection of this.connections) connection.destroy();
    this.connections.clear();
  }
}
