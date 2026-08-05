import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import type { WandConfig } from "./types.js";

export class WandCliApi {
  private cookie = "";

  constructor(private readonly config: WandConfig) {}

  async get<T>(pathname: string): Promise<T> {
    return this.request<T>("GET", pathname);
  }

  async post<T>(pathname: string, body: unknown): Promise<T> {
    return this.request<T>("POST", pathname, body);
  }

  private async login(): Promise<void> {
    const result = await this.rawRequest("POST", "/api/login", { password: this.config.password });
    if (result.status < 200 || result.status >= 300) throw new Error(`Wand 登录失败 (HTTP ${result.status})`);
    this.cookie = result.cookies.map((value) => value.split(";", 1)[0]).join("; ");
    if (!this.cookie) throw new Error("Wand 服务未返回登录会话。");
  }

  private async request<T>(method: "GET" | "POST", pathname: string, body?: unknown): Promise<T> {
    if (!this.cookie) await this.login();
    const result = await this.rawRequest(method, pathname, body, this.cookie);
    let parsed: unknown = {};
    try { parsed = result.body ? JSON.parse(result.body) : {}; } catch { /* handled below */ }
    const error = parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error?: unknown }).error === "string"
      ? (parsed as { error: string }).error
      : null;
    if (result.status < 200 || result.status >= 300 || error) {
      throw new Error(error || `Wand 请求失败 (HTTP ${result.status})`);
    }
    return parsed as T;
  }

  private rawRequest(
    method: "GET" | "POST",
    pathname: string,
    body?: unknown,
    cookie?: string,
  ): Promise<{ status: number; body: string; cookies: string[] }> {
    return new Promise((resolve, reject) => {
      const protocol = this.config.https ? "https:" : "http:";
      const url = new URL(`${protocol}//127.0.0.1:${this.config.port}${pathname}`);
      const payload = body === undefined ? "" : JSON.stringify(body);
      const request = protocol === "https:" ? httpsRequest : httpRequest;
      const req = request(url, {
        method,
        rejectUnauthorized: false,
        timeout: 30_000,
        headers: {
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      }, (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          responseBody += chunk;
          if (responseBody.length > 20 * 1024 * 1024) req.destroy(new Error("Wand 响应超过 20 MB。"));
        });
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          body: responseBody,
          cookies: res.headers["set-cookie"] ?? [],
        }));
      });
      req.on("timeout", () => req.destroy(new Error("连接 Wand 服务超时。")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}
