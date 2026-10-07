import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  callConfiguredAiText, generateCommitMessageOnly, QuickCommitError, runTagHead,
} from "../src/git-quick-commit.js";
import { optimizePrompt } from "../src/prompt-optimizer.js";
import { generateSessionTopic } from "../src/session-topic.js";
import { generateSiliconEmployeeDraft } from "../src/silicon-employee-draft.js";
import { generateWandTaskTitle } from "../src/task-title.js";
import type { AiCliCandidate, SessionProvider } from "../src/types.js";

const FAILURE = "test quota exhausted";
const REQUEST = { system: "Only return text.", prompt: "Check fallback." };
const SUCCESS = "备用完成";

function piText(text: string, stopReason = "stop"): object {
  return {
    type: "message_end",
    message: {
      role: "assistant", stopReason,
      ...(stopReason === "error" ? { errorMessage: FAILURE } : {}),
      content: [{ type: "text", text }],
    },
  };
}

function textEvents(provider: SessionProvider, text: string): object[] {
  switch (provider) {
    case "codex": return [{ type: "item.completed", item: { type: "agent_message", text } }];
    case "opencode": return [{ type: "text", part: { text } }];
    case "grok": return [{ type: "text", data: text }];
    case "qoder": return [{ type: "result", subtype: "success", result: text }];
    case "gemini": return [{ type: "message", role: "assistant", content: text }];
    default: return [piText(text)];
  }
}

async function withCliOutputs(
  outputs: Record<string, object[]>,
  run: (root: string, attempts: () => string[]) => Promise<void>,
  delays: Record<string, number> = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wand-system-ai-protocol-"));
  const bin = join(root, "bin");
  const marker = join(root, "attempts");
  mkdirSync(bin);
  for (const command of ["codex", "opencode", "grok", "qodercli", "pi", "gemini"]) {
    writeFileSync(join(bin, command), `#!${process.execPath}\n` + [
      'const fs = require("node:fs");',
      'const args = process.argv.slice(2);',
      'const model = args[args.indexOf("--model") + 1];',
      `fs.appendFileSync(${JSON.stringify(marker)}, model + "\\n");`,
      `const outputs = ${JSON.stringify(outputs)};`,
      'process.stdin.resume();',
      'process.stdin.on("end", () => {',
      `  setTimeout(() => { for (const event of outputs[model] || []) console.log(JSON.stringify(event)); }, (${JSON.stringify(delays)})[model] || 0);`,
      '});',
    ].join("\n"), { mode: 0o755 });
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  try {
    await run(root, () => readFileSync(marker, "utf8").trim().split("\n"));
  } finally {
    process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
}

const failures: Array<[SessionProvider, object]> = [
  ["codex", { type: "turn.failed", error: { message: FAILURE } }],
  ["opencode", { type: "error", error: { data: { message: FAILURE } } }],
  ["grok", { type: "error", message: FAILURE }],
  ["qoder", { type: "result", subtype: "error_during_execution", is_error: true, errors: [FAILURE] }],
  ["pi", piText(FAILURE, "error")],
  ["gemini", { type: "result", status: "error", error: { message: FAILURE } }],
];

for (const [provider, failure] of failures) {
  test(`${provider}: exit 0 with a protocol failure is not successful text and falls back`, async () => {
    await withCliOutputs({
      first: [...textEvents(provider, "partial text"), failure],
      second: textEvents("pi", SUCCESS),
    }, async (root, attempts) => {
      const result = await callConfiguredAiText(REQUEST, root, "中文", {
        cliCandidates: [{ provider, model: "first" }, { provider: "pi", model: "second" }],
      });
      assert.equal(result, SUCCESS);
      assert.deepEqual(attempts(), ["first", "second"]);
      await assert.rejects(callConfiguredAiText(REQUEST, root, "中文", {
        provider, model: "first",
      }), (error: unknown) => error instanceof QuickCommitError
        && error.code === "CLAUDE_CLI_FAILED" && error.message.includes(FAILURE));
    });
  });
}

test("一次性文本选模型分组时按成员顺序尝试，分组 ID 不传给 CLI", async () => {
  await withCliOutputs({ first: [piText(FAILURE, "error")], second: [piText(SUCCESS)] }, async (root, attempts) => {
    const result = await callConfiguredAiText(REQUEST, root, "中文", {
      provider: "pi", model: "wand-model-group/pi/coding",
      modelGroups: [{ id: "coding", provider: "pi", name: "编程", models: ["first", "second"] }],
    });
    assert.equal(result, SUCCESS);
    assert.deepEqual(attempts(), ["first", "second"]);
  });
});

test("three candidates continue after both Qoder and Pi report protocol errors", async () => {
  await withCliOutputs({
    first: [{ type: "assistant", message: { content: [{ type: "text", text: FAILURE }] } }, failures[3][1]],
    second: [piText(FAILURE, "error")],
    third: [piText(SUCCESS)],
  }, async (root, attempts) => {
    const result = await callConfiguredAiText(REQUEST, root, "中文", {
      cliCandidates: [
        { provider: "qoder", model: "first" },
        { provider: "pi", model: "second" },
        { provider: "pi", model: "third" },
      ],
    });
    assert.equal(result, SUCCESS);
    assert.deepEqual(attempts(), ["first", "second", "third"]);
  });
});

test("all failed candidates retain their individual protocol errors", async () => {
  await withCliOutputs({ first: [piText(FAILURE, "error")], second: [piText(FAILURE, "error")] },
    async (root, attempts) => {
      await assert.rejects(callConfiguredAiText(REQUEST, root, "中文", {
        cliCandidates: [{ provider: "pi", model: "first" }, { provider: "pi", model: "second" }],
      }), (error: unknown) => error instanceof QuickCommitError
        && error.code === "AI_FALLBACK_FAILED"
        && error.message.split(FAILURE).length === 3);
      assert.deepEqual(attempts(), ["first", "second"]);
    });
});

test("warnings and a successful terminal result after an internal retry do not fail the candidate", async () => {
  await withCliOutputs({
    pi: [piText(FAILURE, "error"), piText(SUCCESS)],
    codex: [failures[0][1], ...textEvents("codex", SUCCESS), { type: "turn.completed" }],
    qoder: [failures[3][1], ...textEvents("qoder", SUCCESS)],
    gemini: [{ type: "error", severity: "warning", message: "warning" },
      ...textEvents("gemini", SUCCESS), { type: "result", status: "success" }],
  }, async (root) => {
    for (const provider of ["pi", "codex", "qoder", "gemini"] as const) {
      assert.equal(await callConfiguredAiText(REQUEST, root, "中文", { provider, model: provider }), SUCCESS);
    }
  });
});

const CHAIN: AiCliCandidate[] = [
  { provider: "pi", model: "first" }, { provider: "pi", model: "second" },
];

test("output validation keeps the original error for a single candidate", async () => {
  await withCliOutputs({ first: [piText("not JSON")] }, async (root) => {
    await assert.rejects(generateSessionTopic(["修复登录错误提示"], root, "中文", {
      provider: "pi", model: "first",
    }), (error: unknown) => error instanceof Error
      && error.message === "模型返回的会话主题格式无效。"
      && !(error instanceof QuickCommitError));
  });
});

test("a later attempt is bounded by the remaining chain budget", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await withCliOutputs({ first: [piText("not JSON")], second: [piText(SUCCESS)] },
    async (root) => {
      await assert.rejects(callConfiguredAiText(REQUEST, root, "中文", { cliCandidates: CHAIN }, (raw) => {
        if (raw === "not JSON") {
          t.mock.timers.tick(149_980);
          throw new Error("invalid output");
        }
        return raw;
      }), (error: unknown) => error instanceof QuickCommitError
        && error.code === "AI_FALLBACK_FAILED" && error.message.includes("调用超时"));
    }, { second: 100 });
});

function initRepo(root: string): void {
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  };
  git("init", "-q");
  git("config", "user.email", "wand-test@example.test");
  git("config", "user.name", "Wand Test");
  writeFileSync(join(root, "tracked.txt"), "initial\n");
  git("add", "tracked.txt");
  git("commit", "-qm", "initial");
}

test("an empty parsed commit message tries the next candidate", async () => {
  await withCliOutputs({ first: [piText('{"message":""}')],
    second: [piText('{"message":"修复登录提示","tag":"v1.0.1"}')] },
  async (root, attempts) => {
    initRepo(root);
    assert.deepEqual(await generateCommitMessageOnly(root, "中文", { cliCandidates: CHAIN }), {
      message: "修复登录提示", suggestedTag: "v1.0.1",
    });
    assert.deepEqual(attempts(), ["first", "second"]);
  });
});

test("an invalid generated tag tries the next candidate", async () => {
  await withCliOutputs({ first: [piText('{"tag":"not-a-version"}')], second: [piText('{"tag":"v1.0.1"}')] },
    async (root, attempts) => {
      initRepo(root);
      const result = await runTagHead({ cwd: root, language: "中文", autoTag: true, cliCandidates: CHAIN });
      assert.equal(result.tag?.name, "v1.0.1");
      assert.deepEqual(attempts(), ["first", "second"]);
    });
});

test("a malformed session topic tries the next candidate rather than failing outside the chain", async () => {
  await withCliOutputs({ first: [piText("not JSON")],
    second: [piText('{"title":"修复登录","description":"修复登录页的错误提示"}')] },
  async (root, attempts) => {
    assert.deepEqual(await generateSessionTopic(["修复登录页错误提示"], root, "中文", {
      cliCandidates: CHAIN,
    }), { title: "修复登录", description: "修复登录页的错误提示" });
    assert.deepEqual(attempts(), ["first", "second"]);
  });
});

test("an unusable task title tries the next candidate", async () => {
  await withCliOutputs({ first: [piText("API error: quota exhausted")], second: [piText("修复登录提示")] },
    async (root, attempts) => {
      assert.equal(await generateWandTaskTitle("修复登录页错误提示", root, "中文", {
        cliCandidates: CHAIN,
      }), "修复登录提示");
      assert.deepEqual(attempts(), ["first", "second"]);
    });
});

test("an employee draft missing required fields tries the next candidate", async () => {
  await withCliOutputs({ first: [piText('{"name":"缺少角色"}')],
    second: [piText('{"name":"测试员","duty":"核对回归","prompt":"你负责验证软件。","provider":"pi"}')] },
  async (root, attempts) => {
    const draft = await generateSiliconEmployeeDraft("需要一位测试员", { cliCandidates: CHAIN }, {
      cwd: root, isProviderAvailable: () => true,
    });
    assert.equal(draft.name, "测试员");
    assert.equal(draft.agent.provider, "pi");
    assert.deepEqual(attempts(), ["first", "second"]);
  });
});

test("an empty cleaned optimized prompt tries the next candidate", async () => {
  await withCliOutputs({ first: [piText('""')], second: [piText("请修复登录页错误提示。")] },
    async (root, attempts) => {
      assert.equal(await optimizePrompt("修复登录提示", "中文", root, {
        cliCandidates: CHAIN,
      }), "请修复登录页错误提示。");
      assert.deepEqual(attempts(), ["first", "second"]);
    });
});
