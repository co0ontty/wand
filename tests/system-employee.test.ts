import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import express from "express";

import { defaultConfig, loadConfigWithStorage } from "../src/config.js";
import { jsonErrorHandler } from "../src/express-async.js";
import { callConfiguredAiText, withOpsPersona } from "../src/git-quick-commit.js";
import { registerSiliconEmployeeRoutes } from "../src/server-employee-routes.js";
import { resolveSystemAiContext } from "../src/session-ai-context.js";
import {
  SYSTEM_EMPLOYEE_KEY,
  SYSTEM_EMPLOYEE_NAME,
  SYSTEM_EMPLOYEE_PROMPT,
  SYSTEM_EMPLOYEE_TAG,
  isSystemSiliconEmployee,
  systemEmployeeCliCandidates,
  systemEmployeeSeedAgents,
} from "../src/system-employee.js";
import { WandStorage } from "../src/storage.js";
import type { SessionSnapshot } from "../src/types.js";

const CLAUDE = { provider: "claude", model: "default", thinkingEffort: "off", mode: "default", kind: "structured" } as const;
const GROK = { provider: "grok", model: "grok-4.5", thinkingEffort: "off", mode: "default", kind: "structured" } as const;

const config = {
  defaultModel: "claude-sonnet-4-6",
  defaultCodexModel: "gpt-5.5-codex",
  defaultOpenCodeModel: "anthropic/claude-sonnet-4-6",
  defaultGrokModel: "grok-4.5",
  defaultQoderModel: "performance",
  defaultPiModel: "anthropic/claude-sonnet-4-6",
  defaultGeminiModel: "gemini-2.5-pro",
  defaultThinkingEffort: "deep" as const,
  inheritEnv: true,
};

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "session-1",
    command: "claude",
    cwd: "/tmp/repo",
    mode: "managed",
    status: "idle",
    exitCode: null,
    startedAt: new Date(0).toISOString(),
    endedAt: null,
    output: "",
    archived: false,
    archivedAt: null,
    claudeSessionId: null,
    ...overrides,
  };
}

function withTempStorage(run: (storage: WandStorage, root: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "wand-system-employee-"));
    const storage = new WandStorage(join(root, "wand.db"));
    try {
      await run(storage, root);
    } finally {
      storage.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** 用临时 PATH 精确控制哪个 CLI「已安装」。 */
async function withPath(bin: string, run: () => void | Promise<void>): Promise<void> {
  const previous = process.env.PATH;
  process.env.PATH = bin;
  try {
    await run();
  } finally {
    process.env.PATH = previous;
  }
}

/**
 * 假 CLI 用 Node 自身做解释器：不依赖 PATH 上的 cat/printf，测试就能把 PATH
 * 收缩到只含受控目录来断言「哪个工具算已安装」。
 */
function fakeCli(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
}

function captureStdin(path: string): string {
  return `let input = ""; process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => { require("node:fs").writeFileSync(${JSON.stringify(path)}, input); });`;
}

test("内置员工：首次按已有系统 AI 工具落候选，之后幂等且只补锁定字段", withTempStorage((storage) => {
  const seeded = storage.ensureSystemSiliconEmployee({ cli: "grok", model: "grok-4.5", provider: "claude" });
  assert.equal(seeded.name, SYSTEM_EMPLOYEE_NAME);
  assert.equal(seeded.duty, systemEmployeeSeedAgents().length ? seeded.duty : seeded.duty);
  assert.equal(seeded.prompt, SYSTEM_EMPLOYEE_PROMPT);
  assert.equal(seeded.systemKey, SYSTEM_EMPLOYEE_KEY);
  assert.ok(isSystemSiliconEmployee(seeded));
  assert.deepEqual(seeded.agents.map((agent) => [agent.provider, agent.model]), [["grok", "grok-4.5"]]);

  // 再跑一次：不重复建行、没动候选。
  storage.saveSiliconEmployee({ ...seeded, agents: [GROK, CLAUDE], updatedAt: "2026-09-30T00:00:00.000Z" });
  const again = storage.ensureSystemSiliconEmployee({ cli: "claude", provider: "codex" });
  assert.equal(again.id, seeded.id);
  assert.deepEqual(again.agents.map((agent) => agent.provider), ["grok", "claude"]);
  assert.equal(storage.listSiliconEmployees().length, 1);

  // 名字/人设被外部改坏、或被人为归档：下次加载时恢复锁定值并保持可见。
  storage.saveSiliconEmployee({ ...again, name: "被改过的名字", prompt: "", archivedAt: "2026-09-30T00:00:00.000Z" });
  const repaired = storage.ensureSystemSiliconEmployee();
  assert.equal(repaired.name, SYSTEM_EMPLOYEE_NAME);
  assert.equal(repaired.prompt, SYSTEM_EMPLOYEE_PROMPT);
  assert.equal(repaired.archivedAt, undefined);
  assert.deepEqual(repaired.agents.map((agent) => agent.provider), ["grok", "claude"]);
}));

test("内置员工：候选缺省跟随默认 provider，列表永远排在最前", withTempStorage((storage) => {
  assert.deepEqual(systemEmployeeSeedAgents({ provider: "codex" }).map((agent) => [agent.provider, agent.model]), [["codex", "default"]]);
  assert.deepEqual(systemEmployeeSeedAgents({}).map((agent) => agent.provider), ["claude"]);
  // 空 shell 的模型串不能变成空模型 ID。
  assert.deepEqual(systemEmployeeSeedAgents({ cli: "pi", model: "   " }).map((agent) => agent.model), ["default"]);

  storage.ensureSystemSiliconEmployee();
  storage.saveSiliconEmployee({
    id: "e_user", name: "用户员工", duty: "", prompt: "", avatar: "", agents: [CLAUDE],
    createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z",
  });
  assert.deepEqual(storage.listSiliconEmployees().map((employee) => employee.id), ["e_wand_ops", "e_user"]);
  assert.equal(storage.getSystemSiliconEmployee()?.name, SYSTEM_EMPLOYEE_NAME);
}));

test("系统运维员工只有执行候选可改：改名/归档/删除都被拒", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wand-system-employee-routes-"));
  const storage = new WandStorage(join(root, "wand.db"));
  const changed: string[] = [];
  const app = express();
  app.use(express.json());
  registerSiliconEmployeeRoutes(app, { storage, notifyEmployeeChanged: (id) => changed.push(id) });
  app.use(jsonErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  const seeded = storage.ensureSystemSiliconEmployee({ provider: "claude" });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) as Record<string, unknown> | null };
  };

  const listed = await call("GET", "/api/silicon-employees");
  assert.equal(listed.status, 200);
  assert.equal((listed.json?.employees as Array<{ name: string }>)[0]?.name, SYSTEM_EMPLOYEE_NAME);

  const renamed = await call("PUT", `/api/silicon-employees/${seeded.id}`, { ...seeded, name: "别改我" });
  assert.equal(renamed.status, 400);
  assert.match(String(renamed.json?.error), /内置/);
  assert.equal(storage.getSiliconEmployee(seeded.id)?.name, SYSTEM_EMPLOYEE_NAME);

  const patched = await call("PUT", `/api/silicon-employees/${seeded.id}`, { agents: [GROK, CLAUDE] });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assert.deepEqual((patched.json?.agents as Array<{ provider: string }>).map((agent) => agent.provider), ["grok", "claude"]);
  // 锁定字段仍按服务端定义返回，改名请求不会漏出去。
  assert.equal(patched.json?.name, SYSTEM_EMPLOYEE_NAME);
  assert.equal(patched.json?.prompt, SYSTEM_EMPLOYEE_PROMPT);
  assert.deepEqual(changed, [seeded.id]);

  const duplicated = await call("PUT", `/api/silicon-employees/${seeded.id}`, { agents: [CLAUDE, { ...CLAUDE }] });
  assert.equal(duplicated.status, 400);
  assert.match(String(duplicated.json?.error), /重复/);

  const empty = await call("PUT", `/api/silicon-employees/${seeded.id}`, { agents: [] });
  assert.equal(empty.status, 400);

  for (const [method, path] of [["POST", "archive"], ["POST", "unarchive"], ["DELETE", ""]] as const) {
    const action = await call(method, `/api/silicon-employees/${seeded.id}${path ? `/${path}` : ""}`);
    assert.equal(action.status, 400, `${method} ${path}`);
    assert.match(String(action.json?.error), /不能/);
  }
  assert.equal(storage.getSiliconEmployee(seeded.id)?.archivedAt, undefined);
});

test("候选链：空模型跟随 provider 默认，PTY 候选与内部 AI 调用无关", () => {
  const chain = systemEmployeeCliCandidates({
    agents: [CLAUDE, GROK, { ...CLAUDE, provider: "codex", model: "  ", kind: "pty" }],
  });
  assert.deepEqual(chain, [
    { provider: "claude", model: undefined, thinkingEffort: "off" },
    { provider: "grok", model: "grok-4.5", thinkingEffort: "off" },
  ]);
  assert.deepEqual(systemEmployeeCliCandidates(null), []);
});

test("系统 AI：CLI 模式按候选链取首个已安装工具，并带上运维人设", async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-system-employee-chain-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  fakeCli(bin, "grok", "process.exit(0);");
  try {
    const employee = { ...storageEmployee(), agents: [CLAUDE, GROK] };
    await withPath(bin, () => {
      // 只有 grok 在 PATH 上：链首的 claude 被跳过，但仍保留整条链做运行期降级。
      const context = resolveSystemAiContext(session(), { ...config }, employee);
      assert.equal(context.provider, "grok");
      assert.equal(context.model, "grok-4.5");
      assert.equal(context.opsPersona, SYSTEM_EMPLOYEE_PROMPT);
      assert.deepEqual(context.cliCandidates, [
        { provider: "claude", model: "claude-sonnet-4-6", thinkingEffort: "off" },
        { provider: "grok", model: "grok-4.5", thinkingEffort: "off" },
      ]);

      // 直接沿用同一份上下文时，provider/model/effort 也来自首选候选。
      const viaEmployee = resolveSystemAiContext(session(), { ...config }, employee);
      assert.equal(viaEmployee.provider, "grok");
      assert.equal(viaEmployee.cliCandidates?.length, 2);

      // 没有内置员工时退回旧的 systemAiCli 行为。
      const legacy = resolveSystemAiContext(session(), { ...config, systemAiCli: "pi", systemAiModel: "" }, null);
      assert.equal(legacy.provider, "pi");
      assert.equal(legacy.opsPersona, undefined);
      assert.equal(legacy.cliCandidates, undefined);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function storageEmployee() {
  return {
    id: "e_wand_ops",
    name: SYSTEM_EMPLOYEE_NAME,
    duty: "运维",
    prompt: SYSTEM_EMPLOYEE_PROMPT,
    avatar: "",
    agents: [CLAUDE],
    systemKey: SYSTEM_EMPLOYEE_KEY,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
  };
}

test("角色设定只做前缀，任务自己的输出格式仍排在后面", () => {
  const merged = withOpsPersona({ system: "只输出一行 JSON。", prompt: "x" }, SYSTEM_EMPLOYEE_PROMPT);
  assert.equal(merged.system, `${SYSTEM_EMPLOYEE_PROMPT}\n\n只输出一行 JSON。`);
  assert.equal(merged.prompt, "x");
  assert.deepEqual(withOpsPersona({ system: "规则", prompt: "x" }, "   "), { system: "规则", prompt: "x" });
  assert.equal(withOpsPersona({ prompt: "x" }, "人设").system, "人设");
});

test("CLI 降级链：跳过未安装的候选，失败后换下一个，人设随系统提示下发", async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-system-employee-fallback-"));
  const bin = join(root, "bin");
  const codexPromptFile = join(root, "codex-prompt");
  mkdirSync(bin);
  // codex 收到的 stdin 会被完整记录下来（它没有独立的系统提示开关，人设与规则都并进内容）。
  fakeCli(bin, "codex", [
    captureStdin(codexPromptFile),
    `process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fix: 由运维生成" } }) + "\\n"); });`,
  ].join(" "));
  // grok 在 PATH 上但一定失败：链上已安装的候选必须真的被试过一次。
  fakeCli(bin, "grok", "process.exit(1);");
  try {
    await withPath(bin, async () => {
      const text = await callConfiguredAiText(
        { system: "只输出一行 commit message。", prompt: "diff: 一坨改动" },
        root,
        "中文",
        {
          opsPersona: SYSTEM_EMPLOYEE_PROMPT,
          cliCandidates: [
            { provider: "grok", model: "grok-4.5", thinkingEffort: "off" },
            // pi 不在 PATH 上：候选被跳过，不会起进程。
            { provider: "pi", model: undefined, thinkingEffort: "off" },
            { provider: "codex", model: undefined, thinkingEffort: "off" },
          ],
        },
      );
      assert.equal(text, "fix: 由运维生成");
      const stdin = readFileSync(codexPromptFile, "utf8");
      const personaAt = stdin.indexOf(SYSTEM_EMPLOYEE_PROMPT);
      const ruleAt = stdin.indexOf("只输出一行 commit message。");
      const promptAt = stdin.indexOf("diff: 一坨改动");
      assert.ok(personaAt >= 0, `人设必须在发给 CLI 的内容里：${stdin.slice(0, 120)}`);
      assert.ok(personaAt < ruleAt && ruleAt < promptAt, `人设 / 任务规则 / 正文顺序错了：${stdin.slice(0, 120)}`);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI 降级链：单条候选保持原行为，错误不被摘要吞掉", async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-system-employee-single-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  fakeCli(bin, "codex", [
    `process.stdin.resume();`,
    `process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "chore: 单条候选" } }) + "\\n"); });`,
  ].join(" "));
  fakeCli(bin, "grok", "process.stderr.write('boom\\n'); process.exit(1);");
  try {
    await withPath(bin, async () => {
      const text = await callConfiguredAiText({ system: "s", prompt: "p" }, root, "中文", {
        provider: "codex",
        cliCandidates: [{ provider: "codex", model: undefined, thinkingEffort: "off" }],
      });
      assert.equal(text, "chore: 单条候选");

      // 只有一条候选时不切换、不改写错误码；也没有候选链时沿用 provider/model。
      fakeCli(bin, "codex", "process.exit(1);");
      await assert.rejects(
        callConfiguredAiText({ system: "s", prompt: "p" }, root, "中文", {
          provider: "codex",
          cliCandidates: [{ provider: "codex", model: undefined, thinkingEffort: "off" }],
        }),
        (error: unknown) => (error as { code?: string }).code === "CLAUDE_CLI_FAILED",
      );
      await assert.rejects(
        callConfiguredAiText({ system: "s", prompt: "p" }, root, "中文", { provider: "grok" }),
        (error: unknown) => (error as { code?: string }).code === "CLAUDE_CLI_FAILED",
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("加载配置时幂等创建内置员工，并沿用用户已有的系统 AI 工具", async () => {
  const root = mkdtempSync(join(tmpdir(), "wand-system-employee-config-"));
  const storage = new WandStorage(join(root, "wand.db"));
  try {
    // 老安装里配过「系统 AI 专用工具」：首条候选要接过来，不能悄悄换成默认 provider。
    storage.setPreference("pref:systemAiCli", "grok");
    storage.setPreference("pref:systemAiModel", "grok-4.5");
    const config = await loadConfigWithStorage(join(root, "config.json"), storage);
    assert.equal(config.systemAiCli, "grok");

    const seeded = storage.getSystemSiliconEmployee();
    assert.equal(seeded?.name, SYSTEM_EMPLOYEE_NAME);
    assert.equal(seeded?.systemKey, SYSTEM_EMPLOYEE_KEY);
    assert.deepEqual(seeded?.agents.map((agent) => [agent.provider, agent.model]), [["grok", "grok-4.5"]]);

    // 再加载一次不会多出第二行，也不会覆盖用户改过的候选顺序。
    storage.saveSiliconEmployee({ ...seeded!, agents: [CLAUDE, GROK] });
    await loadConfigWithStorage(join(root, "config.json"), storage);
    assert.deepEqual(storage.listSiliconEmployees().map((employee) => employee.id), ["e_wand_ops"]);
    assert.deepEqual(storage.getSystemSiliconEmployee()?.agents.map((agent) => agent.provider), ["claude", "grok"]);
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Tag 常量固定为系统运维", () => {
  assert.equal(SYSTEM_EMPLOYEE_TAG, "系统运维");
  assert.equal(defaultConfig().defaultProvider, "claude");
});
