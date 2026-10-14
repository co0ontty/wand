# Worker 错误与恢复语义审查 (lifecycle-review)

Status: succeeded
Model: openai-codex/gpt-5.5
Routing: policy=task_first; selected via metadata; thinking=high; captain remains final judge; metadata: openai-codex/gpt-5.3-codex-spark (warning: probe error: probe produced no output) | fallback: openai-codex/gpt-5.5 (warning: not probed (lazy fallback)) | fallback: openai-codex/gpt-5.6-luna (warning: not probed (lazy fallback))
Fallback models: openai-codex/gpt-5.5, openai-codex/gpt-5.6-luna
Tools: bash, read, write
Requests: 19
Tokens: 913324

## Output

## result_summary

未发现证据明确的阻断性 bug 或已可复现的错误/恢复语义回归。  
本轮实现对 pump 完成竞态、source writer/恢复接入、协议错误 unknown/no retry 的主路径语义基本闭合；我只指出一个非阻断的缺失回归覆盖。

## evidence_refs

- `src/structured-exec-pump.ts:120-137`：完成路径先 `stdoutFile.drain()` 再 `protocolReader.finish()`；协议错误被标记为 `delivery: "unknown"`、`retryable: false`、`retryForbidden: true`，且不把 `inputAccepted` 写成 false。
- `src/structured-exec-pump.ts:166-169`：stdout 解析异常先 `finish(...)` 再 interrupt，覆盖同步 close 竞态。
- `src/structured-pi-adapter.ts:297-323`：PiRunner 接入 `PiProtocolReader`，解析失败不当作安全拒绝；有进度时保留 `inputAccepted: true`。
- `src/pi-native-event-bridge.ts:32-40`：native bridge 对 `message_update`/其他事件先投影再写入文件。
- `src/structured-session-manager.ts:687-738,823-833`：恢复路径也接入 `PiProtocolReader`，退出时调用 `finishProtocol()`。
- `tests/pi-protocol-reader.test.ts:106-145`：覆盖实际 pump/file 路径的大冗余 summary、最终错误保留、畸形/超大真实 payload unknown/no retry。
- 已运行：`node --test --import tsx tests/pi-protocol-reader.test.ts`，11/11 通过。

## 缺失回归

- 严重性：P2 / 非阻断。
- 现象：恢复路径虽然代码接入了 `PiProtocolReader`（`src/structured-session-manager.ts:687-738,823-833`），但现有新增测试主要覆盖新启动的 PiRunner/file pump 路径；`tests/pi-output-file.test.ts` 有恢复文件流测试，但未覆盖“恢复 replay 中含 >8MiB context/agent_end 汇总”以及“恢复中协议错误应 unknown/no retry 且不重试”的语义。
- 复现建议：构造 `StructuredRunState.stdoutLog` 含大 `turn_end.context` 或 malformed retained payload，调用 `recoverDetachedRuns()` 验证最终状态/错误语义。

## confidence

中高。已读目标文件和恢复/pump 关键路径，并跑定点测试；未运行全量、未调用真实模型、未重启服务。

## disagreements

无。

## next_questions

- 是否需要补一个专门的 detached recovery 大事件/协议错误单测，锁住恢复路径语义？

```json
{
  "result_summary": "未发现证据明确的阻断性 bug 或错误/恢复语义回归；仅发现恢复路径缺少专门覆盖大事件与协议错误 unknown/no-retry 的非阻断回归测试。",
  "evidence_refs": [
    "src/structured-exec-pump.ts:120-137",
    "src/structured-exec-pump.ts:166-169",
    "src/structured-pi-adapter.ts:297-323",
    "src/pi-native-event-bridge.ts:32-40",
    "src/structured-session-manager.ts:687-738",
    "src/structured-session-manager.ts:823-833",
    "tests/pi-protocol-reader.test.ts:106-145",
    "command: node --test --import tsx tests/pi-protocol-reader.test.ts -> 11/11 passed"
  ],
  "confidence": "中高",
  "disagreements": [],
  "next_questions": [
    "是否补一个 detached recovery 路径的大 Pi 事件和协议错误回归测试？"
  ]
}
```
