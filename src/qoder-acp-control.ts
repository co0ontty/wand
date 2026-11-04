import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PiInputHandoff, PiInputResolution } from "./pi-native-input.js";
import type { StructuredPermissionDecision } from "./structured-runner.js";

/**
 * Qoder ACP worker 的控制通信层。
 *
 * 与 Codex app-server 的 control.sock 类似，该 socket 绑定到单次回合执行
 * （sessionId + activeRequestId），位于用户级安全临时目录中。
 * 用于向 worker 投递工具授权裁决、结构化询问回答、运行中插话及中断指令。
 */

export function qoderControlDirectory(sessionId: string, requestId: string): string {
  return path.join(
    os.tmpdir(),
    `wand-qoder-${process.getuid?.() ?? "local"}-${createHash("sha256").update(`${sessionId}:${requestId}`).digest("hex").slice(0, 24)}`,
  );
}

export type QoderControlCommand =
  | { type: "background"; event: Record<string, unknown> }
  | { type: "permission_resolution"; escalationId: string; resolution: StructuredPermissionDecision }
  | { type: "question_answer"; id: string; toolUseId: string; text: string }
  | { type: "steer"; id: string; text: string; images?: string[]; config?: { model?: string; mode: string; thinkingEffort?: string | null; autoApprovePermissions: boolean } }
  | { type: "interrupt" };

export function sendQoderControl(sessionId: string, requestId: string, command: QoderControlCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const socketPath = path.join(qoderControlDirectory(sessionId, requestId), "control.sock");
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    let connected = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      // Before connect no command bytes can have been written. After connect,
      // a transport failure is unknown delivery unless the worker explicitly rejects.
      if (error) reject(Object.assign(error, { definiteRejection: !connected || (error as Error & { definiteRejection?: boolean }).definiteRejection === true }));
      else resolve();
    };

    socket.setEncoding("utf8");
    socket.setTimeout(20_000, () => finish(new Error("Qoder 控制通信超时。")));
    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(command)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 64 * 1024) return finish(new Error("Qoder 控制回执过大。"));
      if (!buffer.includes("\n")) return;
      try {
        const result = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as { ok?: boolean; rejected?: boolean; error?: string };
        finish(result.ok === true ? undefined : Object.assign(new Error(result.error || "Qoder 控制被拒绝。"), {
          definiteRejection: result.rejected === true,
        }));
      } catch (error) {
        finish(error as Error);
      }
    });
    socket.once("error", finish);
    socket.once("close", () => finish(new Error("Qoder 控制连接断开。")));
  });
}

/** 检查插话是否已被 worker 确认接收并进入会话。 */
export function resolveQoderInput(sessionId: string, requestId: string, handoff: PiInputHandoff): PiInputResolution {
  if (!/^[a-f0-9-]{36}$/i.test(handoff.id)) return { state: "unknown" };
  try {
    const receiptPath = path.join(qoderControlDirectory(sessionId, requestId), `${handoff.id}.json`);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { state?: string; text?: string };
    if (receipt.state === "committed" && typeof receipt.text === "string") {
      return { state: "committed", offer: { ...handoff, text: receipt.text } };
    }
    if (receipt.state === "rejected" || receipt.state === "unclaimed") {
      return { state: "unclaimed" };
    }
    return { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

/** 仅在回合收敛且不再需要控制通道时清理控制目录。 */
export function forgetQoderControl(sessionId: string, requestId: string): void {
  rmSync(qoderControlDirectory(sessionId, requestId), { recursive: true, force: true });
}
