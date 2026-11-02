# 系统提示词

系统提示词决定每次执行会话的默认身份、规则与可用背景知识。它由多层拼接而成：Wand 在统一执行边界注入知识来源，并尽量走各 provider 的原生系统提示通道；没有原生通道的 provider 用既有显式上下文兜底（`composeSystemFallback`，`src/structured-provider-common.ts`）。

## 组成

| 层 | 来源 | 注入位置 | 说明 |
| --- | --- | --- | --- |
| 基础提示 | `CORE_BASE_SYSTEM_PROMPT`（`src/core-runner.ts`） | core 会话前置 | Wand 自有、固定，描述工作方式与交流约定；不追加到外部 CLI 的默认提示词后面 |
| 会话级 `systemPrompt` | 用户自定义，或会话绑定的员工人设 `employee.prompt` | 创建会话时写入 `SessionSnapshot.systemPrompt` | 私聊/群聊负责人会话用 `employee.prompt` 作为人设；PTY 拼在启动命令上，结构化执行经 provider adapter 映射 |
| 运行时 `runtimeSystemPrompt` | 知识库 + 任务回填 + 会话标识 | 运行时由 `src/employee-knowledge.ts` 在统一边界注入 | 每轮拼接，不持久化、不进 DTO |
| 系统 AI 人设 | `systemEmployee.prompt` | Wand 自有 AI 调用（`opsPersona`） | 仅用于标题生成、任务回填等系统运维调用，见 `src/session-ai-context.ts` |

`buildCoreSystemPrompt`（`src/core-runner.ts`）把基础提示与会话级提示拼起来；`systemPromptArgs` 与各 provider adapter（Claude `developerInstructions`、Codex、Qoder、OpenCode、Pi）再把 `systemPrompt` 与 `runtimeSystemPrompt` 合并后落到原生通道。约定、角色与规则走 `systemPrompt`，由 provider adapter 映射，无原生通道时显式兜底，不污染用户消息。

## 运行时系统提示词应用的知识来源

`knowledgeContext`（`src/employee-knowledge.ts`）在每个结构化执行边界读取并拼接：

1. **全局知识库全文**：`globalKnowledgeContext` 输出完整全局库（标题/目录/正文），每轮全量注入，受 24 KB 预算约束（`GLOBAL_KNOWLEDGE_MAX_BYTES`）。
2. **个人 / 项目知识库目录索引**：只注入 `id / title / folder / revision`（约 4 KB 预算），**不预注入正文**，避免每轮无差别膨胀数千字符；正文按需由 `knowledge:read` 读取。
3. **知识库操作约定**：`knowledgeInstructions` 给出「记到哪个范围、不靠关键词扫描写入」的路由说明。
4. **当前会话标识**：`当前 Wand 会话 ID：<id>` 作为精确续接目标。
5. **任务回填指令**（仅任务工作流）：`startTaskWorkflowRunner` 追加任务回填范围与命令。
6. **外部群限制**：钉钉等外部群只接收共享约定（全局库），不接收个人/项目库与写入令牌。

> 说明：项目/仓库知识库（项目范围）目前注入的是**目录索引**，正文按需求读取，这是为有界提示词预算做的取舍，不是缺陷。全局库可完整加载，个人/项目正文作为按需参考资料。

## 在知识库模块查看

侧边栏第 2 个按钮「知识库」可查看并管理上述来源（桌面常驻目录与正文，移动端在目录与文档间返回）：

- **全局**：此处文档每轮全文注入所有对话；说明完整加载容量与原生终端刷新时机，CLI 同步失败在本页显示。
- **项目**：选择仓库/工作区后列出的文档即「该仓库的知识库」。其目录索引注入绑定该仓库的会话，正文按需读取。项目库按稳定项目 ID 归属。
- **个人**：选择员工后，其个人知识库独立列出；该员工的**角色设定（人设，`employee.prompt`）**即应用于与其私聊/群聊负责人会话的系统提示词。员工描述属于该员工，不与其他员工共享。

各范围共用「目录 + 正文」的阅读与编辑结构；保存成功才确认，网络失败与版本冲突保留输入，迟到响应不得串到另一员工或项目。详见 [全局知识库](global-knowledge.md) 与 [Repo Wiki 接入知识库的可行性与成本](repo-wiki-feasibility.md)。
