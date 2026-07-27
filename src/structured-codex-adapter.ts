import { spawn } from "node:child_process";

import { CodexProtocolReducer } from "./structured-codex-protocol.js";
import type { SessionSnapshot } from "./types.js";
import { thinkingEffortToCodexReasoningEffort } from "./structured-provider-common.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
  StructuredRunnerResult,
} from "./structured-runner.js";

/** Build the stable CLI contract for a structured Codex turn. */
export function buildCodexArgs(session: SessionSnapshot): string[] {
  const args = ["exec", "--json", "--color", "never"];
  const shouldBypass = session.autoApprovePermissions === true
    || session.mode === "full-access"
    || session.mode === "managed";

  if (shouldBypass) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (session.mode === "auto-edit" || session.mode === "agent" || session.mode === "agent-max") {
    args.push("--sandbox", "workspace-write");
  } else {
    args.push("--sandbox", "read-only");
  }

  args.push("--skip-git-repo-check");
  const modelChoice = session.selectedModel?.trim();
  if (modelChoice && modelChoice !== "default") args.push("--model", modelChoice);

  const reasoningEffort = thinkingEffortToCodexReasoningEffort(session.thinkingEffort);
  if (reasoningEffort) args.push("-c", `model_reasoning_effort=${reasoningEffort}`);

  if (session.claudeSessionId) args.push("resume", session.claudeSessionId, "-");
  else args.push("-");
  return args;
}

/** Owns the Codex CLI process and translates its NDJSON protocol into runner-neutral state. */
export class CodexRunner implements StructuredRunnerAdapter {
  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    const args = buildCodexArgs(context.session);
    const spawnedAt = new Date().toISOString();
    const child = spawn("codex", args, {
      cwd: context.session.cwd,
      env: context.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin?.end(context.prompt);

    const reducer = new CodexProtocolReducer(context.session);
    let lineBuffer = "";
    let stderr = "";
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
      primaryError: reducer.primaryError,
      errors: reducer.errors,
      spawnError,
    });
    const processLine = (line: string): void => {
      if (!observer.isActive()) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: unknown;
      try { event = JSON.parse(trimmed); } catch { return; }
      if (event && typeof event === "object" && !Array.isArray(event)) {
        observer.onEvent?.(event as Record<string, unknown>);
      }
      if (reducer.apply(event)) observer.onUpdate(reducer.state);
    };

    const completion = new Promise<StructuredRunnerResult>((resolve) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        if (!observer.isActive()) return;
        const text = chunk.toString();
        observer.onStdout?.(text);
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
      interrupt: () => {
        try { child.kill("SIGTERM"); } catch { /* best-effort external interruption */ }
      },
    };
  }
}
