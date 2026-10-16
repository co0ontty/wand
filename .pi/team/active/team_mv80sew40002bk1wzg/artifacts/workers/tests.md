# Worker 完成主仓回归调整 (tests)

Status: succeeded
Model: OpenAI/gpt-6.1-sol
Routing: policy=strict; selected via user; thinking=high; captain remains final judge; user: OpenAI/gpt-6.1-sol
Tools: bash, edit, read, write
Requests: 22
Tokens: 1214587

## Output

## result_summary

已完成本批主仓 `tests/` 实际修改，未修改 `src/` 或原生目录：

- 删除 Gemini 专属 `tests/gemini-structured.test.ts`。
- 替换配置、会话、设置页中的 Gemini 正向覆盖与模型示例，保留其他 provider 覆盖。
- 新增 Gemini PTY 新建/恢复明确拒绝、零 spawn、历史不改写回归；新增 structured 创建/切换拒绝且不新增、不修改会话回归。
- 会话 AI 上下文增加历史 provider、structuredState、runner、command 不得静默映射 Claude 的断言。
- 员工草稿保留合法但不允许 provider 的降级覆盖，Gemini 严格输入改为 `DRAFT_INVALID_PROVIDER`，断言零模型调用。
- 保留 `core-harness` 的 SDK 凭据隔离测试。

第二次扫描确认：`tests/` 剩余 Gemini 引用均属于移除断言、非法输入回归或 SDK 凭据隔离；两个共享 native fixture 已被并行角色替换，无 Gemini。

## evidence_refs

定点运行：

```bash
node --test --import tsx \
  tests/config-preferences.test.ts tests/session-ai-context.test.ts \
  tests/process-manager-safety.test.ts tests/session-provider-switch.test.ts \
  tests/web-ui-provider-logo.test.ts tests/server-session-routes-contract.test.ts \
  tests/settings-repository.test.ts tests/silicon-employee.test.ts
```

结果 **107 条：104 通过，3 失败**。失败全部来自新增安全边界：

- `tests/process-manager-safety.test.ts:228`：Gemini PTY 新建未拒绝。
- `tests/process-manager-safety.test.ts:240`：Gemini PTY 恢复未拒绝。
- `tests/session-ai-context.test.ts:72`：移除 provider 元数据未拒绝，仍可静默解析 Claude。

完整输出：`/tmp/wand-gemini-tests-worker.log`。这些断言已保留，供 server 角色补实现。

另改：`tests/antd-settings-browser.test.ts`、`tests/settings-config.test.ts` 的模拟列表和模型示例。它们未在本次定点命令运行。

`git diff --check -- tests` 发现上轮 `employee-text.test.ts` 文件末尾多余空行，已修正；修正后未重跑该命令。

## confidence

中高：修改已落盘并完成第二次引用扫描；定点测试明确验证多数行为，同时暴露三处服务端缺口。实际模型 `OpenAI/gpt-6.1-sol`；使用工具 `bash`、`read`、`edit`。

## disagreements

无。未将失败断言改为允许静默降级。共享 fixture 精确替换因并行修改未命中，检查后确认已无 Gemini，未覆盖对方改动。

## next_questions

- server 角色需完成 PTY 新建/恢复与 `resolveSessionProvider()` 的 unsupported 拒绝边界，再重跑上述测试。
- 尚未增加独立的 structured 历史恢复零 adapter spawn 测试，也未增加 HTTP 新建 Gemini 专属拒绝用例；当前覆盖 structured manager 创建/切换及 HTTP 切换拒绝。
- 尚未运行 settings-config、settings browser、fixture mirror、全量 check/test/build；按 captain 统跑安排处理。收到预算立即收尾要求后停止扩展。

```json
{
  "result_summary": "已实际完成本批tests清理与回归：删除Gemini专属测试，替换混合测试与设置示例，新增PTY新建/恢复明确拒绝零spawn、structured创建/切换拒绝不变更、会话AI上下文不静默Claude断言。第二次rg剩余均为拒绝/移除断言或SDK凭据隔离。定点107条测试104通过、3失败，失败暴露server尚未实现的PTY及
