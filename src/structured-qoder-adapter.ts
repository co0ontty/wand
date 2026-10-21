import { spawn } from "node:child_process";

import { ClaudeCliProtocolReducer } from "./structured-claude-protocol.js";
import { cliUnacceptedFacts } from "./structured-failure.js";
import { startStructuredCli } from "./structured-exec-pump.js";
import type { StructuredExecHost } from "./structured-exec-host.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
} from "./structured-runner.js";
import { systemPromptArgs, thinkingEffortToQoderEffort } from "./structured-provider-common.js";
import { createNdjsonLineHandler } from "./structured-ndjson.js";
import type { SessionSnapshot } from "./types.js";

export function buildQoderArgs(session: SessionSnapshot, prompt: string): string[] {
  const args = ["-p", prompt, "--output-format", "stream-json"];
  const model = session.selectedModel?.trim();
  if (model && model !== "default") args.push("--model", model);
  const effort = thinkingEffortToQoderEffort(session.thinkingEffort);
  if (effort) args.push("--reasoning-effort", effort);

  // 与 PTY runner 一致：Qoder 一律以 yolo（bypass_permissions）启动。结构化 runner 没有
  // 权限桥，--print 下未批准的调用只会被拒绝，因此不做任何模式降级。
  args.push("--permission-mode", "bypass_permissions");
  args.push(...systemPromptArgs(session));
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
    let protocolError = false;
    let unparsedStdout = false;
    let protocolEventObserved = false;
    const previousSessionId = context.session.claudeSessionId;
    return startStructuredCli({
      sessionId: context.session.id,
      file: "qodercli",
      args,
      cwd: context.session.cwd,
      env: context.env,
      observer,
      execHost: this.execHost,
      requestId: context.session.structuredState?.activeRequestId ?? undefined,
      spawnProcess: this.spawnProcess,
      createState: () => reducer.state,
      processLine: createNdjsonLineHandler({
        observer,
        onUnparsed: () => { unparsedStdout = true; },
        handleEvent: (event) => {
          if (event && typeof event === "object" && !Array.isArray(event)) {
            protocolEventObserved = true;
            const record = event as Record<string, unknown>;
            if (record.type === "result" && record.subtype !== "success") {
              const errors = Array.isArray(record.errors)
                ? record.errors.filter((item): item is string => typeof item === "string")
                : [];
              primaryError = errors.join("\n") || "Qoder CLI execution failed";
              protocolError = true;
            }
          }
          if (reducer.apply(event, context.session.mode === "managed")) observer.onUpdate(reducer.state);
        },
      }),
      onStdoutText: (text) => {
        const trimmed = text.trim();
        if (trimmed) stdoutTail = trimmed.slice(-1024);
      },
      finalize: (ctx, exitCode, signal, spawnError) => {
        // CLI 自己合成的拒绝回显（`<synthetic>`）也算 provider 亲自答复，
        // 它带上了拒绝原文，即使没有 result 事件也能定性。
        if (!primaryError && reducer.syntheticRefusalText) {
          primaryError = reducer.syntheticRefusalText;
          protocolError = true;
        }
        return {
          state: reducer.state,
          exitCode,
          signal,
          stderr: ctx.stderr,
          stdoutTail,
          primaryError,
          ...(spawnError ? { spawnError } : {}),
          ...cliUnacceptedFacts({
            state: reducer.state,
            primaryError,
            protocolError: protocolError || reducer.errorResultObserved,
            unparsedStdout,
            signal,
            progressed: reducer.assistantWorkObserved,
            exitCode,
            previousSessionId,
            noProtocolEvent: !protocolEventObserved,
            ...(spawnError ? { spawnError } : {}),
          }),
        };
      },
    });
  }
}
