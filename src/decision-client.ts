import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { DECISION_CHAIN_WAIT_MS, DECISION_MAX_BYTES, DecisionError, parseDecisionRequest, parseDecisionResult, type DecisionRequest } from "./decision-types.js";

/** No admin/password lookup, redirects, or implicit remote fallback. Credentials stay in headers. */
export async function callDecisionService(request: DecisionRequest | null, env = process.env): Promise<unknown> {
  const endpoint = env.WAND_DECISION_URL;
  const token = env.WAND_DECISION_TOKEN;
  if (!endpoint || !token || !/^wd_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new DecisionError("UNBOUND", "请在启用了本地决策的 Wand 结构化会话中调用；不会自动读取管理员凭据。");
  }
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new DecisionError("UNBOUND", "无效决策服务地址。"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new DecisionError("UNBOUND", "远程决策服务必须使用HTTPS，地址只能包含origin。");
  }
  url.pathname = request ? "/api/decisions/evaluate" : "/api/decisions/status";
  const data = request ? JSON.stringify(request) : "";
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, {
      method: request ? "POST" : "GET",
      ...(url.protocol === "https:" && env.WAND_DECISION_CA ? { ca: readFileSync(env.WAND_DECISION_CA) } : {}),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json",
        ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 128 * 1024) req.destroy(new Error("oversize"));
        else chunks.push(chunk);
      });
      res.on("error", () => reject(new DecisionError("CONNECTION_FAILED", "决策服务响应中断。", 502)));
      res.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
            // Only bounded machine codes, never echo a remote response containing secrets.
            const code = typeof value?.code === "string" && /^[A-Z_]{1,40}$/.test(value.code) ? value.code : "HTTP_ERROR";
            reject(new DecisionError(code, `决策调用失败 (${code}, HTTP ${res.statusCode})。`, res.statusCode));
          } else if (!request) resolve(value);
          else {
            // A configured backup is a text evaluator, not LAYA (and can have output tokens).
            if (typeof value?.model !== "string" || !value.model || value.model.length > 512
              || !["laya-mlx", "decision-expert"].includes(value.runtime)) throw new Error("identity");
            const result = parseDecisionResult(value, request, { model: value.model, runtime: value.runtime });
            if (value.executor !== undefined) {
              const executor = value.executor;
              if (!executor || typeof executor.employeeId !== "string" || executor.employeeId.length > 128
                || !Number.isSafeInteger(executor.candidate) || executor.candidate < 0 || executor.candidate > 3
                || !["local", "free-group", "cli", "sdk"].includes(executor.source)) throw new Error("executor");
              result.executor = { employeeId: executor.employeeId, candidate: executor.candidate, source: executor.source };
            }
            resolve(result);
          }
        } catch (error) {
          reject(error instanceof DecisionError ? error : new DecisionError("INVALID_RESULT", "决策服务返回了无效结果。", 502));
        }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error("deadline")), request ? DECISION_CHAIN_WAIT_MS : 50_000);
    req.once("close", () => clearTimeout(deadline));
    req.once("error", () => reject(new DecisionError("CONNECTION_FAILED", "连接决策服务失败或超时。", 502)));
    req.end(data);
  });
}

export async function runDecisionCli(args: string[]): Promise<void> {
  if (args.length !== 1 || !["--stdin", "--status"].includes(args[0]!)) {
    throw new DecisionError("USAGE", "用法：wand decide --stdin（JSON标准输入）或 --status。");
  }
  let request: DecisionRequest | null = null;
  if (args[0] === "--stdin") {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > DECISION_MAX_BYTES) throw new DecisionError("REQUEST_TOO_LARGE", "请求超过32KiB。", 413);
      chunks.push(buffer);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new DecisionError("INVALID_REQUEST", "标准输入必须是有效JSON。"); }
    request = parseDecisionRequest(value);
  }
  process.stdout.write(`${JSON.stringify(await callDecisionService(request))}\n`);
}
