import { spawn } from "node:child_process";

import { ClaudeCliProtocolReducer } from "./structured-claude-protocol.js";
import { startStructuredCli } from "./structured-exec-pump.js";
import type { StructuredExecHost } from "./structured-exec-host.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
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
  constructor(
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly execHost?: StructuredExecHost,
  ) {}

  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    const args = buildQoderArgs(context.session, context.prompt);
    const reducer = new ClaudeCliProtocolReducer(context.session);
    let stdoutTail = "";
    let primaryError: string | null = null;
    return startStructuredCli({
      sessionId: context.session.id,
      file: "qodercli",
      args,
      cwd: context.session.cwd,
      env: context.env,
      observer,
      execHost: this.execHost,
      spawnProcess: this.spawnProcess,
      createState: () => reducer.state,
      processLine: (line) => {
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
      },
      onStdoutText: (text) => {
        const trimmed = text.trim();
        if (trimmed) stdoutTail = trimmed.slice(-1024);
      },
      finalize: (ctx, exitCode, signal, spawnError) => ({
        state: reducer.state,
        exitCode,
        signal,
        stderr: ctx.stderr,
        stdoutTail,
        primaryError,
        ...(spawnError ? { spawnError } : {}),
      }),
    });
  }
}
