import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { whichSync } from "./path-repair.js";

export type CodexPredictionOutcome =
  | { state: "ready"; text: string }
  | { state: "unsupported"; reason: string }
  | { state: "failed"; reason: string };

function probeArgs(): string[] {
  const js = fileURLToPath(new URL("./codex-prediction-probe.js", import.meta.url));
  return existsSync(js) ? [js] : ["--import", import.meta.resolve("tsx"), js.replace(/\.js$/, ".ts")];
}

/**
 * 用户显式要求「预测下一条」时的一次性探测。
 *
 * 只有完成过至少一个回合的 Codex 会话才有 `threadId` / `sourceTurnId`；能力取决于账户与
 * 协议版本，所以失败必须如实返回（`unsupported`），不能退化成自动发送或改写草稿。
 */
export function requestCodexPrediction(options: {
  env: NodeJS.ProcessEnv;
  threadId: string;
  /** 省略时由探针取最近一个回合。 */
  sourceTurnId?: string;
  cwd: string;
  timeoutMs?: number;
}): Promise<CodexPredictionOutcome> {
  return new Promise((resolve) => {
    const file = whichSync("codex", { env: options.env }) ?? "codex";
    const child = spawn(process.execPath, probeArgs(), {
      cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let settled = false;
    const settle = (outcome: CodexPredictionOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      resolve(outcome);
    };
    const timer = setTimeout(() => settle({ state: "failed", reason: "预测请求超时。" }),
      Math.max(8_000, (options.timeoutMs ?? 40_000) + 5_000));
    child.stderr.on("data", () => {});
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (Buffer.byteLength(out) > 512 * 1024) { settle({ state: "failed", reason: "预测响应过大。" }); return; }
      let end: number;
      while ((end = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, end);
        out = out.slice(end + 1);
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "prediction") {
          settle({ state: "ready", text: typeof event.text === "string" ? event.text : "" });
        } else if (event.type === "unsupported") {
          settle({ state: "unsupported", reason: String(event.message ?? "当前账户不支持预测。") });
        } else if (event.type === "error") {
          settle({ state: "failed", reason: String(event.message ?? "预测失败。") });
        }
      }
    });
    child.once("error", (error) => settle({ state: "failed", reason: error.message }));
    child.once("close", () => { if (!settled) settle({ state: "failed", reason: "预测进程提前退出。" }); });
    child.stdin.write(JSON.stringify({
      file, threadId: options.threadId, sourceTurnId: options.sourceTurnId,
      cwd: options.cwd, timeoutMs: options.timeoutMs,
    }) + "\n");
    child.stdin.end();
  });
}
