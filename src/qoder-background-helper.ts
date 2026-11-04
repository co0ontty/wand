/** Qoder's documented shell-prefix and PostToolUse hooks, scoped to one ACP owner. */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";

async function notify(event: Record<string, unknown>, wait = false): Promise<any> {
  const socketPath = process.env.WAND_QODER_BACKGROUND_SOCKET;
  if (!socketPath) return null;
  return await new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const finish = (result: unknown = null) => { socket.destroy(); resolve(result); };
    socket.setTimeout(wait ? 86400_000 : 20_000, () => finish());
    socket.on("error", () => finish());
    socket.on("data", chunk => {
      buffer += chunk.toString();
      if (buffer.length > 65536) return finish();
      if (!buffer.includes("\n")) return;
      try { finish(JSON.parse(buffer.split("\n")[0])); } catch { finish(); }
    });
    socket.on("close", () => finish());
    socket.on("connect", () => socket.write(JSON.stringify({ type: "background", event }) + "\n"));
  });
}

if (process.argv[2] === "hook") {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) process.exit(0);
  }
  try {
    const hook = JSON.parse(input);
    if (hook.hook_event_name === "PostToolUse" && hook.tool_name === "Bash" && hook.tool_response?.kind === "backgrounded") {
      const task = hook.tool_response;
      const response = await notify({ kind: "task", sessionId: hook.session_id, toolCallId: hook.tool_use_id,
        taskId: task.taskId, pid: task.pid, outputFile: task.outputFile }, true);
      const completion = response?.completion;
      const message = completion && !completion.cancelled
        ? "Wand ACP 兼容等待已结束，以下是原命令真实子进程 close 回执（覆盖后台已启动提示，不是新用户指令）：" + JSON.stringify(completion) + "。以 taskId 及退出码为准，读取 outputFile 后报告真实结果；不要重跑命令，不把非零退出码说成成功。"
        : "Wand 后台兼容等待已取消或失去回执，结果未知；不得宣称成功，不要自动重跑命令。";
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: message } }) + "\n");

    }
  } catch { /* A hook must not replace the provider's permission or tool result. */ }
} else if (process.argv[2] === "shell" && typeof process.argv[3] === "string") {
  const id = randomUUID();
  const registered = await notify({ kind: "start", id, pid: process.pid });
  if (registered?.ok !== true) {
    process.stderr.write("Wand 无法登记命令，本次未执行。\n");
    process.exit(125);
  }
  const env = { ...process.env };
  // Nested programs must not accidentally register work against this shell's ACP owner.
  for (const key of ["WAND_QODER_BACKGROUND_SOCKET", "QODER_SHELL_PREFIX", "QODERCN_SHELL_PREFIX", "CLAUDE_CODE_SHELL_PREFIX"]) delete env[key];
  const originalPrefix = env.WAND_QODER_ORIGINAL_SHELL_PREFIX;
  delete env.WAND_QODER_ORIGINAL_SHELL_PREFIX;
  const shell = env.SHELL || "/bin/bash";
  const child = spawn(originalPrefix || shell, originalPrefix ? [process.argv[3]] : ["-c", process.argv[3]], { env, stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  const result = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("error", () => resolve({ code: 127, signal: null }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  // Repeating an exit receipt is idempotent; the command itself is never repeated.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reply = await notify({ kind: "exit", id, pid: process.pid, ...result });
    if (reply?.ok === true || reply?.cancelled) break;
  }
  process.exitCode = result.code ?? (result.signal ? 128 + (constants.signals[result.signal as keyof typeof constants.signals] ?? 1) : 1);
}
