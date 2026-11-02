import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PiInputHandoff, PiInputResolution } from "./pi-native-input.js";

/** Private bridge address is bound to one immutable Wand execution, never an HTTP path. */
export function codexControlDirectory(sessionId: string, requestId: string): string {
  return path.join(os.tmpdir(), `wand-codex-${process.getuid?.() ?? "local"}-${createHash("sha256").update(sessionId + ":" + requestId).digest("hex").slice(0, 24)}`);
}

export interface CodexControlInput {
  id: string;
  text: string;
  questionId?: string;
  /** 同一插入消息携带的图片路径；插话也要能原生看图。 */
  images?: string[];
}

export function sendCodexControl(sessionId: string, requestId: string, input: CodexControlInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path.join(codexControlDirectory(sessionId, requestId), "control.sock"));
    let buffer = "";
    let settled = false;
    let connected = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => finish(new Error("Codex 输入送达结果未知，请勿重复提交。")));
    socket.once("connect", () => {
      connected = true;
      socket.write(JSON.stringify(input) + "\n");
    });
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 64 * 1024) return finish(new Error("Codex 控制回执过大。"));
      if (!buffer.includes("\n")) return;
      try {
        const result = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        finish(result.ok === true ? undefined : Object.assign(new Error(result.error || "Codex 拒绝了输入。"), { definiteRejection: result.rejected === true }));
      } catch (error) { finish(error as Error); }
    });
    socket.once("error", error => finish(connected ? error : Object.assign(error, { definiteRejection: true })));
    socket.once("close", () => finish(new Error("Codex 输入连接已断开，送达结果未知。")));
  });
}

export function resolveCodexInput(sessionId: string, requestId: string, handoff: PiInputHandoff): PiInputResolution {
  if (!/^[a-f0-9-]{36}$/i.test(handoff.id)) return { state: "unknown" };
  try {
    const receipt = JSON.parse(readFileSync(path.join(codexControlDirectory(sessionId, requestId), handoff.id + ".json"), "utf8"));
    if (receipt.state === "committed") return { state: "committed", offer: { ...handoff, text: receipt.text } };
    if (receipt.state === "rejected") return { state: "unclaimed" };
    return { state: "unknown" };
  } catch (error) {
    return { state: "unknown" };
  }
}

/** Called only after the persistent host acknowledged exit and reservations were reconciled. */
export function forgetCodexControl(sessionId: string, requestId: string): void {
  rmSync(codexControlDirectory(sessionId, requestId), { recursive: true, force: true });
}
