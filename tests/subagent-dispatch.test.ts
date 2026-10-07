import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveSubagentDispatchMeta,
  subagentWorkflowLabel,
  WORKFLOW_SUBAGENT_AGENT_TYPE,
} from "../src/subagent-dispatch.js";

function toolUse(name: string, input: Record<string, unknown>, id = "call-1") {
  return { type: "tool_use", id, name, input };
}

/**
 * 判据按 pi `subagent` 工具自己的契约走：带 `action` 是管理/控制，省略 `action` 才是执行。
 * 这里逐条钉死两侧，新增派发参数或新增 action 时这份表就是回归网。
 */
test("pi 派发形态一律识别，不靠枚举参数名", () => {
  const cases: Array<{ title: string; input: Record<string, unknown>; agentType?: string; taskDescription?: string }> = [
    {
      title: "agent + task",
      input: { agent: "worker", task: "迁移侧栏" },
      agentType: "worker",
      taskDescription: "迁移侧栏",
    },
    {
      title: "workflow 脚本 + async（本次漏显示的形态）",
      input: {
        workflow: "./output/web-ui-library-migration/continuation.js",
        async: true,
        cwd: "/Users/co0ontty/Self/vibe_coding/wand",
        globalConcurrencyLimit: 3,
        output: "output/web-ui-library-migration/continuation-result.md",
        missionId: "22c8e070-16ba-4bc4-977b-6e956d42615a",
      },
      agentType: WORKFLOW_SUBAGENT_AGENT_TYPE,
      taskDescription: "continuation.js",
    },
    {
      title: "workflow: true（用同一条回复里的代码块）",
      input: { workflow: true, async: true, agent: undefined },
      agentType: WORKFLOW_SUBAGENT_AGENT_TYPE,
    },
    {
      title: "命名工作流资源",
      input: { workflow: "review", args: { task: "看一遍" } },
      agentType: WORKFLOW_SUBAGENT_AGENT_TYPE,
      taskDescription: "review",
    },
    {
      title: "并行 tasks",
      input: { tasks: [{ agent: "worker", task: "a" }, { agent: "worker", task: "b" }] },
    },
    {
      title: "串行 chain",
      input: { chain: [{ agent: "worker", task: "a" }, { parallel: [{ agent: "worker", task: "b" }] }] },
    },
    {
      title: "resume 继续已有 run",
      input: { resume: "4b3596c0-f3af-47e9-a61b-8d701b3c9d7a", task: "继续未完成的迁移" },
      taskDescription: "继续未完成的迁移",
    },
    {
      title: "mission 派发",
      input: { mission: { title: "迁移" }, task: "跑起来" },
      taskDescription: "跑起来",
    },
  ];

  for (const item of cases) {
    const meta = deriveSubagentDispatchMeta(toolUse("Pi/subagent", item.input, item.title));
    assert.ok(meta, `应识别为派发：${item.title}`);
    assert.equal(meta.taskId, item.title);
    assert.equal(meta.agentType, item.agentType, item.title);
    assert.equal(meta.taskDescription, item.taskDescription, item.title);
  }
});

test("pi 管理/控制调用一律不进子 Agent 面板", () => {
  const actions = [
    "status",
    "list",
    "capabilities",
    "validate",
    "steer",
    "resume",
    "interrupt",
    "stop",
    "guide",
    "lane.recordMerge",
    "worktree.cleanup",
    "schedule.create",
    "command.status",
    "doctor",
  ];
  for (const action of actions) {
    assert.equal(
      deriveSubagentDispatchMeta(toolUse("Pi/subagent", { action, id: "4b3596c0-f3af-47e9-a61b-8d701b3c9d7a", lines: 30 })),
      null,
      `action=${action} 不该进面板`,
    );
  }
  // validate 也带 workflow 参数，但 action 才是权威语义。
  assert.equal(
    deriveSubagentDispatchMeta(toolUse("Pi/subagent", { action: "validate", workflow: "./x.js", cwd: "/tmp" })),
    null,
  );
});

test("Claude Task/Agent 与带 subagent_type 的别名工具照旧识别", () => {
  assert.deepEqual(
    deriveSubagentDispatchMeta(toolUse("Task", { subagent_type: "Explore", description: "查看依赖" }, "task-1")),
    { taskId: "task-1", agentType: "Explore", taskDescription: "查看依赖" },
  );
  assert.deepEqual(
    deriveSubagentDispatchMeta(toolUse("Agent", {}, "task-2")),
    { taskId: "task-2" },
  );
  assert.deepEqual(
    deriveSubagentDispatchMeta(toolUse("custom_dispatch", { subagent_type: "worker", description: "跑" }, "task-3")),
    { taskId: "task-3", agentType: "worker", taskDescription: "跑" },
  );
  // 没有 subagent_type 的普通工具名不是派发。
  assert.equal(deriveSubagentDispatchMeta(toolUse("Bash", { command: "ls" }, "bash-1")), null);
});

test("已盖章的块原样投影，非 tool_use / 无 id 不识别", () => {
  const stamp = { taskId: "call-wf", agentType: "workflow", taskDescription: "continuation.js" };
  assert.deepEqual(
    deriveSubagentDispatchMeta({ type: "tool_use", id: "call-wf", name: "Pi/subagent", input: {}, __subagent: stamp }),
    stamp,
  );
  assert.deepEqual(
    deriveSubagentDispatchMeta({ type: "tool_result", tool_use_id: "call-wf", __subagent: stamp } as any),
    stamp,
  );
  assert.equal(deriveSubagentDispatchMeta(toolUse("Pi/subagent", { workflow: "./a/b.js" }, "")), null);
  assert.equal(deriveSubagentDispatchMeta(null), null);
});

test("workflow 标题取末段，布尔与对象形态没有名字", () => {
  assert.equal(subagentWorkflowLabel("./output/web-ui-library-migration/continuation.js"), "continuation.js");
  assert.equal(subagentWorkflowLabel("/Users/x/scripts/capture-lane.py"), "capture-lane.py");
  assert.equal(subagentWorkflowLabel("review"), "review");
  assert.equal(subagentWorkflowLabel("true"), undefined);
  assert.equal(subagentWorkflowLabel(true), undefined);
  assert.equal(subagentWorkflowLabel({ version: 1 }), undefined);
  assert.equal(subagentWorkflowLabel("   "), undefined);
});
