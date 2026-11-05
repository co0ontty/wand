import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { startStructuredCli } from "./structured-exec-pump.js";
import type { StructuredExecHost } from "./structured-exec-host.js";
import { CodexAppProtocolReducer } from "./codex-app-protocol.js";
import type { CodexAppLaunch } from "./codex-app-worker.js";
import { cliUnacceptedFacts } from "./structured-failure.js";
import { nativeImagePaths } from "./structured-attachment-input.js";
import { whichSync } from "./path-repair.js";
import type { SessionSnapshot } from "./types.js";
import { thinkingEffortToCodexReasoningEffort } from "./structured-provider-common.js";
import { createNdjsonLineHandler } from "./structured-ndjson.js";
import { createCodexStderrReader } from "./codex-stderr.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
} from "./structured-runner.js";

/** The persistent host owns the worker and its App Server RPC connection. */
export function buildCodexArgs(_session: SessionSnapshot): string[] {
  const js = fileURLToPath(new URL("./codex-app-worker.js", import.meta.url));
  return existsSync(js) ? [js] : ["--import", import.meta.resolve("tsx"), js.replace(/\.js$/, ".ts")];
}

export function buildCodexLaunch(session: SessionSnapshot, prompt: string, env: NodeJS.ProcessEnv): CodexAppLaunch {
  const bypass = session.autoApprovePermissions === true || session.mode === "full-access" || session.mode === "managed";
  const writable = session.mode === "auto-edit" || session.mode === "agent" || session.mode === "agent-max";
  return {
    file: whichSync("codex", { env }) ?? "codex",
    sessionId: session.id,
    requestId: session.structuredState?.activeRequestId ?? randomUUID(),
    inputMessageId: [...(session.messages ?? [])].reverse().find(turn => turn.role === "user")?.messageId ?? randomUUID(),
    prompt,
    threadId: session.claudeSessionId ?? null,
    cwd: session.cwd,
    model: session.selectedModel?.trim() && session.selectedModel.trim() !== "default" ? session.selectedModel.trim() : undefined,
    developerInstructions: [session.systemPrompt?.trim(), session.runtimeSystemPrompt?.trim()].filter(Boolean).join("\n\n") || undefined,
    effort: thinkingEffortToCodexReasoningEffort(session.thinkingEffort),
    sandbox: bypass ? "danger-full-access" : writable ? "workspace-write" : "read-only",
    images: nativeImagePaths(prompt),
  };
}

/** Translates App Server events into the existing Codex runner and question-card contract. */
export class CodexRunner implements StructuredRunnerAdapter {
  constructor(
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly execHost?: StructuredExecHost,
  ) {}

  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    const launch = buildCodexLaunch(context.session, context.prompt, context.env);
    context.onSystemPrompt?.("developerInstructions", [
      { source: "会话角色/规则快照", text: context.session.systemPrompt?.trim() ?? "" },
      { source: "本轮运行规则与知识快照", text: context.session.runtimeSystemPrompt?.trim() ?? "" },
    ]);
    const reducer = new CodexAppProtocolReducer(context.session);
    let unparsedStdout = false;
    let protocolEventObserved = false;
    let rejected = false;
    let retryForbidden = false;
    let accepted = false;
    return startStructuredCli({
      sessionId: context.session.id,
      file: process.execPath,
      args: buildCodexArgs(context.session),
      cwd: context.session.cwd,
      env: context.env,
      stdinData: JSON.stringify(launch) + "\n",
      observer,
      execHost: this.execHost,
      requestId: launch.requestId,
      spawnProcess: this.spawnProcess,
      createState: () => reducer.state,
      createStderrReader: createCodexStderrReader,
      processLine: createNdjsonLineHandler({
        observer,
        onUnparsed: () => { unparsedStdout = true; },
        handleEvent: (event) => {
          if (!event || typeof event !== "object" || Array.isArray(event)) return;
          protocolEventObserved = true;
          const record = event as Record<string, any>;
          if (record.type === "wand_codex_rejected") {
            rejected = true;
            retryForbidden = record.retryForbidden === true;
          }
          if (record.type === "wand_codex_accepted"
            || (record.type === "wand_codex_event" && record.event?.method === "turn/started")) accepted = true;
          // Commit the preceding assistant segment before the reducer opens the next one.
          context.onCodexInputEvent?.(record, reducer.state);
          if (reducer.apply(event)) observer.onUpdate(reducer.state);
        },
      }),
      finalize: (ctx, exitCode, signal, spawnError) => ({
        state: reducer.state,
        exitCode,
        signal,
        stderr: ctx.stderr,
        primaryError: reducer.primaryError,
        errors: reducer.errors,
        spawnError,
        ...(retryForbidden ? { retryForbidden: true } : {}),
        ...(accepted ? { inputAccepted: true } : cliUnacceptedFacts({
          state: reducer.state,
          primaryError: reducer.primaryError,
          protocolError: rejected,
          unparsedStdout,
          signal,
          exitCode,
          previousSessionId: context.session.claudeSessionId,
          noProtocolEvent: !protocolEventObserved,
          ...(spawnError ? { spawnError } : {}),
        })),
      }),
    });
  }
}
