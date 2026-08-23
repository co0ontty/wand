import { spawn } from "node:child_process";

import { startStructuredCli } from "./structured-exec-pump.js";
import type { StructuredExecHost } from "./structured-exec-host.js";
import { CodexProtocolReducer } from "./structured-codex-protocol.js";
import type { SessionSnapshot } from "./types.js";
import { thinkingEffortToCodexReasoningEffort } from "./structured-provider-common.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
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
  constructor(
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly execHost?: StructuredExecHost,
  ) {}

  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    const args = buildCodexArgs(context.session);
    const reducer = new CodexProtocolReducer(context.session);
    return startStructuredCli({
      sessionId: context.session.id,
      file: "codex",
      args,
      cwd: context.session.cwd,
      env: context.env,
      stdinData: context.prompt,
      observer,
      execHost: this.execHost,
      spawnProcess: this.spawnProcess,
      createState: () => reducer.state,
      processLine: (line) => {
        if (!observer.isActive()) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: unknown;
        try { event = JSON.parse(trimmed); } catch { return; }
        if (event && typeof event === "object" && !Array.isArray(event)) {
          observer.onEvent?.(event as Record<string, unknown>);
        }
        if (reducer.apply(event)) observer.onUpdate(reducer.state);
      },
      finalize: (ctx, exitCode, signal, spawnError) => ({
        state: reducer.state,
        exitCode,
        signal,
        stderr: ctx.stderr,
        primaryError: reducer.primaryError,
        errors: reducer.errors,
        spawnError,
      }),
    });
  }
}
