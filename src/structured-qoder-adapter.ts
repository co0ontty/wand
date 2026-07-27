import { spawn } from "node:child_process";

import { ClaudeCliProtocolReducer } from "./structured-claude-protocol.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
  StructuredRunnerResult,
} from "./structured-runner.js";
import type { SessionSnapshot } from "./types.js";

export function buildQoderArgs(session: SessionSnapshot, prompt: string): string[] {
  const args = ["-p", prompt, "--output-format", "stream-json"];
  const model = session.selectedModel?.trim();
  if (model && model !== "default") args.push("--model", model);

  if (
    session.autoApprovePermissions === true
    || session.mode === "full-access"
    || session.mode === "managed"
  ) {
    args.push("--permission-mode", "bypass_permissions");
  } else if (session.mode === "auto-edit") {
    args.push("--permission-mode", "accept_edits");
  }
  if (session.claudeSessionId) args.push("-r", session.claudeSessionId);
  return args;
}

/** Owns the official Qoder CLI print process and its stream-json protocol. */
export class QoderRunner implements StructuredRunnerAdapter {
  constructor(private readonly spawnProcess: typeof spawn = spawn) {}

  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    const args = buildQoderArgs(context.session, context.prompt);
    const spawnedAt = new Date().toISOString();
    const child = this.spawnProcess("qodercli", args, {
      cwd: context.session.cwd,
      env: context.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const reducer = new ClaudeCliProtocolReducer(context.session);
    let lineBuffer = "";
    let stderr = "";
    let stdoutTail = "";
    let primaryError: string | null = null;
    let settled = false;

    const result = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: NodeJS.ErrnoException,
    ): StructuredRunnerResult => ({
      state: reducer.state,
      exitCode,
      signal,
      stderr,
      stdoutTail,
      primaryError,
      ...(spawnError ? { spawnError } : {}),
    });
    const processLine = (line: string): void => {
      if (!observer.isActive()) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (event && typeof event === "object" && !Array.isArray(event)) {
        const record = event as Record<string, unknown>;
        observer.onEvent?.(record);
        if (record.type === "result" && record.subtype !== "success") {
          const errors = Array.isArray(record.errors)
            ? record.errors.filter((item): item is string => typeof item === "string")
            : [];
          primaryError = errors.join("\n") || "Qoder CLI execution failed";
        }
      }
      if (reducer.apply(event, context.session.mode === "managed")) observer.onUpdate(reducer.state);
    };

    const completion = new Promise<StructuredRunnerResult>((resolve) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        if (!observer.isActive()) return;
        const text = chunk.toString();
        observer.onStdout?.(text);
        const trimmed = text.trim();
        if (trimmed) stdoutTail = trimmed.slice(-1024);
        lineBuffer += text;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (!observer.isActive()) return;
        const text = chunk.toString();
        observer.onStderr?.(text);
        stderr += text;
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        resolve(result(null, null, error as NodeJS.ErrnoException));
      });
      child.on("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        if (lineBuffer.trim()) processLine(lineBuffer);
        lineBuffer = "";
        resolve(result(exitCode, signal));
      });
    });

    return {
      args,
      spawnedAt,
      pid: child.pid ?? null,
      completion,
      interrupt: () => { try { child.kill("SIGTERM"); } catch { /* best effort */ } },
    };
  }
}
