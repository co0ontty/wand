import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_PROVIDERS,
  inferProviderFromCommand,
  inferProviderFromRunner,
  isNativeThinkingEffort,
  isSessionProvider,
  normalizeProviderId,
  providerCliCommand,
  providerDisplayName,
} from "../src/provider-catalog.js";

test("provider 真源是唯一的一份列表，且守卫只接受字面量", () => {
  assert.deepEqual([...SESSION_PROVIDERS], ["claude", "codex", "opencode", "grok", "qoder", "pi", "gemini"]);
  for (const provider of SESSION_PROVIDERS) assert.equal(isSessionProvider(provider), true);
  // 别名 / 大小写 / 空白都不算合法字面量。
  assert.equal(isSessionProvider("anthropic"), false);
  assert.equal(isSessionProvider("Claude"), false);
  assert.equal(isSessionProvider(" claude"), false);
  assert.equal(isSessionProvider(""), false);
  assert.equal(isSessionProvider(undefined), false);
});

test("normalizeProviderId 接受别名与历史 runner 值，拒绝未知名字", () => {
  assert.equal(normalizeProviderId("anthropic"), "claude");
  assert.equal(normalizeProviderId("open-code"), "opencode");
  assert.equal(normalizeProviderId("open_code"), "opencode");
  assert.equal(normalizeProviderId("qodercli"), "qoder");
  assert.equal(normalizeProviderId("claude-sdk"), "claude", "历史 runner 值仍要能识别");
  assert.equal(normalizeProviderId("CODEX"), "codex", "大小写归一");
  assert.equal(normalizeProviderId(" custom-agent "), null);
  assert.equal(normalizeProviderId(undefined), null);
});

test("inferProviderFromRunner 只认识与 provider 相关的 runner", () => {
  assert.equal(inferProviderFromRunner("claude-cli-print"), "claude");
  assert.equal(inferProviderFromRunner("codex-cli-exec"), "codex");
  assert.equal(inferProviderFromRunner("gemini-cli-json"), "gemini");
  assert.equal(inferProviderFromRunner("pty"), undefined, "pty 与 provider 无关");
  assert.equal(inferProviderFromRunner(undefined), undefined);
});

test("inferProviderFromCommand 从可执行名推断，参数与父目录不能冒充 provider", () => {
  assert.equal(inferProviderFromCommand("claude"), "claude");
  assert.equal(inferProviderFromCommand("/opt/homebrew/bin/claude --resume abc"), "claude");
  assert.equal(inferProviderFromCommand("claude -p codex"), "claude", "参数里的 codex 不能冒充");
  assert.equal(inferProviderFromCommand("/tmp/opencode-tools/bin/claude --resume abc"), "claude", "父目录不能冒充");
  assert.equal(inferProviderFromCommand("open-code run"), "opencode");
  assert.equal(inferProviderFromCommand("qodercli --print"), "qoder");
  assert.equal(inferProviderFromCommand("gemini -p '' --output-format stream-json"), "gemini");
  assert.equal(inferProviderFromCommand("/usr/local/bin/codex.cmd"), "codex", "Windows 后缀要去掉");
  assert.equal(inferProviderFromCommand("node script.js"), undefined);
  assert.equal(inferProviderFromCommand("bash -lc claude"), undefined, "shell 包装不能冒充");
  assert.equal(inferProviderFromCommand(""), undefined);
  assert.equal(inferProviderFromCommand(undefined), undefined);
});

test("inferProviderFromCommand 能穿过包管理器前缀", () => {
  assert.equal(inferProviderFromCommand("npx claude"), "claude");
  assert.equal(inferProviderFromCommand("npx -y claude"), "claude");
  assert.equal(inferProviderFromCommand("pnpm dlx codex"), "codex");
  assert.equal(inferProviderFromCommand("yarn dlx gemini"), "gemini");
});

test("providerCliCommand 把 qoder 换成真实可执行文件 qodercli", () => {
  assert.equal(providerCliCommand("qoder"), "qodercli");
  assert.equal(providerCliCommand("claude"), "claude");
});

test("providerDisplayName 归一别名，terminal 有独立文案，未知名字原样回退", () => {
  assert.equal(providerDisplayName("anthropic"), "Claude");
  assert.equal(providerDisplayName("open-code"), "OpenCode");
  assert.equal(providerDisplayName("terminal"), "终端");
  assert.equal(providerDisplayName("custom-agent"), "custom-agent");
  assert.equal(providerDisplayName(""), "AI");
});

test("原生思考档位只认有档位开关的 provider，gemini 不算", () => {
  assert.equal(isNativeThinkingEffort("codex:ultra"), true);
  assert.equal(isNativeThinkingEffort("claude:xhigh"), true);
  assert.equal(isNativeThinkingEffort("gemini:max"), false, "gemini 没有思考档位开关");
  assert.equal(isNativeThinkingEffort("codex:not valid"), false);
  assert.equal(isNativeThinkingEffort("off"), false, "旧四档不是 provider:level 形状");
  assert.equal(isNativeThinkingEffort(undefined), false);
});
