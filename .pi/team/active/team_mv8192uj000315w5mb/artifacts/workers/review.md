# Worker 移除边界独立审查 (review)

Status: succeeded
Model: openai-codex/gpt-5.5
Routing: policy=strict; selected via user; thinking=high; captain remains final judge; user: openai-codex/gpt-5.5
Tools: bash, edit, read, write
Requests: 19
Tokens: 655401

## Output

RADIO: status=final, action=提交只读阻断审查结论, evidence=src/server.ts:215-219,744-806; src/config.ts:200-234,324-332,563-570,832; tests/config-preferences.test.ts:219-229, blocker=none, next=captain合并判断

## result_summary

发现 2 个有证据的阻断级问题：

1. **PTY `/api/commands` 会把显式未知 provider 丢弃并回落/推断为 Claude 等其他工具**。这会让手动指定 `provider:"gemini"` 的请求在某些组合下启动 Claude 或以 Claude 身份启动自定义命令。
2. **旧 `defaultProvider:"gemini"` 配置/DB 偏好会被运行时静默当作 Claude 默认值使用**，并且启动时会用 Claude 初始化内置员工/默认伙伴；这不满足“旧配置不静默 Claude 执行”的边界。

## evidence_refs

- `src/server.ts:215-219`：`resolveProviderForCommand()` 对无效 provider 不报错，直接 `inferProviderFromCommand(command) ?? "claude"`。
- `src/server.ts:744-806`：`/api/commands` 未先拒绝显式无效 `body.provider`；非 admin 校验与实际 start 都会在 provider 无效时改用命令推断/Claude fallback。
- 复现思路：
  - `POST /api/commands` body `{ "provider":"gemini", "command":"claude" }`：`body.provider` 被忽略，推断为 `claude` 并启动 Claude。
  - admin body `{ "provider":"gemini", "command":"gemini" }`：无效 provider fallback 为 `claude`，但 command 仍是 `gemini`，存在身份/命令错配。
- 最小修复建议：在 `/api/commands` 中只要 `body.provider !== undefined` 且非空、`!isSessionProvider(body.provider)` 就 400；fallback 仅允许 provider 字段缺省时发生。必要时同时拒绝显式 provider 与 command 推断不一致。

- `src/config.ts:200-234`：`loadConfigWithStorage()` 会迁移旧 JSON 偏好、合并默认、应用 DB 偏好、然后 bootstrap 内置员工。
- `src/config.ts:324-332`：`migrateLegacyPreferencesToDb()` 会把旧 JSON 中的 `defaultProvider:"gemini"` 原样写入 `pref:defaultProvider`。
- `src/config.ts:563-570`：`applyStoragePreferences()` 对 DB 中无效 provider 的 `spec.read()` 返回 null 后保持当前 config 默认值。
- `src/config.ts:832`：`mergeWithDefaults()` 对无效 `input.defaultProvider` 回落 `"claude"`。
- `src/config.ts:245-258`：bootstrap 会用 `config.defaultProvider` 初始化系统/默认员工；因此旧 Gemini 默认会变成 Claude 候选。
- `tests/config-preferences.test.ts:219-229`：现有测试明确覆盖“legacy gemini defaultProvider 被忽略且不删除数据”，但没有防止运行时回落 Claude；这与本轮边界存在冲突。
- 复现思路：旧 `config.json` 含 `{ "defaultProvider":"gemini" }` 且 DB 无 `pref:defaultProvider`，调用 `loadConfigWithStorage()` 后 runtime `config.defaultProvider === "claude"`，随后内置员工按 Claude 初始化。
- 最小修复建议：迁移/读取偏好时若发现 `pref:defaultProvider` 是已移除 provider，保留原始 DB 值但 runtime 标记为不可用/要求用户重新选择；至少不要用 Claude 自动 seed 或作为新会话默认。也可在 load 阶段抛出可操作错误，阻止静默启动默认 Claude。

## disagreements

- 现有 `tests/config-preferences.test.ts` 把“忽略 legacy removed provider”作为期望；我认为这与任务要求的“不静默 Claude 执行”冲突，应调整测试语义为“保留身份但禁用/提示重选”，而不是默认 Claude。

## next_questions

- 旧 Gemini 默认配置的产品期望是“服务启动失败并提示迁移”，还是“服务可启动但新建会话禁用直到用户重选 provider”？需要 captain/产品确认。
- admin `/api/commands` 是否允许自定义命令同时带 provider？若允许，是否必须强校验 command 与 provider 一致，避免身份/命令错配？

```json
{
  "result_summary": "发现2个阻断级问题：/api/commands 对显式未知 provider 会丢弃并回落/推断成 Claude 等其他工具；旧 defaultProvider:\"gemini\" 配置/DB 偏好运行时会静默变成 Claude 并用于内置员工初始化。",
  "evidence_refs": [
    "src/server.ts:215-219 resolveProviderForCommand 无效 provider fallback 到命令推断或 claude",
    "src/server.ts:744-806 /api/commands 未拒绝显式无效 body.provider，随后 processes.start 使用 fallback provider",
    "src/config.ts:200-234 loadConfigWithStorage 迁移偏好、合并默认、应用 DB 并 bootstrap",
    "src/config.ts:324-332 migrateLegacyPreferencesToDb 原样保存旧 defaultProvider",
    "src/config.ts:563-570 applyStoragePreferences 对无效 DB 偏好保持当前默认",
    "src/config.ts:832 mergeWithDefaults 无效 defaultProvider 回落 claude",
    "src/config.ts:245-258 bootstrapBuiltinEmployees 用 runtime defaultProvider 初始化内置员工",
    "tests/config-preferences.test.ts:219-229 现有测试确认 legacy gemini 偏好被忽略但数据保留"
  ],
  "confidence": "高：结论基于目标源码直接控制流；未执行测试但复现路径清晰。",
  "disagreements": [
    "现有测试期望忽略 legacy removed provider；这与本轮“不静默 Claude 执行”边界冲突。"
  ],
  "next_questions": [
    "旧 Gemini 默认配置应阻止服务启动，还是允许启动但禁用新会话默认并提示用户重选？",
    "admin /api/commands 带 provider 的自定义命令是否必须校验 command/provider 一致？"
  ]
}
```
