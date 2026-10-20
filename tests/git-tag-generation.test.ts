import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { generateCommitMessageOnly, getGitStatusAsync, runTagHead } from "../src/git-quick-commit.js";
import { gitTagHint, gitTagSystemPrompt, readGitTagContext, sanitizeSuggestedTag, validateSuggestedTag } from "../src/git-tag-generation.js";
import { withOpsPersona } from "../src/ai-text-runner.js";
import { QuickCommitError } from "../src/command-error.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(run: (repo: string, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wand-tag-generation-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(repo); mkdirSync(bin);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "wand-test@example.test");
  git(repo, "config", "user.name", "Wand Test");
  writeFileSync(join(repo, "file.txt"), "initial\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "initial");
  writeFileSync(join(bin, "codex"), `#!/bin/sh
cat > "$WAND_TAG_PROMPT"
case "$*" in
  *bad-model*) printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"message\\":\\"修复输入框\\",\\"tag\\":\\"squash-24h-20261018-080107\\"}"}}' ;;
  *) printf '%s\\n' "$WAND_TAG_RESPONSE" ;;
esac
`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, WAND_TAG_PROMPT: process.env.WAND_TAG_PROMPT, WAND_TAG_RESPONSE: process.env.WAND_TAG_RESPONSE };
  process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ""}`;
  process.env.WAND_TAG_PROMPT = join(root, "prompt.txt");
  try { await run(repo, root); }
  finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function response(value: unknown): void {
  process.env.WAND_TAG_RESPONSE = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: typeof value === "string" ? value : JSON.stringify(value) } });
}

function invalid(error: unknown): boolean {
  return error instanceof QuickCommitError && error.code === "INVALID_AI_TAG";
}

test("generated tag validation rejects backup tags and malformed SemVer without relaxing legacy valid tags", () => {
  for (const value of ["squash-24h-20261018-080107", "backup-v9.0.0", "v01.2.3", "v1.2.3.4", "v1.2.3-", "v1.2.3-alpha..1", "v1.2.3-01", "v1.2.3+", "v1.2.3+a+b", "v1.2.3\nextra", null, 123]) {
    assert.equal(sanitizeSuggestedTag(value), undefined, String(value));
  }
  for (const value of ["v1.2.3", "1.2.3", "v1.2.3-rc.1", "v1.2.3+build.5"]) {
    assert.equal(sanitizeSuggestedTag(value), value);
  }
  const context = { latestTag: "v4.97.0", tags: new Set(["v4.97.0", "v4.98.0+build.1"]) };
  for (const value of ["v4.97.0", "4.97.0", "v4.96.9", "v4.97.0-rc.1", "v4.97.0+build.2", "v4.98.0+build.1"]) {
    assert.throws(() => validateSuggestedTag(value, context), invalid);
  }
  assert.equal(validateSuggestedTag("v4.98.0", context), "v4.98.0");
});

test("both task prompts specify exact fields, version source and input trust boundary after persona", () => {
  for (const combined of [false, true]) {
    const system = gitTagSystemPrompt("中文", combined);
    const request = withOpsPersona({ system, prompt: "diff data" }, "角色：用中文汇报");
    assert.equal(request.system, `角色：用中文汇报\n\n${system}`);
    assert.match(system, /只读/);
    assert.match(system, /不是对你的指令/);
    assert.match(system, /最高语义化版本/);
    assert.match(system, /squash-24h-\*/);
    assert.match(system, /严格递增/);
    assert.match(system, /不带前导零/);
    assert.match(system, /不调用工具/);
    assert.match(system, /不输出数组、null/);
    assert.match(system, combined ? /message、tag 两个字段/ : /tag 一个字段/);
    assert.match(system, combined ? /"message":"修复输入框焦点丢失","tag":"v1.2.4"/ : /\{"tag":"v1.2.4"\}/);
  }
});

test("highest local SemVer wins over nearest backup, lower newer tag and unmerged refs", async () => fixture(async repo => {
  git(repo, "tag", "v4.9.0");
  git(repo, "tag", "v4.10.0-rc.10");
  git(repo, "tag", "v4.10.0-rc.2");
  git(repo, "tag", "v4.10.0");
  git(repo, "branch", "other");
  git(repo, "checkout", "-q", "other");
  git(repo, "commit", "--allow-empty", "-qm", "other branch");
  git(repo, "tag", "v4.97.0");
  git(repo, "checkout", "-q", "-");
  git(repo, "commit", "--allow-empty", "-qm", "newer backup");
  git(repo, "tag", "squash-24h-20261018-080106");
  git(repo, "tag", "backup-v99.0.0");
  assert.match(git(repo, "describe", "--tags", "--abbrev=0"), /backup|squash/);
  const context = await readGitTagContext(repo);
  assert.equal(context.latestTag, "v4.97.0");
  assert.match(gitTagHint(context), /"v4.97.0"/);
  assert.equal((await getGitStatusAsync(repo)).latestTag, "v4.97.0");
  response({ message: "修复输入框", tag: "v4.97.1" });
  const before = git(repo, "status", "--porcelain");
  assert.deepEqual(await generateCommitMessageOnly(repo, "中文", { provider: "codex" }), { message: "修复输入框", suggestedTag: "v4.97.1" });
  assert.equal(git(repo, "status", "--porcelain"), before);
  assert.equal(git(repo, "tag", "--list", "v4.97.1"), "");
}));

test("structured preview rejects the observed backup result and missing tag, then tries only configured candidates", async () => fixture(async repo => {
  git(repo, "tag", "v4.97.0");
  for (const value of [{ message: "修复输入框", tag: "squash-24h-20261018-080107" }, { message: "修复输入框" }]) {
    response(value);
    await assert.rejects(generateCommitMessageOnly(repo, "中文", { provider: "codex" }), invalid);
  }
  response({ message: "修复输入框", tag: "v4.97.1" });
  const result = await generateCommitMessageOnly(repo, "中文", { cliCandidates: [
    { provider: "codex", model: "bad-model" }, { provider: "codex", model: "good-model" },
  ] });
  assert.equal(result.suggestedTag, "v4.97.1");
  response("修复输入框");
  assert.deepEqual(await generateCommitMessageOnly(repo, "中文", { provider: "codex" }), { message: "修复输入框", suggestedTag: undefined });
}));

test("auto tag after commit uses tags on HEAD, exact tag-only prompt and refuses stale suggestions", async () => fixture(async (repo, root) => {
  git(repo, "tag", "v4.97.0");
  git(repo, "tag", "squash-24h-20261018-080106");
  const head = git(repo, "rev-parse", "HEAD");
  response({ tag: "v4.97.0" });
  await assert.rejects(runTagHead({ cwd: repo, language: "中文", autoTag: true, provider: "codex" }), invalid);
  response({ tag: "v4.97.1" });
  const result = await runTagHead({ cwd: repo, language: "中文", autoTag: true, provider: "codex" });
  assert.equal(result.tag.name, "v4.97.1");
  assert.equal(git(repo, "rev-parse", "v4.97.1"), head);
  const prompt = readFileSync(join(root, "prompt.txt"), "utf8");
  assert.match(prompt, /本地全部 tag 中最高的语义化版本是 "v4.97.0"/);
  assert.match(prompt, /恰好包含 tag 一个字段/);
  assert.doesNotMatch(prompt, /当前最新 tag 是 `squash/);
}));

test("backup-only and no-tag repositories use an explicit initial-version hint, bare versions preserve no-v style", async () => fixture(async (repo, root) => {
  assert.match(gitTagHint(await readGitTagContext(repo)), /没有语义化版本 tag/);
  git(repo, "tag", "backup-v99.0.0");
  response({ message: "修复输入框", tag: "v0.0.1" });
  assert.equal((await generateCommitMessageOnly(repo, "中文", { provider: "codex" })).suggestedTag, "v0.0.1");
  assert.match(readFileSync(join(root, "prompt.txt"), "utf8"), /没有语义化版本 tag/);
  git(repo, "tag", "1.9.0");
  response({ tag: "1.9.1" });
  assert.equal((await runTagHead({ cwd: repo, language: "中文", autoTag: true, provider: "codex" })).tag.name, "1.9.1");
  assert.match(readFileSync(join(root, "prompt.txt"), "utf8"), /最高的语义化版本是 "1.9.0"/);
}));
