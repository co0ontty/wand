import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildClaudeCliArgs } from "../src/structured-claude-adapter.js";
import { buildCodexArgs } from "../src/structured-codex-adapter.js";
import { buildGrokArgs } from "../src/structured-grok-adapter.js";
import { buildOpenCodeArgs } from "../src/structured-opencode-adapter.js";
import { buildPiArgs } from "../src/structured-pi-adapter.js";
import { buildQoderArgs } from "../src/structured-qoder-adapter.js";
import type { SessionSnapshot } from "../src/types.js";

// Opt-in only. CLI output may contain credentials or personal data. Never
// persist raw stdout/stderr/argv/env, including on errors or timeouts.
if (!process.argv.includes("--record")) {
  throw new Error("Pass --record to run the real provider CLIs (may consume provider quota).");
}

const PROMPT = "Reply exactly WAND_MIGRATION_FIXTURE_OK. Do not use tools.";
const OUT = path.resolve("tests/fixtures/structured-cli-recordings");
const MAX_STREAM = 4 * 1024 * 1024;
const ENUM_KEYS = new Set([
  "type", "subtype", "role", "status", "kind", "stopReason", "stop_reason", "phase",
  "sessionUpdate", "toolName", "tool_name", "reason", "level", "permissionMode",
]);
const ID_KEYS = new Set([
  "id", "session_id", "sessionId", "sessionID", "thread_id", "threadId", "message_id",
  "messageId", "call_id", "callId", "toolCallId", "tool_use_id", "item_id", "parent_id",
]);
const DENIED_KEY = /token|secret|password|api.?key|authorization|cookie|header|endpoint|url|path|cwd|file|prompt|env/i;
const OMIT_KEY = new Set([
  "toolsAdded", "sections", "parameters", "metadata", "snapshot",
  "tools", "slash_commands", "agents", "skills", "plugins", "capabilities",
]);
const ONLY = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
const requestedTimeout = Number(process.argv.find((arg) => arg.startsWith("--timeout-ms="))?.split("=")[1]);
const TIMEOUT_MS = Number.isFinite(requestedTimeout) && requestedTimeout >= 5_000 && requestedTimeout <= 180_000
  ? requestedTimeout : 90_000;
const claudeModel = process.argv.find((arg) => arg.startsWith("--claude-model="))?.slice("--claude-model=".length);
const qoderModel = process.argv.find((arg) => arg.startsWith("--qoder-model="))?.slice("--qoder-model=".length);
const grokModel = process.argv.find((arg) => arg.startsWith("--grok-model="))?.slice("--grok-model=".length);
for (const model of [claudeModel, qoderModel, grokModel]) {
  if (model && !/^[a-zA-Z0-9._:/-]{1,100}$/.test(model)) throw new Error("Invalid model id");
}
const grokApprove = process.argv.includes("--grok-approve");
const claudeNoUserSettings = process.argv.includes("--claude-no-user-settings");

function sanitizedEvent(value: unknown, ids: Map<string, string>, key = "", depth = 0): unknown {
  if (depth > 10) return "<depth-limit>";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? 1 : 0;
  if (typeof value === "string") {
    if (ID_KEYS.has(key)) {
      if (!ids.has(value)) ids.set(value, `fixture-id-${ids.size + 1}`);
      return ids.get(value);
    }
    if (ENUM_KEYS.has(key) && /^[a-zA-Z][a-zA-Z0-9_./:-]{0,47}$/.test(value)) return value;
    return "FIXTURE_TEXT";
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizedEvent(item, ids, key, depth + 1));
  if (!value || typeof value !== "object") return null;
  const result: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,48}$/.test(field) || DENIED_KEY.test(field) || OMIT_KEY.has(field)) continue;
    result[field] = sanitizedEvent(item, ids, field, depth + 1);
  }
  return result;
}

function testSession(cwd: string, provider: SessionSnapshot["provider"]): SessionSnapshot {
  return {
    id: "fixture-session", sessionKind: "structured", provider,
    runner: "fixture", command: "fixture", cwd, mode: "default", status: "idle",
    exitCode: null, startedAt: new Date(0).toISOString(), endedAt: null,
    output: "", archived: false, archivedAt: null,
  };
}

async function record(provider: string): Promise<boolean> {
  const root = mkdtempSync(path.join(tmpdir(), "wand-structured-record-"));
  try {
    const session = testSession(root, provider as SessionSnapshot["provider"]);
    if (provider === "claude" && claudeModel) session.selectedModel = claudeModel;
    if (provider === "qoder" && qoderModel) session.selectedModel = qoderModel;
    if (provider === "grok" && grokModel) session.selectedModel = grokModel;
    if (provider === "grok" && grokApprove) session.mode = "managed";
    let file: string;
    let args: string[];
    let stdinData: string | undefined;
    switch (provider) {
      case "claude":
        file = "claude";
        args = buildClaudeCliArgs(session, { permissionPolicy: { permissionMode: "default", allowedTools: undefined } });
        if (claudeNoUserSettings) args.push("--setting-sources", "project,local");
        stdinData = PROMPT;
        break;
      case "codex":
        file = "codex";
        args = buildCodexArgs(session);
        stdinData = PROMPT;
        break;
      case "opencode":
        file = "opencode";
        args = buildOpenCodeArgs(session);
        stdinData = PROMPT;
        break;
      case "grok": file = "grok"; args = buildGrokArgs(session, PROMPT); break;
      case "qoder": file = "qodercli"; args = buildQoderArgs(session, PROMPT); break;
      case "pi": file = "pi"; args = buildPiArgs(session, PROMPT); break;
      default: throw new Error("Unknown provider");
    }
    const child = spawn(file, args, {
      cwd: root,
      env: process.env,
      stdio: [stdinData === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdinFailed = false;
    child.stdin?.on("error", () => { stdinFailed = true; child.kill("SIGTERM"); });
    if (stdinData !== undefined) child.stdin?.end(stdinData);
    let stdout = "";
    let stderrBytes = 0;
    let exceeded = false;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length + chunk.length <= MAX_STREAM) stdout += chunk;
      else { exceeded = true; child.kill("SIGTERM"); }
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, TIMEOUT_MS);
    const killTimer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS + 3_000);
    let spawnError = false;
    child.once("error", () => { spawnError = true; });
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    clearTimeout(killTimer);
    const ids = new Map<string, string>();
    const events: unknown[] = [];
    let nonJsonLines = 0;
    const failureCategories = new Set<string>();
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.subtype === "api_retry" || parsed.type === "error" || (parsed.type === "result" && parsed.is_error === true)) {
          const diagnostic = JSON.stringify(parsed).toLowerCase();
          for (const [label, pattern] of [
            ["unauthorized", /\b401\b|unauthorized|authentication failed|invalid api key/],
            ["forbidden", /\b403\b|forbidden/],
            ["rate-limited", /\b429\b|rate limit|quota|insufficient credit/],
            ["server-error", /\b50[0-9]\b|overloaded/],
            ["network-error", /timeout|econn|network error|fetch failed|connection refused/],
            ["model-unavailable", /model.*(?:unavailable|unknown|not found|invalid)|not found.*model/],
            ["account-limited", /billing|subscription|credits|upgrade plan|not enabled/],
          ] as const) {
            if (pattern.test(diagnostic)) failureCategories.add(label);
          }
        }
        if (provider === "pi" && (parsed.type === "message_start" || parsed.type === "message_end")
          && (parsed.message as Record<string, unknown> | undefined)?.role !== "assistant") continue;
        if (provider === "pi" && parsed.type === "agent_end" && Array.isArray(parsed.messages)) {
          parsed.messages = parsed.messages.filter((msg) => (msg as Record<string, unknown>)?.role === "assistant");
        }
        events.push(sanitizedEvent(parsed, ids));
      } catch { nonJsonLines++; }
    }
    // Exit 0 alone is not enough: some CLIs finish with informational events
    // or label a failed result "success" while setting is_error=true.
    const terminal = events.some((item) => {
      const event = item as Record<string, unknown>;
      if (event.is_error === true || event.type === "error") return false;
      if (provider === "claude" || provider === "qoder") return event.type === "result" && event.subtype === "success";
      if (provider === "codex") return event.type === "turn.completed";
      if (provider === "opencode") return event.type === "step_finish";
      if (provider === "grok") return event.type === "end";
      return event.type === "agent_end";
    });
    const hasFailure = events.some((item) => (item as Record<string, unknown>)?.is_error === true
      || (item as Record<string, unknown>)?.type === "error");
    // Only successful protocol runs become normal fixtures. No raw error,
    // stdout or stderr leaves this process, including on a failed attempt.
    const valid = !spawnError && !stdinFailed && !exceeded && exit.code === 0 && terminal && !hasFailure;
    if (valid) {
      mkdirSync(OUT, { recursive: true });
      const safeArgs = args.map((arg) => arg === PROMPT ? "<FIXTURE_PROMPT>" : arg);
      const fixture = { provider, scenario: "normal", args: safeArgs, stdinData: stdinData ? "<FIXTURE_PROMPT>" : null,
        events, nonJsonLines, stderrPresent: stderrBytes > 0, exitCode: exit.code, signal: exit.signal };
      writeFileSync(path.join(OUT, `${provider}-normal.json`), JSON.stringify(fixture, null, 2) + "\n", { mode: 0o600 });
    }
    console.log(`${provider}: ${valid ? `captured ${events.length} redacted events` :
      `blocked (exit=${exit.code === null ? "none" : exit.code}, signal=${exit.signal ?? "none"}, parsed=${events.length}, terminal=${terminal}, errorEvent=${hasFailure}, stderr=${stderrBytes > 0}, timedOut=${timedOut}, tooLarge=${exceeded})`}`);
    if (!valid) console.log(`${provider} failure categories: ${Array.from(failureCategories).join(",") || "undetermined"}`);
    if (!valid) {
      const resultEvent = [...events].reverse().find((item) => (item as Record<string, unknown>)?.type === "result") as Record<string, unknown> | undefined;
      if (resultEvent) console.log(`${provider} terminal event: ${JSON.stringify({ subtype: resultEvent.subtype, is_error: resultEvent.is_error, hasResult: resultEvent.result !== undefined, hasErrors: resultEvent.errors !== undefined })}`);
    }
    if (!valid) console.log(`${provider} sanitized event kinds: ${JSON.stringify(events.slice(0, 20).map((item) => {
      const event = item as Record<string, unknown>;
      return { type: event.type, subtype: event.subtype, status: event.status };
    }))}`);
    return valid;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

let ok = true;
for (const provider of ONLY ? [ONLY] : ["codex", "opencode", "qoder", "pi"]) {
  if (!await record(provider)) ok = false;
}
if (!ok) process.exitCode = 1;
