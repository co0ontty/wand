import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { isRunningAsRoot } from "./env-utils.js";
import { startStructuredCli } from "./structured-exec-pump.js";
import type { StructuredExecHost } from "./structured-exec-host.js";
import { buildLanguageDirective, buildManagedAutonomyDirective } from "./language-prompt.js";
import { thinkingEffortToClaudeCliEffort, thinkingEffortToSdkBudget } from "./structured-provider-common.js";
import { ClaudeCliProtocolReducer } from "./structured-claude-protocol.js";
import type {
  StructuredRunnerAdapter,
  StructuredRunnerContext,
  StructuredRunnerExecution,
  StructuredRunnerObserver,
  StructuredRunnerResult,
} from "./structured-runner.js";
import type { ExecutionMode, SessionSnapshot } from "./types.js";

const ROOT_FALLBACK_ALLOWED_TOOLS = [
  "Bash", "Edit", "Write", "Read", "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch",
];

type WandPermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export interface PermissionPolicy {
  permissionMode: WandPermissionMode;
  allowedTools: string[] | undefined;
}

const mcpServerCache = new Map<string, { mtimeFingerprint: string; names: string[] }>();

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function mtimeOf(filePath: string): number {
  try { return statSync(filePath).mtimeMs; } catch { return 0; }
}

function extractMcpServerKeys(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const mcpServers = (node as Record<string, unknown>).mcpServers;
  return mcpServers && typeof mcpServers === "object"
    ? Object.keys(mcpServers as Record<string, unknown>)
    : [];
}

function collectMcpServerNames(cwd: string): string[] {
  const userConfigPath = path.join(homedir(), ".claude.json");
  const projectMcpPath = path.join(cwd, ".mcp.json");
  const fingerprint = `${mtimeOf(userConfigPath)}:${mtimeOf(projectMcpPath)}`;
  const cached = mcpServerCache.get(cwd);
  if (cached?.mtimeFingerprint === fingerprint) return cached.names;

  const names = new Set<string>();
  const userConfig = readJsonSafe(userConfigPath);
  if (userConfig) {
    for (const name of extractMcpServerKeys(userConfig)) names.add(name);
    const projects = userConfig.projects;
    if (projects && typeof projects === "object") {
      for (const name of extractMcpServerKeys((projects as Record<string, unknown>)[cwd])) names.add(name);
    }
  }
  for (const name of extractMcpServerKeys(readJsonSafe(projectMcpPath))) names.add(name);

  const result = Array.from(names);
  mcpServerCache.set(cwd, { mtimeFingerprint: fingerprint, names: result });
  return result;
}

export function derivePermissionPolicy(mode: ExecutionMode, autoApprove: boolean, cwd: string): PermissionPolicy {
  const shouldBypass = autoApprove || mode === "full-access" || mode === "managed";
  const shouldAcceptEdits = mode === "auto-edit";
  const mcpAllow = shouldBypass ? [] : collectMcpServerNames(cwd).map((name) => `mcp__${name}`);
  const withMcp = (base: string[] | undefined): string[] | undefined => {
    if (!mcpAllow.length) return base;
    return base ? [...base, ...mcpAllow] : [...mcpAllow];
  };

  if (!isRunningAsRoot()) {
    if (shouldBypass) return { permissionMode: "bypassPermissions", allowedTools: undefined };
    if (shouldAcceptEdits) return { permissionMode: "acceptEdits", allowedTools: withMcp(undefined) };
    return { permissionMode: "default", allowedTools: withMcp(undefined) };
  }
  if (shouldBypass || shouldAcceptEdits) {
    return { permissionMode: "acceptEdits", allowedTools: withMcp(ROOT_FALLBACK_ALLOWED_TOOLS) };
  }
  return { permissionMode: "default", allowedTools: withMcp(undefined) };
}

export function buildAppendSystemPromptParts(language: string | undefined, mode: ExecutionMode): string[] {
  const trimmedLanguage = language?.trim();
  const parts: string[] = [];
  if (mode === "managed") parts.push(buildManagedAutonomyDirective(trimmedLanguage === "中文"));
  if (trimmedLanguage) {
    const directive = buildLanguageDirective(trimmedLanguage);
    if (directive) parts.push(directive);
  }
  return parts;
}

export interface ClaudeCliArgsOptions {
  permissionPolicy: PermissionPolicy;
  systemPromptParts?: string[];
}

export function buildClaudeCliArgs(session: SessionSnapshot, options: ClaudeCliArgsOptions): string[] {
  const args = ["-p", "--verbose", "--output-format", "stream-json"];
  if (options.permissionPolicy.permissionMode !== "default") {
    args.push("--permission-mode", options.permissionPolicy.permissionMode);
  }
  if (options.permissionPolicy.allowedTools) args.push("--allowedTools", ...options.permissionPolicy.allowedTools);
  for (const part of options.systemPromptParts ?? []) args.push("--append-system-prompt", part);

  const modelChoice = session.selectedModel?.trim();
  if (modelChoice && modelChoice !== "default") args.push("--model", modelChoice);
  const effort = thinkingEffortToClaudeCliEffort(session.thinkingEffort);
  if (effort) args.push("--effort", effort);
  if (session.mode === "managed") args.push("--disallowedTools", "AskUserQuestion");
  if (session.claudeSessionId) args.push("--resume", session.claudeSessionId);
  return args;
}

export function buildClaudeSdkThinking(
  effort: SessionSnapshot["thinkingEffort"],
): { type: "enabled"; budgetTokens: number } | { type: "disabled" } {
  const budgetTokens = thinkingEffortToSdkBudget(effort);
  return budgetTokens > 0 ? { type: "enabled", budgetTokens } : { type: "disabled" };
}

export interface ClaudeCliRunnerOptions {
  language?: () => string | undefined;
}

/** Owns the Claude print-mode process and its stream-json protocol. */
export class ClaudeCliRunner implements StructuredRunnerAdapter {
  constructor(
    private readonly options: ClaudeCliRunnerOptions = {},
    private readonly execHost?: StructuredExecHost,
  ) {}

  start(context: StructuredRunnerContext, observer: StructuredRunnerObserver): StructuredRunnerExecution {
    const permissionPolicy = derivePermissionPolicy(
      context.session.mode,
      context.session.autoApprovePermissions ?? false,
      context.session.cwd,
    );
    const args = buildClaudeCliArgs(context.session, {
      permissionPolicy,
      systemPromptParts: buildAppendSystemPromptParts(this.options.language?.(), context.session.mode),
    });
    const reducer = new ClaudeCliProtocolReducer(context.session);
    let killedForQuestion = false;
    let stdoutTail = "";
    return startStructuredCli({
      sessionId: context.session.id,
      file: "claude",
      args,
      cwd: context.session.cwd,
      env: context.env,
      stdinData: context.prompt,
      observer,
      execHost: this.execHost,
      createState: () => reducer.state,
      processLine: (line, ctx) => {
        if (!observer.isActive()) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: unknown;
        try { event = JSON.parse(trimmed); } catch { return; }
        if (event && typeof event === "object" && !Array.isArray(event)) {
          observer.onEvent?.(event as Record<string, unknown>);
        }
        if (reducer.apply(event, context.session.mode === "managed")) {
          observer.onUpdate(reducer.state);
        }
        if (reducer.askUserQuestionDetected && !killedForQuestion) {
          killedForQuestion = true;
          ctx.requestStop();
        }
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
        primaryError: null,
        stopReason: killedForQuestion ? "ask-user-question" : undefined,
        spawnError,
      }),
    });
  }
}
