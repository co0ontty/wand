# Worker 通知节点集成 (im-lifecycle)

Status: succeeded
Model: openai-codex/gpt-5.6-luna
Routing: policy=task_first; selected via metadata; thinking=high; captain remains final judge; metadata: openai-codex/gpt-5.3-codex-spark (warning: probe error: probe produced no output) | fallback: openai-codex/gpt-5.5 (warning: not probed (lazy fallback)) | fallback: openai-codex/gpt-5.6-luna (warning: not probed (lazy fallback))
Fallback models: openai-codex/gpt-5.5, openai-codex/gpt-5.6-luna
Tools: bash, edit, read, write
Requests: 22
Tokens: 2043915

## Output

## result_summary

已新增 `src/employee-im-lifecycle.ts`，实现统一员工 IM 生命周期投影：

- 基于权威 session 快照与 `completionRevision`。
- 支持开始、完成、失败、停止、权限等待、队列入队、候选切换、团队步骤完成。
- session/事件边沿去重，隔离不同员工与会话。
- recovery 首次事件建立基线，不补发历史通知。
- 通知只传 `{ sessionId, title }`，不包含 prompt、路径、工具参数或错误正文。
- 通知失败不会影响会话执行。

未修改 `src/server.ts`，未新增测试文件；`EmployeeImService` 与路由实现尚未出现在当前工作区。

## evidence_refs

- `src/employee-im-lifecycle.ts:45-128`：生命周期投影、状态边沿与去重。
- `src/employee-im-lifecycle.ts:151-163`：团队步骤完成状态检测。
- `src/employee-im-lifecycle.ts:165-175`：统一 `im.notify(employeeId,event,{sessionId,title})` 调用及失败隔离。
- `src/types.ts:21-30`：当前 `ProcessEvent` 事件契约。
- `src/session-completion.ts:15-61`：完成事实与 `completionRevision` 来源。
- `src/structured-session-manager.ts:1490-1518`：真实 structured turn 开始状态。
- `src/storage/ai-teams-repository.ts:225-240`：团队步骤权威存储入口。
- `npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck src/employee-im-lifecycle.ts`：通过。

## confidence

中等。生命周期文件本身类型检查通过；server 接线、Service API 兼容性及完整测试尚未验证。

## disagreements

- 当前 `ProcessEvent` 没有独立的 `waiting_input`、`step_completed`、`candidate_switched` 事件。
- `waiting_input` 仅接受显式 `waitingInput`/`awaitingInput` 字段，未根据文本关键词推断。
- 团队步骤完成依赖 captain 在 `aiTeams.ingest` 后注入 `getSteps`。

## next_questions

- `EmployeeImService` 的实际文件名与 `notify` 方法签名是否确定？
- captain 是否补充 `server.ts` 接线及 `tests/employee-im-lifecycle.test.ts`？
- `waiting_input` 是否需要由 structured runner 增加权威快照字段？

```json
{
  "result_summary": "新增 src/employee-im-lifecycle.ts，实现基于权威 session 快照和 completionRevision 的员工 IM 生命周期投影、状态边沿去重、员工/会话隔离及 recovery 基线处理；未接 server 和测试。",
  "evidence_refs": [
    "src/employee-im-lifecycle.ts:45-128",
    "src/employee-im-lifecycle.ts:151-175",
    "src/session-completion.ts:15-61",
    "src/types.ts:21-30",
    "npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck src/employee-im-lifecycle.ts"
  ],
  "confidence": "中等",
  "disagreements": [
    "当前 ProcessEvent 缺少 waiting_input、step_completed、candidate_switched 独立事件。",
    "waiting_input 不能安全从文本或普通 status 推断。"
  ],
  "next_questions": [
    "确认 EmployeeImService 文件名和 notify 签名。",
    "由 captain 完成 server.ts 接线和 lifecycle 测试。",
    "确认是否补充 waiting_input 权威快照字段。"
  ]
}
```
